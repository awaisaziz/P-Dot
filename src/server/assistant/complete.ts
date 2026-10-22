import "server-only";
import type { SpendGuard } from "@/server/db/spend";
import type { Logger } from "@/server/log";
import type { ChatMessage, ModelProvider, TokenUsage } from "@/server/providers/model";
import type { CircuitBreaker } from "./breaker";
import { EmptyReplyError, executeRouted, newRouteReport, type AttemptBudget, type RouteReport } from "./executor";
import { nebiusHoldMicroUsd, nebiusSettleMicroUsd } from "./spend";
import type { RoutingConfig, TierPlan } from "./tiers";
import type { ToolCall, ToolDefinition } from "./tools";

// Spend bookkeeping shared by every model call the assistant makes: the chat
// reply (each hop of the tool loop), the conversation title and the session
// summary. Every attempt reserves its worst case first and settles after
// (docs/PROVIDER-RELIABILITY.md).

/** A Nebius hold made before a call starts and settled when it ends. */
export interface NebiusHold {
  reservationId: string;
  heldMicroUsd: number;
}

export interface CompletionDeps {
  spend: SpendGuard;
  provider: ModelProvider;
  breaker: CircuitBreaker;
  random?: () => number;
  log: Logger;
  /** Keeps work (the spend settle) running after the client disconnects. */
  waitUntil: (work: Promise<unknown>) => void;
}

export async function settleQuietly(
  deps: Pick<CompletionDeps, "spend" | "log">,
  requestId: string,
  provider: "nebius" | "tavily",
  reservationId: string,
  amount: number,
): Promise<void> {
  try {
    await deps.spend.settle(reservationId, amount);
  } catch {
    deps.log("warn", "spend_settle_failed", { requestId, route: "chat", provider });
  }
}

export interface BudgetOptions {
  requestId: string;
  plan: TierPlan;
  /** The messages every attempt of this call sends; the hold is their worst case. */
  messages: ChatMessage[];
  extraInputBytes?: number;
  /** A hold made before the stream. It pays for the first attempt and is then used up. */
  holds?: { prepaid: NebiusHold | null };
  /** Called for each settle; the caller tracks the promise. */
  settle: (hold: NebiusHold, amount: number) => void;
  /** Extra log fields for a refusal. */
  logFields?: Record<string, string | number | boolean | null | undefined>;
}

/** The spend guard for one routed call: one hold for each attempt, settled once. */
export function attemptBudget(deps: Pick<CompletionDeps, "spend" | "log">, options: BudgetOptions): AttemptBudget {
  return {
    async reserve(model) {
      if (options.holds?.prepaid) {
        const hold = options.holds.prepaid;
        options.holds.prepaid = null;
        return { allowed: true, hold };
      }
      const heldMicroUsd = nebiusHoldMicroUsd(model, options.messages, options.plan.maxOutputTokens, options.extraInputBytes ?? 0);
      const reservation = await deps.spend.reserve("nebius", heldMicroUsd);
      if (!reservation.allowed) {
        deps.log("warn", "spend_limit_reached", {
          requestId: options.requestId,
          route: "chat",
          provider: "nebius",
          limit: reservation.limit,
          stage: "attempt",
          ...options.logFields,
        });
        return { allowed: false, limit: reservation.limit };
      }
      return { allowed: true, hold: { reservationId: reservation.id, heldMicroUsd } };
    },
    settle(hold, model, outcome) {
      // Without valid usage the full hold stays counted; 0 only when no call was sent.
      options.settle(hold, outcome.sent ? nebiusSettleMicroUsd(model, hold.heldMicroUsd, outcome.usage) : 0);
    },
  };
}

export interface TextCompletion {
  text: string;
  model: string | null;
  usage: TokenUsage | null;
  report: RouteReport;
}

/**
 * One complete text reply on a tier, with its own holds, for short internal
 * calls such as a conversation title. Tool calls are not offered. Throws the
 * executor's errors (BudgetExhaustedError, EmptyReplyError, ProviderError).
 * Every hold is settled before it returns.
 */
export async function completeText(
  deps: CompletionDeps,
  input: { requestId: string; plan: TierPlan; messages: ChatMessage[]; signal: AbortSignal; maxChars: number },
): Promise<TextCompletion> {
  const settles: Promise<void>[] = [];
  const settle = (hold: NebiusHold, amount: number) => {
    const settling = settleQuietly(deps, input.requestId, "nebius", hold.reservationId, amount);
    deps.waitUntil(settling);
    settles.push(settling);
  };
  const report = newRouteReport(input.plan.tier);
  let text = "";
  let usage: TokenUsage | null = null;
  try {
    for await (const chunk of executeRouted({
      plan: input.plan,
      messages: input.messages,
      provider: deps.provider,
      budget: attemptBudget(deps, { requestId: input.requestId, plan: input.plan, messages: input.messages, settle }),
      breaker: deps.breaker,
      signal: input.signal,
      report,
      random: deps.random,
    })) {
      if (chunk.type === "text") text += chunk.text;
      else if (chunk.type === "finish") usage = chunk.usage;
      if (text.length >= input.maxChars) break;
    }
  } finally {
    await Promise.all(settles);
  }
  return { text: text.slice(0, input.maxChars), model: report.model, usage, report };
}

