import { describe, expect, it, vi } from "vitest";
import {
  HISTORY_CHAR_BUDGET,
  HISTORY_MESSAGE_LIMIT,
  MAX_ASSISTANT_CHARS,
  MAX_MEMORY_CHARS,
  RETRIEVAL_MATCH_COUNT,
} from "@/lib/limits";
import { MAX_SAFE_URL_CHARS } from "@/lib/safe-url";
import { ConfigError } from "@/lib/supabase-config";
import { buildContextWindow } from "@/server/assistant/context";
import { buildPromptMessages } from "@/server/assistant/prompt";
import { prepareChatTurn, streamChatTurn, type AssistantDeps } from "@/server/assistant/service";
import {
  budgetRefusal,
  CONNECTOR_RESULT_MAX_BYTES,
  MAX_NEBIUS_HOLD_MICRO_USD,
  nebiusHoldMicroUsd,
  nebiusSettleMicroUsd,
  NebiusHoldTooLargeError,
  nextHopFits,
  SEARCH_BUDGET_MESSAGE,
  SEARCH_RESULTS_MAX_BYTES,
  WORKFLOW_RESULT_MAX_BYTES,
} from "@/server/assistant/spend";
import { buildRoutingConfig, SUPER as SUPER_MODEL, ULTRA } from "@/server/assistant/tiers";
import { ALL_TOOLS, MAX_TOOL_HOPS, TOOLS_MAX_BYTES, type ToolCall } from "@/server/assistant/tools";
import type { ChatMessage } from "@/server/providers/nebius/client";
import { toNdjsonStream } from "@/server/http/ndjson";
import { ProviderError } from "@/server/providers/errors";
import { streamChatCompletion } from "@/server/providers/nebius/client";
import { costMicroUsd, priceForModel } from "@/server/providers/nebius/pricing";
import { searchWeb } from "@/server/providers/tavily/client";
import type { ChatRequest, ChatStreamEvent } from "@/types/api";
import { FakeQuota, FakeSpend, MemoryRepository, fakeDeps } from "../support/fakes";
import { collect, deltaChunk, sseEvent, streamFrom } from "../support/streams";

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SUPER = "nvidia/nemotron-3-super-120b-a12b";

async function runTurn(deps: AssistantDeps, request: ChatRequest, signal = new AbortController().signal) {
  const prepared = await prepareChatTurn(deps, { userId: ALICE, requestId: "req-1", request });
  if (!prepared.ok) return { prepared, events: [] as ChatStreamEvent[] };
  const events = await collect(streamChatTurn(deps, prepared.turn, signal));
  return { prepared, events };
}

const send = (webSearch = false): ChatRequest => ({ action: "send", message: "hi", webSearch });

