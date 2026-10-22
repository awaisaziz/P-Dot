import { describe, expect, it, vi } from "vitest";
import { createCircuitBreaker } from "@/server/assistant/breaker";
import { toPublicCompletionError } from "@/server/assistant/errors";
import { executeRouted, newRouteReport, type AttemptBudget } from "@/server/assistant/executor";
import type { TierPlan } from "@/server/assistant/tiers";
import { ProviderError } from "@/server/providers/errors";
import { createNebiusProvider } from "@/server/providers/model";
import { deltaChunk, finishChunk, sseEvent, streamFrom } from "../support/streams";

// Raw SSE error events and HTTP error bodies go through the real Nebius
// adapter and the executor together, so the retry rules see exactly what the
// adapter makes of them.

const A = "nvidia/Nemotron-3_5-Lightning";
const B = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B";

const plan: TierPlan = {
  tier: "fast",
  models: [A, B],
  maxOutputTokens: 256,
  thinkingBudgetTokens: 0,
  firstTokenTimeoutMs: 5_000,
  deadlineMs: 60_000,
  hedgeAfterMs: null,
  triesPerModel: 2,
  maxAttempts: 4,
};

const ok = () =>
  new Response(streamFrom([sseEvent(deltaChunk("Fine.")), sseEvent(finishChunk()), sseEvent("[DONE]")]), {
    status: 200,
  });

/** A stream that sends one error event before any text, as some servers do after HTTP 200. */
const sseError = (error: Record<string, unknown>) =>
  new Response(streamFrom([sseEvent({ error: { message: "secret detail", ...error } }), sseEvent("[DONE]")]), {
    status: 200,
  });

const httpError = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function run(responses: Record<string, (() => Response)[]>) {
  const used: Record<string, number> = {};
  const models: string[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    const model = (JSON.parse(String(init?.body)) as { model: string }).model;
    models.push(model);
    const list = responses[model] ?? [ok];
    const index = used[model] ?? 0;
    used[model] = index + 1;
    return list[Math.min(index, list.length - 1)]!();
  });
  const budget: AttemptBudget = {
    async reserve() {
      return { allowed: true, hold: { reservationId: "r", heldMicroUsd: 1 } };
    },
    settle() {},
  };
  const report = newRouteReport("fast");
  let text = "";
  let error: unknown = null;
  try {
    for await (const chunk of executeRouted({
      plan,
      messages: [{ role: "user", content: "hi" }],
      provider: createNebiusProvider({ apiKey: "k", baseUrl: "https://nebius.test/v1" }, { fetchImpl }),
      budget,
      breaker: createCircuitBreaker({ threshold: 3, cooldownMs: 30_000 }),
      signal: new AbortController().signal,
      report,
      random: () => 0,
    })) {
      if (chunk.type === "text") text += chunk.text;
    }
  } catch (e) {
    error = e;
  }
  return { models, text, error, report };
}

describe("SSE and HTTP errors through the adapter and the executor", () => {
  it.each([
    ["numeric code 404", { code: 404 }],
    ["string code '404'", { code: "404" }],
    ["model_not_found label", { code: "model_not_found", type: "invalid_request_error" }],
  ])("moves to the next model for an SSE error with %s", async (_label, error) => {
    const { models, text, report } = await run({ [A]: [() => sseError(error)] });
    expect(models).toEqual([A, B]);
    expect(text).toBe("Fine.");
    expect(report).toMatchObject({ model: B, fallback: true });
  });

  it.each([
    ["insufficient_quota code and type", { code: "insufficient_quota", type: "insufficient_quota" }],
    ["billing label", { type: "billing_hard_limit_reached" }],
  ])("stops every model for an SSE error with %s and says the account limit was reached", async (_label, error) => {
    const result = await run({ [A]: [() => sseError(error)] });
    expect(result.models).toEqual([A]);
    expect(result.error).toBeInstanceOf(ProviderError);
    expect((result.error as ProviderError).kind).toBe("quota");
    expect(toPublicCompletionError(result.error)).toEqual({
      code: "provider_unavailable",
      message: "The AI provider account for P-Dot has reached its limit. Please try again later.",
      retryable: false,
    });
    // The provider's message text never reaches the error.
    expect(String((result.error as Error).message)).not.toContain("secret");
  });

  it("stops for an HTTP 429 whose body says insufficient_quota (no retry can help)", async () => {
    const { models, error } = await run({
      [A]: [() => httpError(429, { error: { code: "insufficient_quota", type: "insufficient_quota", message: "secret" } })],
    });
    expect(models).toEqual([A]);
    expect(error).toMatchObject({ kind: "quota", status: 429 });
  });

  it.each([
    ["SSE invalid_api_key", () => sseError({ code: "invalid_api_key" })],
    ["SSE numeric 401", () => sseError({ code: 401 })],
    ["HTTP 401", () => httpError(401, { error: { type: "authentication_error" } })],
  ])("stops for an authentication error: %s", async (_label, response) => {
    const { models, error } = await run({ [A]: [response] });
    expect(models).toEqual([A]);
    expect((error as ProviderError).kind).toBe("auth");
  });

  it.each([
    ["rate_limit_exceeded", { code: "rate_limit_exceeded", type: "requests" }],
    ["server_error", { type: "server_error" }],
    ["overloaded", { type: "overloaded_error" }],
    ["numeric 503", { code: 503 }],
    ["unknown label", { code: "something_new" }],
  ])("retries the same model for an SSE error with %s", async (_label, error) => {
    const { models, text } = await run({ [A]: [() => sseError(error), ok] });
    expect(models).toEqual([A, A]);
    expect(text).toBe("Fine.");
  });

  it("moves to the next model for HTTP 400 with model_not_found", async () => {
    const { models } = await run({ [A]: [() => httpError(400, { error: { code: "model_not_found" } })] });
    expect(models).toEqual([A, B]);
  });

  it("still stops for a plain HTTP 400", async () => {
    const { models, error } = await run({ [A]: [() => httpError(400, { detail: "secret" })] });
    expect(models).toEqual([A]);
    expect(error).toMatchObject({ kind: "invalid_request", status: 400 });
  });
});