/** The plan for a workflow's extraction call: the standard tier, no hedge, 2,048 output tokens (decision 0015). */
export function extractionPlan(routing: RoutingConfig): TierPlan {
  return { ...routing.standard, models: [...routing.standard.models], hedgeAfterMs: null, maxOutputTokens: 2048 };
}

/** Longest text reply read when the model answers a forced tool call with text. */
const TOOL_TEXT_MAX_CHARS = 16_384;

export type ToolCallFailure = "no_tool_call" | "truncated" | "invalid_json";

export type ToolCallCompletion =
  | { ok: true; args: unknown; model: string; usage: TokenUsage | null; report: RouteReport }
  | { ok: false; reason: ToolCallFailure; model: string | null; usage: TokenUsage | null; report: RouteReport };

/** Parses a JSON object from a text reply, with or without a code fence. Undefined when there is none. */
function jsonFromText(text: string): unknown {
  const unfenced = text
    .trim()
    .replace(/^```[A-Za-z0-9_-]*\s*/, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  const candidates = [unfenced];
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start > 0 && end > start) candidates.push(unfenced.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

/** A text reply shaped like a tool call ({name, arguments}) gives its arguments. */
function unwrapTextCall(value: unknown, name: string): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const inner = record.arguments ?? record.parameters;
  if (record.name === name && inner && typeof inner === "object") return inner;
  if (typeof inner === "string" && record.name === name) {
    try {
      return JSON.parse(inner);
    } catch {
      return value;
    }
  }
  return value;
}

/**
 * One routed call that must answer with a single forced tool call, for a
 * workflow's extraction step. Every attempt holds its worst case (the tool
 * definition counts as input) and every hold is settled before this returns.
 * A text reply (Ollama ignores tool_choice) is read as JSON when it is JSON.
 * Returns the parsed arguments, unchecked: the caller validates them. Throws
 * the executor's errors (BudgetExhaustedError, ProviderError,
 * NebiusHoldTooLargeError) except an empty reply, which is "no_tool_call".
 */
export async function completeToolCall(
  deps: CompletionDeps,
  input: {
    requestId: string;
    plan: TierPlan;
    messages: ChatMessage[];
    tool: ToolDefinition;
    signal: AbortSignal;
    logFields?: Record<string, string | number | boolean | null | undefined>;
  },
): Promise<ToolCallCompletion> {
  const settles: Promise<void>[] = [];
  const settle = (hold: NebiusHold, amount: number) => {
    const settling = settleQuietly(deps, input.requestId, "nebius", hold.reservationId, amount);
    deps.waitUntil(settling);
    settles.push(settling);
  };
  const name = input.tool.function.name;
  const tools = [input.tool];
  const toolBytes = new TextEncoder().encode(JSON.stringify(tools)).length + 64;
  const report = newRouteReport(input.plan.tier);
  let text = "";
  let overflow = false;
  const calls: ToolCall[] = [];
  let finishReason: string | null = null;
  let usage: TokenUsage | null = null;
  try {
    for await (const chunk of executeRouted({
      plan: input.plan,
      messages: input.messages,
      provider: deps.provider,
      budget: attemptBudget(deps, {
        requestId: input.requestId,
        plan: input.plan,
        messages: input.messages,
        extraInputBytes: toolBytes,
        settle,
        logFields: input.logFields,
      }),
      breaker: deps.breaker,
      signal: input.signal,
      report,
      random: deps.random,
      tools,
      toolChoice: { type: "function", function: { name } },
    })) {
      if (chunk.type === "text") {
        text += chunk.text;
        if (text.length > TOOL_TEXT_MAX_CHARS) {
          overflow = true;
          break;
        }
      } else if (chunk.type === "tool_calls") {
        calls.push(...chunk.calls);
      } else {
        finishReason = chunk.finishReason;
        usage = chunk.usage;
      }
    }
  } catch (error) {
    await Promise.all(settles);
    if (error instanceof EmptyReplyError) return { ok: false, reason: "no_tool_call", model: null, usage: null, report };
    throw error;
  }
  await Promise.all(settles);

  const model = report.model;
  if (overflow || finishReason === "length") return { ok: false, reason: "truncated", model, usage, report };
  if (!model) return { ok: false, reason: "no_tool_call", model, usage, report };
  const call = calls.find((c) => c.function.name === name);
  if (call) {
    try {
      const args: unknown = JSON.parse(call.function.arguments.trim() === "" ? "{}" : call.function.arguments);
      return { ok: true, args, model, usage, report };
    } catch {
      return { ok: false, reason: "invalid_json", model, usage, report };
    }
  }
  if (calls.length === 0) {
    const value = jsonFromText(text);
    if (value !== undefined) return { ok: true, args: unwrapTextCall(value, name), model, usage, report };
  }
  return { ok: false, reason: "no_tool_call", model, usage, report };
}