describe("spend math", () => {
  it("holds the worst case: every input byte as a token plus the full output limit", () => {
    const messages = [{ role: "user" as const, content: "x".repeat(1000) }];
    // (1000 bytes + 16 + 64) * 300 nano + 1024 * 900 nano = 324,000 + 921,600 nano = 1,245.6 micro.
    expect(nebiusHoldMicroUsd(SUPER, messages, 1024)).toBe(1246);
  });

  it("refuses to price a model that is not in the table", () => {
    const messages = [{ role: "user" as const, content: "hi" }];
    expect(() => nebiusHoldMicroUsd("moonshotai/Kimi-K3", messages, 1024)).toThrow(ConfigError);
  });

  it("refuses a hold one micro-dollar above the ceiling and allows a hold exactly at it", () => {
    // Ultra costs 1 micro-dollar per input token: 249,920 bytes + 16 + 64 = 250,000 tokens.
    const at = [{ role: "user" as const, content: "x".repeat(249_920) }];
    const over = [{ role: "user" as const, content: "x".repeat(249_921) }];
    expect(nebiusHoldMicroUsd(ULTRA, at, 0)).toBe(MAX_NEBIUS_HOLD_MICRO_USD);
    expect(() => nebiusHoldMicroUsd(ULTRA, over, 0)).toThrow(NebiusHoldTooLargeError);
  });

  it("settles the real cost with usage, and the full hold without it", () => {
    expect(nebiusSettleMicroUsd(SUPER, 5000, { promptTokens: 37, completionTokens: 45 })).toBe(52);
    expect(nebiusSettleMicroUsd(SUPER, 5000, null)).toBe(5000);
    // Never more than the hold.
    expect(nebiusSettleMicroUsd(SUPER, 10, { promptTokens: 1_000_000, completionTokens: 0 })).toBe(10);
  });

  it("keeps the full hold for invalid usage, never a refund to zero", () => {
    expect(nebiusSettleMicroUsd(SUPER, 5000, { promptTokens: -1_000_000, completionTokens: -1_000_000 })).toBe(5000);
    expect(nebiusSettleMicroUsd(SUPER, 5000, { promptTokens: 1.5, completionTokens: 2 })).toBe(5000);
    expect(nebiusSettleMicroUsd(SUPER, 5000, { promptTokens: Number.NaN, completionTokens: 2 })).toBe(5000);
  });

  it("maps each cap to a clear public error", () => {
    const now = new Date(Date.UTC(2026, 9, 14, 12, 30, 0));
    expect(budgetRefusal("day", now)).toEqual({
      status: 429,
      code: "budget_exhausted",
      message: "P-Dot has reached its daily usage limit. Try again tomorrow.",
      headers: { "Retry-After": String(11.5 * 3600) },
    });
    expect(budgetRefusal("user", now)).toMatchObject({
      status: 429,
      message: "You have reached your daily usage limit. Try again tomorrow.",
    });
    expect(budgetRefusal("period", now)).toEqual({
      status: 503,
      code: "budget_exhausted",
      message: "P-Dot has reached its total usage limit. Try again later.",
    });
  });
});

function ultraRouting(maxOutputTokens: number) {
  return buildRoutingConfig({
    chains: { fast: [ULTRA], standard: [ULTRA], heavy: [ULTRA], vision: [ULTRA] },
    maxOutputTokens,
    standardMaxOutputTokens: maxOutputTokens,
    heavyMaxOutputTokens: maxOutputTokens,
    heavyThinkingBudgetTokens: 0,
    hedgeAfterMs: 0,
  });
}

async function prepareUltra(message: string, maxOutputTokens: number) {
  const spend = new FakeSpend();
  const { deps } = fakeDeps({ spend, routing: ultraRouting(maxOutputTokens) });
  const prepared = await prepareChatTurn(deps, {
    userId: ALICE,
    requestId: "req-1",
    request: { action: "send", message, webSearch: false },
  });
  return { prepared, spend };
}

