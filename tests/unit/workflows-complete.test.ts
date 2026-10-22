import { describe, expect, it } from "vitest";
import { createCircuitBreaker } from "@/server/assistant/breaker";
import { completeToolCall, extractionPlan, type CompletionDeps } from "@/server/assistant/complete";
import { BudgetExhaustedError } from "@/server/assistant/executor";
import { nebiusHoldMicroUsd, NebiusHoldTooLargeError } from "@/server/assistant/spend";
import { ULTRA, type TierPlan } from "@/server/assistant/tiers";
import type { ToolDefinition } from "@/server/assistant/tools";
import { ProviderError } from "@/server/providers/errors";
import type { ChatMessage } from "@/server/providers/nebius/client";
import { FakeSpend } from "../support/fakes";
import { ScriptedProvider, textReply, toolReply, WORKFLOW_ROUTING, type ScriptedReply } from "../support/workflow-fakes";

const TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "submit_claims",
    description: "Submit",
    parameters: { type: "object", properties: { items: { type: "array", items: { type: "string" } } }, required: ["items"] },
  },
};
const MESSAGES: ChatMessage[] = [
  { role: "system", content: "Extract." },
  { role: "user", content: "pages" },
];
const PLAN = extractionPlan(WORKFLOW_ROUTING);

function deps(reply: (index: number) => ScriptedReply, spend = new FakeSpend()) {
  const provider = new ScriptedProvider((_request, index) => reply(index));
  const waited: Promise<unknown>[] = [];
  const d: CompletionDeps = {
    spend,
    provider,
    breaker: createCircuitBreaker({ threshold: 3, cooldownMs: 30_000 }),
    random: () => 0,
    log: () => {},
    waitUntil: (work) => {
      waited.push(work);
    },
  };
  return { deps: d, provider, spend, waited };
}

function run(d: CompletionDeps, plan: TierPlan = PLAN, signal = new AbortController().signal) {
  return completeToolCall(d, { requestId: "r", plan, messages: MESSAGES, tool: TOOL, signal });
}

describe("extractionPlan", () => {
  it("copies the standard tier with no hedge and 2,048 output tokens", () => {
    expect(PLAN).toEqual({ ...WORKFLOW_ROUTING.standard, hedgeAfterMs: null, maxOutputTokens: 2048 });
    expect(PLAN.models).not.toBe(WORKFLOW_ROUTING.standard.models);
    expect(PLAN.thinkingBudgetTokens).toBe(0);
  });
});

