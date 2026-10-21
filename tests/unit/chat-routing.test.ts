import { afterEach, describe, expect, it, vi } from "vitest";
import { TOOLS_MAX_BYTES } from "@/server/assistant/tools";
import type { SupabaseClient } from "@supabase/supabase-js";
import { prepareChatTurn, streamChatTurn, type AssistantDeps } from "@/server/assistant/service";
import { nebiusHoldMicroUsd } from "@/server/assistant/spend";
import { LIGHTNING, NANO, SUPER, ULTRA } from "@/server/assistant/tiers";
import { getAssistantConfig } from "@/server/config";
import { createConversationRepository } from "@/server/db/conversations";
import { ProviderError } from "@/server/providers/errors";
import { costMicroUsd, priceForModel } from "@/server/providers/nebius/pricing";
import type { ChatRequest, ChatStreamEvent } from "@/types/api";
import { FakeSpend, MemoryRepository, fakeDeps } from "../support/fakes";
import { FakeProvider, type FakeBehavior } from "../support/fake-provider";
import { collect } from "../support/streams";

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
// The production defaults: real chains, output limits, reasoning budget and hedge.
const routing = getAssistantConfig({ NEBIUS_API_KEY: "k", NODE_ENV: "test" }).routing;

function setup(scripts: Record<string, FakeBehavior[]>, spend = new FakeSpend()) {
  const repo = new MemoryRepository();
  const provider = new FakeProvider(scripts);
  const fake = fakeDeps({ repo, spend, provider, routing });
  return { ...fake, repo, provider, spend };
}

async function runTurn(deps: AssistantDeps, request: ChatRequest, signal = new AbortController().signal) {
  const prepared = await prepareChatTurn(deps, { userId: ALICE, requestId: "req-1", request });
  if (!prepared.ok) throw new Error(`prepare failed: ${prepared.code}`);
  return collect(streamChatTurn(deps, prepared.turn, signal));
}

const send = (message: string, extra: Partial<Extract<ChatRequest, { action: "send" }>> = {}): ChatRequest => ({
  action: "send",
  message,
  webSearch: false,
  ...extra,
});

const price = (model: string) => priceForModel(model)!;

afterEach(() => {
  vi.useRealTimers();
});