describe("chat hold ceiling", () => {
  it("refuses a turn one micro-dollar over the ceiling with no reserve call, and allows one exactly at it", async () => {
    // Ultra: 1 micro-dollar per input token, 3 per output token.
    const probe = await prepareUltra("x".repeat(1000), 0);
    const inputTokens = probe.spend.reservations[0]!.held;
    const pad = (MAX_NEBIUS_HOLD_MICRO_USD - inputTokens) % 3;
    const outputTokens = (MAX_NEBIUS_HOLD_MICRO_USD - inputTokens - pad) / 3;

    const at = await prepareUltra("x".repeat(1000 + pad), outputTokens);
    expect(at.prepared.ok).toBe(true);
    expect(at.spend.reservations.map((r) => r.held)).toEqual([MAX_NEBIUS_HOLD_MICRO_USD]);

    const over = await prepareUltra("x".repeat(1001 + pad), outputTokens);
    expect(over.prepared).toMatchObject({ ok: false, status: 413, code: "payload_too_large" });
    expect(over.spend.reservations).toHaveLength(0);
  });

  it("holds at least the final prompt's cost for the largest turn with worst-case search results", async () => {
    // 40 history messages and a new message that fill the history budget with 3-byte characters.
    // The conversation keeps a stored "work" mode, which no longer changes the prompt (decision 0014).
    const repo = new MemoryRepository();
    const conversation = await repo.createConversation(ALICE, "Long", "work");
    for (let i = 0; i < HISTORY_MESSAGE_LIMIT; i += 1) {
      const role = i % 2 === 0 ? ("user" as const) : ("assistant" as const);
      await repo.insertMessage(ALICE, { conversationId: conversation.id, role, content: "中".repeat(585) });
    }
    const message = "中".repeat(HISTORY_CHAR_BUDGET - HISTORY_MESSAGE_LIMIT * 585);

    // Real Tavily adapter. Each kept URL is 2,048 bytes after normalization: raw 3-byte
    // characters (9 bytes each when encoded) or input that is already percent-encoded.
    // The first URL is 2,048 characters before normalization and 18,312 after, so it is dropped.
    const fill = (host: string, middle: string) => `https://${host}.com/${middle.repeat(225)}aaaaaaaa`;
    const items = [
      { url: `https://e9.com/${"中".repeat(2_033)}`, title: "dropped", content: "dropped" },
      ...[0, 1, 2].map((i) => ({ url: fill(`e${i}`, "中"), title: "題".repeat(200), content: "文".repeat(2_000) })),
      ...[3, 4].map((i) => ({ url: fill(`e${i}`, "%E4%B8%AD"), title: "題".repeat(200), content: "文".repeat(2_000) })),
    ];
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ results: items }), { status: 200 }));

    const spend = new FakeSpend();
    const { deps, prompts } = fakeDeps({
      repo,
      spend,
      routing: ultraRouting(8192),
      search: (query, signal) => searchWeb({ apiKey: "test-key" }, query, { signal, fetchImpl: fetchImpl as typeof fetch }),
    });
    const { events } = await runTurn(deps, { action: "send", conversationId: conversation.id, message, webSearch: true });
    expect(events.at(-1)?.type).toBe("done");

    const final = prompts[0]!;
    expect(final).toHaveLength(HISTORY_MESSAGE_LIMIT + 2);
    const sourceUrls = [...final.at(-1)!.content.matchAll(/^URL: (.*)$/gm)].map((m) => m[1]!);
    expect(sourceUrls.map((url) => url.length)).toEqual(Array(5).fill(MAX_SAFE_URL_CHARS));

    const held = spend.reservations.find((r) => r.provider === "nebius")!.held;
    expect(held).toBeGreaterThanOrEqual(nebiusHoldMicroUsd(ULTRA, final, 8192));
    expect(held).toBeLessThan(150_000);
  });
});