describe("completeToolCall", () => {
  it("forces the one tool, holds with the tool's bytes and settles the real cost", async () => {
    const { deps: d, provider, spend } = deps(() => toolReply("submit_claims", { items: ["a"] }));
    const result = await run(d);
    expect(result).toMatchObject({ ok: true, args: { items: ["a"] }, model: PLAN.models[0], usage: { promptTokens: 1000, completionTokens: 200 } });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toMatchObject({ tools: [TOOL], toolChoice: { type: "function", function: { name: "submit_claims" } }, maxOutputTokens: 2048 });
    const toolBytes = new TextEncoder().encode(JSON.stringify([TOOL])).length + 64;
    expect(spend.reservations).toHaveLength(1);
    expect(spend.reservations[0]!.held).toBe(nebiusHoldMicroUsd(PLAN.models[0]!, MESSAGES, 2048, toolBytes));
    expect(spend.reservations[0]!.held).toBeGreaterThan(nebiusHoldMicroUsd(PLAN.models[0]!, MESSAGES, 2048));
    // Settled with usage before it returned.
    expect(spend.reservations[0]!.settled).not.toBeNull();
    expect(spend.reservations[0]!.settled).toBeLessThan(spend.reservations[0]!.held);
  });

  it("reports a cut-off reply as truncated and keeps the full hold without usage", async () => {
    const { deps: d, spend } = deps(() => toolReply("submit_claims", '{"items":["a"', { finishReason: "length", usage: null }));
    expect(await run(d)).toMatchObject({ ok: false, reason: "truncated" });
    expect(spend.reservations[0]!.settled).toBe(spend.reservations[0]!.held);
  });

  it("reports arguments that are not JSON as invalid_json", async () => {
    const { deps: d } = deps(() => toolReply("submit_claims", "{items: [}"));
    expect(await run(d)).toMatchObject({ ok: false, reason: "invalid_json" });
  });

  it("reads a text reply as JSON, with or without a code fence or a tool-call wrapper (Ollama ignores tool_choice)", async () => {
    for (const text of [
      '{"items":["a"]}',
      '```json\n{"items":["a"]}\n```',
      'Here you go:\n{"items":["a"]}',
      '{"name":"submit_claims","arguments":{"items":["a"]}}',
      '{"name":"submit_claims","arguments":"{\\"items\\":[\\"a\\"]}"}',
    ]) {
      const { deps: d } = deps(() => textReply(text));
      expect(await run(d), text).toMatchObject({ ok: true, args: { items: ["a"] } });
    }
  });

  it("reports prose, another tool or an empty reply as no_tool_call", async () => {
    for (const reply of [textReply("I could not find any claims."), toolReply("web_search", { query: "x" })]) {
      const { deps: d } = deps(() => reply);
      expect(await run(d)).toMatchObject({ ok: false, reason: "no_tool_call" });
    }
    const empty = deps(() => [{ type: "finish", finishReason: "stop", usage: null }]);
    expect(await run(empty.deps)).toMatchObject({ ok: false, reason: "no_tool_call" });
    // Every attempt of the chain was held and settled.
    expect(empty.spend.reservations.length).toBe(PLAN.models.length);
    expect(empty.spend.reservations.every((r) => r.settled !== null)).toBe(true);
  });

  it("stops reading a runaway text reply and calls it truncated", async () => {
    const { deps: d } = deps(() => textReply("x".repeat(20_000)));
    expect(await run(d)).toMatchObject({ ok: false, reason: "truncated" });
  });

  it("retries the next model before any token, holding for each attempt", async () => {
    const { deps: d, provider, spend } = deps((index) =>
      index === 0 ? new ProviderError("nebius", "model_not_found", 404) : toolReply("submit_claims", { items: [] }),
    );
    expect(await run(d)).toMatchObject({ ok: true, model: PLAN.models[1] });
    expect(provider.requests.map((r) => r.model)).toEqual(PLAN.models);
    expect(spend.reservations).toHaveLength(2);
    expect(spend.reservations.every((r) => r.settled !== null)).toBe(true);
  });

  it("throws a budget refusal and a hold above the ceiling, sending nothing", async () => {
    const refused = new FakeSpend();
    refused.refuse.nebius = "user";
    const a = deps(() => toolReply("submit_claims", { items: [] }), refused);
    await expect(run(a.deps)).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(a.provider.requests).toHaveLength(0);

    const huge: TierPlan = { ...PLAN, models: [ULTRA], maxOutputTokens: 200_000 };
    const b = deps(() => toolReply("submit_claims", { items: [] }));
    await expect(run(b.deps, huge)).rejects.toBeInstanceOf(NebiusHoldTooLargeError);
    expect(b.provider.requests).toHaveLength(0);
    expect(b.spend.reservations).toHaveLength(0);
  });

  it("settles every hold when the user stops", async () => {
    const controller = new AbortController();
    const { deps: d, spend } = deps(() => {
      controller.abort();
      return toolReply("submit_claims", { items: [] });
    });
    await expect(run(d, PLAN, controller.signal)).rejects.toMatchObject({ kind: "aborted" });
    expect(spend.reservations.length).toBeGreaterThan(0);
    expect(spend.reservations.every((r) => r.settled !== null)).toBe(true);
  });
});