/** An SSE body whose events arrive at the given times (setTimeout, so fake timers drive it). */
function timedSse(events: { atMs: number; payload: unknown }[], endAtMs: number): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // The reader may cancel early (after [DONE]); later writes are then ignored.
      const safely = (write: () => void) => () => {
        try {
          write();
        } catch {
          // Already cancelled.
        }
      };
      for (const event of events) {
        setTimeout(safely(() => controller.enqueue(encoder.encode(sseEvent(event.payload)))), event.atMs);
      }
      setTimeout(safely(() => controller.close()), endAtMs);
    },
  });
}

describe("a tool-only stream through the adapter and the executor", () => {
  it("finishes a 6 s forced tool call on the first model with one hold, no hedge and no timeout", async () => {
    vi.useFakeTimers();
    try {
      const fastPlan: TierPlan = { ...plan, hedgeAfterMs: 1_500, firstTokenTimeoutMs: 5_000 };
      const piece = (fields: Record<string, unknown>) => ({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...fields }] } }] });
      // The call starts at 1 s; its arguments trickle in until 6 s. No text ever arrives.
      const events = [
        { atMs: 1_000, payload: piece({ id: "call_1", type: "function", function: { name: "submit_claims", arguments: "" } }) },
        ...[2_000, 3_000, 4_000, 5_000].map((atMs, i) => ({
          atMs,
          payload: piece({ function: { arguments: ['{"items"', ":[", '{"claim":"a"}', "]"][i]! } }),
        })),
        { atMs: 6_000, payload: { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] } }] } },
        { atMs: 6_000, payload: finishChunk("tool_calls") },
        { atMs: 6_000, payload: "[DONE]" },
      ];
      const models: string[] = [];
      const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
        models.push((JSON.parse(String(init?.body)) as { model: string }).model);
        return new Response(timedSse(events, 6_001), { status: 200 });
      });
      const holds: string[] = [];
      const settles: { sent: boolean }[] = [];
      const budget: AttemptBudget = {
        async reserve(model) {
          holds.push(model);
          return { allowed: true, hold: { reservationId: `r${holds.length}`, heldMicroUsd: 1 } };
        },
        settle(_hold, _model, outcome) {
          settles.push({ sent: outcome.sent });
        },
      };
      const report = newRouteReport("fast");
      const tool = {
        type: "function" as const,
        function: { name: "submit_claims", description: "Submit", parameters: { type: "object" as const, properties: {} } },
      };
      const run = (async () => {
        const chunks = [];
        for await (const chunk of executeRouted({
          plan: fastPlan,
          messages: [{ role: "user", content: "pages" }],
          provider: createNebiusProvider({ apiKey: "k", baseUrl: "https://nebius.test/v1" }, { fetchImpl }),
          budget,
          breaker: createCircuitBreaker({ threshold: 3, cooldownMs: 30_000 }),
          signal: new AbortController().signal,
          report,
          random: () => 0,
          tools: [tool],
          toolChoice: { type: "function", function: { name: "submit_claims" } },
        })) {
          chunks.push(chunk);
        }
        return chunks;
      })();
      await vi.advanceTimersByTimeAsync(7_000);
      const chunks = await run;

      expect(models).toEqual([A]);
      expect(holds).toEqual([A]);
      expect(settles).toEqual([{ sent: true }]);
      expect(report).toMatchObject({ hedgeFired: false, model: A, fallback: false, outcome: "ok", attempts: 1 });
      // The reply commits when the complete tool call arrives.
      expect(report.firstTokenMs).toBe(6_000);
      expect(chunks.map((chunk) => chunk.type)).toEqual(["tool_calls", "finish"]);
      expect(chunks[0]).toMatchObject({ calls: [{ function: { name: "submit_claims", arguments: '{"items":[{"claim":"a"}]}' } }] });
    } finally {
      vi.useRealTimers();
    }
  });
});