describe("workflow and connector result byte budgets (decision 0015)", () => {
  /** The largest history the context window keeps: 40 messages and a new one, 3-byte characters. */
  function fullHistoryPrompt(): ChatMessage[] {
    const history = Array.from({ length: HISTORY_MESSAGE_LIMIT }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: "中".repeat(585),
    }));
    history.push({ role: "user", content: "中".repeat(HISTORY_CHAR_BUDGET - HISTORY_MESSAGE_LIMIT * 585) });
    return buildPromptMessages({
      history: buildContextWindow(history, HISTORY_CHAR_BUDGET),
      webSearch: "failed",
      results: [],
      now: new Date(Date.UTC(2026, 9, 21, 12)),
      tools: ALL_TOOLS,
      toolHops: MAX_TOOL_HOPS - 1,
      timeZone: "America/Argentina/ComodRivadavia",
    });
  }

  /** What the first prompt can add on top of its own text: search results and memories, at their bounds. */
  const FIRST_PROMPT_EXTRA = SEARCH_RESULTS_MAX_BYTES + RETRIEVAL_MATCH_COUNT * (MAX_MEMORY_CHARS * 4 + 64) + 512;

  function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
    return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
  }

  /** The next hop after one workflow call and three connector calls, each result at its byte cap. */
  function afterFourResults(): ChatMessage[] {
    const messages = fullHistoryPrompt();
    const calls = [
      call("call_0", "search_flights", {
        origin: "中".repeat(80),
        destination: "中".repeat(80),
        depart_date: "2026-11-12",
        return_date: "2026-11-19",
        passengers: 9,
      }),
      call("call_1", "calendar_list_events", {
        time_min: "2026-11-12T00:00:00+00:00",
        time_max: "2026-11-19T23:59:59+00:00",
        query: "中".repeat(200),
      }),
      call("call_2", "drive_search_files", { query: "中".repeat(200), kind: "slides" }),
      call("call_3", "drive_read_file", { file_id: "a".repeat(128) }),
    ];
    messages.push({ role: "assistant", content: "中".repeat(200), tool_calls: calls });
    messages.push({ role: "tool", tool_call_id: "call_0", name: "search_flights", content: "x".repeat(WORKFLOW_RESULT_MAX_BYTES) });
    for (const id of ["call_1", "call_2", "call_3"]) {
      messages.push({ role: "tool", tool_call_id: id, name: "connector", content: "x".repeat(CONNECTOR_RESULT_MAX_BYTES) });
    }
    return messages;
  }

  it("keeps the next hop under the ceiling with one workflow and three connector results, heavy tier, Ultra at 8,192 tokens", () => {
    const heavy = [ULTRA, SUPER_MODEL];
    const messages = afterFourResults();
    // The next hop may still offer tools, so their definitions count too.
    const extra = FIRST_PROMPT_EXTRA + TOOLS_MAX_BYTES;
    const hold = nebiusHoldMicroUsd(ULTRA, messages, 8192, extra);
    expect(hold).toBeLessThanOrEqual(MAX_NEBIUS_HOLD_MICRO_USD);
    // Some room is left for what this bound does not model (a longer plan sentence before the calls).
    expect(MAX_NEBIUS_HOLD_MICRO_USD - hold).toBeGreaterThanOrEqual(4_096);
    expect(nextHopFits(heavy, messages, 8192, extra)).toBe(true);
    // Ultra is the most expensive model of the chain, so its hold is the one that must fit.
    expect(hold).toBeGreaterThan(nebiusHoldMicroUsd(SUPER_MODEL, messages, 8192, extra));
  });

  it("answers false instead of throwing when the next hop would pass the ceiling", () => {
    const messages = afterFourResults();
    const extra = FIRST_PROMPT_EXTRA + TOOLS_MAX_BYTES;
    // A second workflow result does not fit (one workflow per reply).
    expect(nextHopFits([ULTRA], messages, 8192, extra + 2 * WORKFLOW_RESULT_MAX_BYTES)).toBe(false);
    expect(nextHopFits([SUPER_MODEL, ULTRA], [{ role: "user", content: "x".repeat(249_921) }], 0, 0)).toBe(false);
    expect(nextHopFits([ULTRA], [{ role: "user", content: "x".repeat(249_920) }], 0, 0)).toBe(true);
    // A model without a price is still a configuration error.
    expect(() => nextHopFits(["moonshotai/Kimi-K3"], [{ role: "user", content: "hi" }], 64, 0)).toThrow(ConfigError);
  });
});

