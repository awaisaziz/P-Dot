import "server-only";
import type { SpendGuard } from "@/server/db/spend";
import type { Logger } from "@/server/log";
import type { ChatMessage, ModelProvider, TokenUsage } from "@/server/providers/model";
import type { CircuitBreaker } from "./breaker";
import { executeRouted, newRouteReport, type AttemptBudget, type RouteReport } from "./executor";
import { nebiusHoldMicroUsd, nebiusSettleMicroUsd } from "./spend";
import type { TierPlan } from "./tiers";

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