describe("routed chat replies", () => {
  it("answers an everyday message on the fast tier and saves the model, tier and reason", async () => {
    const { deps, repo, provider } = setup({ [LIGHTNING]: [{}] });
    const events = await runTurn(deps, send("What should I cook tonight?"));

    expect(events[0]).toMatchObject({ type: "start", route: { tier: "fast", reason: "everyday" } });
    const route = { model: LIGHTNING, tier: "fast", reason: "everyday", fallback: false };
    expect(events.at(-1)).toMatchObject({ type: "done", message: { role: "assistant", route } });
    expect(repo.messages.map((m) => m.route)).toEqual([null, route]);
    expect(provider.calls[0]!.request).toMatchObject({ model: LIGHTNING, maxOutputTokens: 1024, thinkingBudgetTokens: 0 });
  });

  it("sends 'Think harder' to Ultra with a reasoning budget", async () => {
    const { deps, repo, provider } = setup({ [ULTRA]: [{ chunks: [{ reasoning: true }, { text: "Deep answer." }] }] });
    await runTurn(deps, send("hi", { effort: "deep" }));
    expect(provider.calls[0]!.request).toMatchObject({ model: ULTRA, maxOutputTokens: 4096, thinkingBudgetTokens: 1024 });
    expect(repo.messages.at(-1)!.route).toEqual({ model: ULTRA, tier: "heavy", reason: "user_deep", fallback: false });
  });

  it("uses the same effort on retry", async () => {
    const { deps, repo, provider } = setup({ [LIGHTNING]: [{ status: 400 }], [ULTRA]: [{}] });
    await runTurn(deps, send("hi"));
    const conversationId = repo.conversations[0]!.id;
    await runTurn(deps, { action: "retry", conversationId, webSearch: false, effort: "deep" });
    expect(provider.calls.map((c) => c.model)).toEqual([LIGHTNING, ULTRA]);
  });

  it("saves 'fallback' when the next model answered, and settles every hold", async () => {
    const { deps, repo, spend, provider } = setup({ [LIGHTNING]: [{ status: 404 }], [NANO]: [{}] });
    const events = await runTurn(deps, send("hi there"));

    expect(events.at(-1)).toMatchObject({ type: "done", message: { route: { model: NANO, fallback: true } } });
    expect(repo.messages.at(-1)!.route).toMatchObject({ model: NANO, tier: "fast", fallback: true });
    const [first, second] = spend.reservations;
    // The first hold is made before streaming, for the most expensive model in the chain (Super).
    const sent = provider.calls.map((c) => c.request.messages);
    expect(first!.held).toBeGreaterThan(nebiusHoldMicroUsd(LIGHTNING, sent[0]!, 1024));
    // The failed attempt had no usage, so its full hold stays counted.
    expect(first!.settled).toBe(first!.held);
    // The second hold is for Nano and the real prompt; it settles the real cost.
    // The tools offered in the call count toward its worst case.
    expect(second!.held).toBe(nebiusHoldMicroUsd(NANO, sent[1]!, 1024, TOOLS_MAX_BYTES));
    expect(second!.settled).toBe(costMicroUsd(price(NANO), { promptTokens: 10, completionTokens: 5 }));
  });

  it("stops with budget_exhausted when the budget refuses a fallback, and saves nothing", async () => {
    const spend = new FakeSpend();
    const { deps, repo, provider } = setup({ [LIGHTNING]: [{ status: 503 }], [NANO]: [{}] }, spend);
    const stream = provider.stream.bind(provider);
    provider.stream = (request, signal) => {
      // The cap is reached after the first hold.
      spend.refuse.nebius = "day";
      return stream(request, signal);
    };

    const events = await runTurn(deps, send("hi"));

    expect(events.at(-1)).toEqual({
      type: "error",
      code: "budget_exhausted",
      message: "P-Dot has reached its daily usage limit. Try again tomorrow.",
      retryable: false,
    });
    expect(provider.calls).toHaveLength(1);
    expect(repo.messages.map((m) => m.role)).toEqual(["user"]);
    expect(spend.reservations).toHaveLength(1);
    expect(spend.reservations[0]!.settled).toBe(spend.reservations[0]!.held);
  });

  it("settles the hedge loser with its full hold and the winner with its real cost", async () => {
    vi.useFakeTimers({ now: 0 });
    const { deps, spend, provider } = setup({ [LIGHTNING]: [{ delayMs: 4_000 }], [NANO]: [{ delayMs: 50 }] });
    const pending = runTurn(deps, send("hi"));
    await vi.advanceTimersByTimeAsync(10_000);
    const events = await pending;

    expect(events.at(-1)).toMatchObject({ type: "done", message: { route: { model: NANO, fallback: true } } });
    expect(provider.callsTo(LIGHTNING)[0]!.aborted).toBe(true);
    const [loser, winner] = spend.reservations;
    expect(loser!.settled).toBe(loser!.held);
    expect(loser!.settled).toBeGreaterThan(0);
    expect(winner!.settled).toBe(costMicroUsd(price(NANO), { promptTokens: 10, completionTokens: 5 }));
  });

  it("gives the first hold back when the user stops before any model call", async () => {
    const controller = new AbortController();
    const repo = new MemoryRepository();
    const spend = new FakeSpend();
    const provider = new FakeProvider({});
    const { deps } = fakeDeps({
      repo,
      spend,
      provider,
      routing,
      search: async () => {
        controller.abort();
        throw new ProviderError("tavily", "aborted");
      },
    });
    const events = await runTurn(deps, send("latest news", { webSearch: true }), controller.signal);

    expect(events.map((e) => e.type)).toEqual(["start"]);
    expect(provider.calls).toHaveLength(0);
    const nebius = spend.reservations.filter((r) => r.provider === "nebius");
    expect(nebius.map((r) => r.settled)).toEqual([0]);
  });

  it("logs routing metadata without message text", async () => {
    const { deps, logs } = setup({ [SUPER]: [{}] });
    await runTurn(deps, send("Compare my two secret job offers and plan the next step by step"));
    const route = logs.find((l) => l.event === "model_route")!;
    expect(route.fields).toMatchObject({
      tier: "heavy",
      reason: "multi_step",
      attempts: 2,
      modelsTried: `${ULTRA}>${SUPER}`,
      model: SUPER,
      fallback: true,
      hedgeFired: false,
      outcome: "ok",
    });
    expect(JSON.stringify(logs)).not.toContain("secret");
  });

  it("returns an error event, not a reply, when every model fails", async () => {
    const { deps, repo } = setup({ [SUPER]: [{ status: 503 }], [LIGHTNING]: [{ status: 503 }] });
    const events: ChatStreamEvent[] = await runTurn(deps, send("Compare cats and dogs."));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "provider_unavailable" });
    expect(repo.messages.map((m) => m.role)).toEqual(["user"]);
  });
});

describe("message rows from the database", () => {
  /** A Supabase client stub that returns the given rows for any message query. */
  function clientReturning(rows: unknown[]): SupabaseClient {
    const query = {
      select: () => query,
      eq: () => query,
      order: () => query,
      limit: async () => ({ data: rows, error: null }),
    };
    return { from: () => query } as unknown as SupabaseClient;
  }

  const base = { content: "x", web_search: "off", sources: [], created_at: "2026-10-19T12:00:00Z" };

  it("reads routes from real row shapes, including NULLs from old rows", async () => {
    const rows = [
      // Newest first, as the query returns them.
      { ...base, id: "5", role: "assistant", model: SUPER, model_tier: "warp", route_reason: "everyday", model_fallback: false },
      { ...base, id: "4", role: "assistant", model: NANO, model_tier: "fast", route_reason: "everyday", model_fallback: true },
      { ...base, id: "3", role: "assistant", model: SUPER, model_tier: "standard", route_reason: "analysis", model_fallback: null },
      // Saved before routing: the new columns are NULL.
      { ...base, id: "2", role: "assistant", model: null, model_tier: null, route_reason: null, model_fallback: null },
      { ...base, id: "1", role: "user", model: null, model_tier: null, route_reason: null, model_fallback: null },
    ];
    const repo = createConversationRepository(clientReturning(rows));
    const messages = await repo.listRecentMessages(ALICE, "c", 10);
    expect(messages.map((m) => [m.id, m.route])).toEqual([
      ["1", null],
      ["2", null],
      ["3", { model: SUPER, tier: "standard", reason: "analysis", fallback: false }],
      ["4", { model: NANO, tier: "fast", reason: "everyday", fallback: true }],
      // An unknown tier is not shown.
      ["5", null],
    ]);
  });
});