describe("chat flow with the spend guard", () => {
  it("holds before the call and settles the real cost after a reply", async () => {
    const spend = new FakeSpend();
    const { deps, prompts, waited } = fakeDeps({ spend });

    const { events } = await runTurn(deps, send());

    expect(events.at(-1)?.type).toBe("done");
    expect(spend.reservations).toHaveLength(1);
    const [nebius] = spend.reservations;
    // The hold covers the prompt that was really sent.
    expect(nebius!.held).toBeGreaterThanOrEqual(nebiusHoldMicroUsd(SUPER, prompts[0]!, 1024));
    // The fake reply reports 10 prompt and 2 completion tokens.
    const cost = costMicroUsd(priceForModel(SUPER)!, { promptTokens: 10, completionTokens: 2 });
    expect(nebius!.settled).toBe(cost);
    expect(waited).toHaveLength(1);
  });

  it("settles the full hold when the provider fails", async () => {
    const spend = new FakeSpend();
    const { deps } = fakeDeps({
      spend,
      reply: async function* () {
        yield { type: "text" as const, text: "part" };
        throw new ProviderError("nebius", "unavailable", 500);
      },
    });
    const { events } = await runTurn(deps, send());
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(spend.reservations[0]!.settled).toBe(spend.reservations[0]!.held);
  });

  it("settles the full hold when usage does not arrive", async () => {
    const spend = new FakeSpend();
    const { deps } = fakeDeps({
      spend,
      reply: async function* () {
        yield { type: "text" as const, text: "ok" };
        yield { type: "finish" as const, finishReason: "stop", usage: null };
      },
    });
    await runTurn(deps, send());
    expect(spend.reservations[0]!.settled).toBe(spend.reservations[0]!.held);
  });

  it("settles the full hold when the reply is cut at the character limit", async () => {
    const spend = new FakeSpend();
    const { deps } = fakeDeps({
      spend,
      reply: async function* () {
        yield { type: "text" as const, text: "x".repeat(MAX_ASSISTANT_CHARS + 10) };
        yield { type: "finish" as const, finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } };
      },
    });
    const { events } = await runTurn(deps, send());
    expect(events.at(-1)).toMatchObject({ type: "done", truncated: true });
    expect(spend.reservations[0]!.settled).toBe(spend.reservations[0]!.held);
  });

  it("settles when the client disconnects (abort signal)", async () => {
    const spend = new FakeSpend();
    const controller = new AbortController();
    const { deps } = fakeDeps({
      spend,
      reply: async function* () {
        yield { type: "text" as const, text: "partial" };
        controller.abort();
        throw new ProviderError("nebius", "aborted");
      },
    });
    await runTurn(deps, send(), controller.signal);
    expect(spend.reservations[0]!.settled).toBe(spend.reservations[0]!.held);
  });

  it("settles when the user presses Stop and the response stream is cancelled", async () => {
    const spend = new FakeSpend();
    let release: () => void = () => {};
    const { deps, waited } = fakeDeps({
      spend,
      reply: async function* () {
        yield { type: "text" as const, text: "first" };
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        yield { type: "text" as const, text: "never read" };
      },
    });
    const prepared = await prepareChatTurn(deps, { userId: ALICE, requestId: "r", request: send() });
    if (!prepared.ok) throw new Error("prepare failed");
    const reader = toNdjsonStream(streamChatTurn(deps, prepared.turn, new AbortController().signal)).getReader();
    await reader.read(); // start
    await reader.read(); // first delta
    const cancelled = reader.cancel();
    release();
    await cancelled;
    expect(spend.reservations[0]!.settled).toBe(spend.reservations[0]!.held);
    expect(waited).toHaveLength(1);
  });

  it("does not fail the reply when the settle fails", async () => {
    const spend = new FakeSpend();
    spend.settle = async () => {
      throw new Error("db down");
    };
    const { deps, logs } = fakeDeps({ spend });
    const { events } = await runTurn(deps, send());
    expect(events.at(-1)?.type).toBe("done");
    expect(logs.map((l) => l.event)).toContain("spend_settle_failed");
  });

  it.each([
    ["day", 429],
    ["user", 429],
    ["period", 503],
  ] as const)("refuses before streaming when the Nebius %s cap is reached", async (limit, status) => {
    const repo = new MemoryRepository();
    const spend = new FakeSpend();
    spend.refuse.nebius = limit;
    const { deps, prompts, searches } = fakeDeps({ repo, spend });

    const { prepared } = await runTurn(deps, send(true));

    expect(prepared).toMatchObject({ ok: false, status, code: "budget_exhausted" });
    expect(repo.conversations).toHaveLength(0);
    expect(repo.messages).toHaveLength(0);
    expect(prompts).toHaveLength(0);
    expect(searches).toHaveLength(0);
    expect(spend.reservations).toHaveLength(0);
  });

  it("checks the per-user quota first and spends no budget when it refuses", async () => {
    const spend = new FakeSpend();
    const { deps } = fakeDeps({ spend, quota: new FakeQuota(false) });
    const { prepared } = await runTurn(deps, send(true));
    expect(prepared).toMatchObject({ ok: false, code: "rate_limited" });
    expect(spend.reservations).toHaveLength(0);
  });

  it("fails closed when the budget cannot be checked", async () => {
    const repo = new MemoryRepository();
    const spend = new FakeSpend();
    spend.failReserve = true;
    const { deps, prompts } = fakeDeps({ repo, spend });
    await expect(runTurn(deps, send())).rejects.toThrow();
    expect(repo.messages).toHaveLength(0);
    expect(prompts).toHaveLength(0);
  });

  it("gives the holds back when the user message cannot be saved", async () => {
    const repo = new MemoryRepository();
    repo.failInsertForRole = "user";
    const spend = new FakeSpend();
    const { deps } = fakeDeps({ repo, spend, search: async () => [] });
    await expect(runTurn(deps, send(true))).rejects.toThrow();
    expect(spend.reservations.map((r) => [r.provider, r.settled])).toEqual([
      ["nebius", 0],
      ["tavily", 0],
    ]);
  });

  it("reserves one Tavily credit for a search, and none when search is off", async () => {
    const spend = new FakeSpend();
    const { deps } = fakeDeps({ spend, search: async () => [{ title: "T", url: "https://e.com/", excerpt: "E" }] });
    await runTurn(deps, send(true));
    expect(spend.reservations.filter((r) => r.provider === "tavily").map((r) => r.held)).toEqual([1]);
    expect(spend.counted("tavily")).toBe(1);

    const off = new FakeSpend();
    const second = fakeDeps({ spend: off });
    await runTurn(second.deps, send(false));
    expect(off.reservations.map((r) => r.provider)).toEqual(["nebius"]);
  });

  it("answers without search when only the Tavily budget is used up", async () => {
    const repo = new MemoryRepository();
    const spend = new FakeSpend();
    spend.refuse.tavily = "period";
    const { deps, searches, prompts, logs } = fakeDeps({ repo, spend, search: async () => [] });

    const { prepared, events } = await runTurn(deps, send(true));

    expect(prepared.ok).toBe(true);
    expect(searches).toHaveLength(0);
    expect(events.find((e) => e.type === "search")).toEqual({
      type: "search",
      status: "failed",
      sources: [],
      message: SEARCH_BUDGET_MESSAGE,
    });
    // The model is told that search failed, so it does not claim web grounding.
    expect(prompts[0]![0]!.content).toContain("the search failed");
    expect(prompts[0]!.at(-1)!.content).toBe("hi");
    expect(events.at(-1)).toMatchObject({ type: "done", message: { webSearch: "failed", sources: [] } });
    expect(repo.messages.at(-1)).toMatchObject({ role: "assistant", webSearch: "failed" });
    expect(logs.find((l) => l.event === "spend_limit_reached")?.fields).toMatchObject({ provider: "tavily" });
  });

  it("refuses a model without a price before any write, hold or provider call", async () => {
    const repo = new MemoryRepository();
    const spend = new FakeSpend();
    const { deps, prompts, searches } = fakeDeps({ repo, spend, model: "moonshotai/Kimi-K3", search: async () => [] });

    const error = await runTurn(deps, send(true)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).missing).toEqual(["NEBIUS_MODEL"]);
    expect(String((error as Error).message)).not.toContain("Kimi");
    expect(spend.reservations).toHaveLength(0);
    expect(repo.messages).toHaveLength(0);
    expect(prompts).toHaveLength(0);
    expect(searches).toHaveLength(0);
  });

  // Regression: negative usage from the provider used to be clamped to zero,
  // which gave back the whole hold. Now it counts as missing usage.
  it.each([
    ["negative", { prompt_tokens: -5_000, completion_tokens: -5_000 }],
    ["fractional", { prompt_tokens: 10.5, completion_tokens: 2 }],
    ["text", { prompt_tokens: "10", completion_tokens: "2" }],
    ["too large", { prompt_tokens: 2 ** 60, completion_tokens: 2 }],
  ])("keeps the full hold when the stream sends %s usage", async (_label, badUsage) => {
    const spend = new FakeSpend();
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          streamFrom([
            sseEvent(deltaChunk("Hello.")),
            sseEvent({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
            sseEvent({ choices: [], usage: badUsage }),
            sseEvent("[DONE]"),
          ]),
          { status: 200 },
        ),
    );
    const settings = { apiKey: "k", baseUrl: "https://nebius.test/v1", model: SUPER, maxOutputTokens: 1024 };
    const { deps } = fakeDeps({
      spend,
      reply: (messages, signal) => streamChatCompletion(settings, messages, { fetchImpl, signal }),
    });

    const { events } = await runTurn(deps, send());

    expect(events.at(-1)).toMatchObject({ type: "done", message: { content: "Hello." } });
    expect(spend.reservations[0]!.held).toBeGreaterThan(0);
    expect(spend.reservations[0]!.settled).toBe(spend.reservations[0]!.held);
  });
});
