import "server-only";
import type { ModelTier } from "@/lib/routing";
import type { SpendLimit } from "@/server/db/spend";
import { ProviderError } from "@/server/providers/errors";
import type { ChatMessage, CompletionChunk, ModelProvider, TokenUsage } from "@/server/providers/model";
import type { ToolChoice, ToolDefinition } from "./tools";
import type { CircuitBreaker } from "./breaker";
import { RETRY_POLICY, type TierPlan } from "./tiers";

// Runs one reply on a tier's model chain with retries, fallbacks, a first-token
// timeout, one deadline, an optional hedge (fast tier only) and a soft circuit
// breaker. Provider-agnostic: it uses only the ModelProvider interface.
//
// The one rule that matters most: an attempt can be retried or replaced only
// BEFORE the first visible token goes to the user. After that, the executor
// never switches models; an error goes to the caller as before.
//
// See docs/decisions/0007-model-routing.md.

/** A spend hold for one attempt. */
export interface AttemptHold {
  reservationId: string;
  heldMicroUsd: number;
}

/**
 * What the executor knows about an attempt's cost. `sent: false` means no
 * provider call was made (the hold can go back in full). Otherwise the cost is
 * the usage, and without valid usage the full hold stays counted.
 */
export interface AttemptOutcome {
  sent: boolean;
  usage: TokenUsage | null;
}

/** The spend guard, one hold for each attempt (hedges included). */
export interface AttemptBudget {
  reserve(model: string): Promise<{ allowed: true; hold: AttemptHold } | { allowed: false; limit: SpendLimit }>;
  /** Records the cost of an attempt. Must not throw or block; the caller tracks it. */
  settle(hold: AttemptHold, model: string, outcome: AttemptOutcome): void;
}

/** The spend guard refused an attempt. The reply stops with `budget_exhausted`. */
export class BudgetExhaustedError extends Error {
  constructor(public readonly limit: SpendLimit) {
    super(`Spend limit reached: ${limit}`);
    this.name = "BudgetExhaustedError";
  }
}

/** Every attempt finished without a visible token (for example all replies were empty). */
export class EmptyReplyError extends Error {
  constructor() {
    super("The model returned an empty reply");
    this.name = "EmptyReplyError";
  }
}

export type RouteOutcome = "ok" | "error" | "aborted" | "timeout" | "budget" | "empty" | "stopped";

/** Metadata for logs. No prompt or reply text. */
export interface RouteReport {
  tier: ModelTier;
  /** Models of all attempts in start order, hedge included. */
  modelsTried: string[];
  attempts: number;
  hedgeFired: boolean;
  hedgeWon: boolean;
  breakerSkips: number;
  /** Time from the start to the first visible token. */
  firstTokenMs: number | null;
  totalMs: number | null;
  outcome: RouteOutcome | null;
  /** The model that sent the reply, once its first visible token arrived. */
  model: string | null;
  /** True when that model is not the tier's first choice. */
  fallback: boolean;
}

export function newRouteReport(tier: ModelTier): RouteReport {
  return {
    tier,
    modelsTried: [],
    attempts: 0,
    hedgeFired: false,
    hedgeWon: false,
    breakerSkips: 0,
    firstTokenMs: null,
    totalMs: null,
    outcome: null,
    model: null,
    fallback: false,
  };
}

export interface ExecuteOptions {
  plan: TierPlan;
  messages: ChatMessage[];
  provider: ModelProvider;
  budget: AttemptBudget;
  breaker: CircuitBreaker;
  /** The user's Stop or disconnect. Aborts every attempt. */
  signal: AbortSignal;
  report: RouteReport;
  /** Random number from 0 to 1, for backoff jitter (tests replace it). */
  random?: () => number;
  /** Function tools offered to every attempt of this call. */
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
}

/**
 * Chunks for the caller: visible text and tool calls, then one finish. A tool
 * call commits the attempt like a first token does: the model has answered,
 * even if it answered with a tool request only.
 */
export type ExecutedChunk = Extract<CompletionChunk, { type: "text" } | { type: "tool_calls" } | { type: "finish" }>;

type ErrorAction = "retry" | "next_model" | "stop";

/**
 * How to handle a failed attempt before the first visible token.
 * - retry: network errors, timeouts, mid-stream errors, 408, 409, 425, 429, 5xx.
 * - next_model: 404 or a "model not found" label.
 * - stop: 400, 401, 403, 413, 422, and account quota or authentication
 *   labels (even with HTTP 429). Another model would fail the same way.
 */
export function classifyError(error: unknown): ErrorAction {
  if (!(error instanceof ProviderError)) return "stop";
  if (error.kind === "quota" || error.kind === "auth") return "stop";
  if (error.kind === "model_not_found") return "next_model";
  const status = error.status;
  if (status !== undefined) {
    if (status === 404) return "next_model";
    if ([408, 409, 425, 429].includes(status) || status >= 500) return "retry";
    return "stop";
  }
  switch (error.kind) {
    case "timeout":
    case "rate_limited":
    case "unavailable":
    case "bad_response":
      return "retry";
    default:
      return "stop";
  }
}

/** Full-jitter exponential backoff for the next try after `triesSoFar` tries on a model. */
export function backoffMs(triesSoFar: number, random: () => number): number {
  const cap = Math.min(RETRY_POLICY.backoffMaxMs, RETRY_POLICY.backoffBaseMs * 2 ** Math.max(0, triesSoFar - 1));
  return Math.floor(random() * cap);
}

interface Attempt {
  model: string;
  hedge: boolean;
  controller: AbortController;
  startedAt: number;
  firstTokenAt: number | null;
  hold: AttemptHold | null;
  sent: boolean;
  closed: boolean;
  iterator: AsyncIterator<CompletionChunk> | null;
  pending: Promise<AttemptEvent> | null;
}

type AttemptEvent =
  | { attempt: Attempt; type: "chunk"; chunk: CompletionChunk }
  | { attempt: Attempt; type: "end" }
  | { attempt: Attempt; type: "error"; error: unknown }
  | { attempt: Attempt; type: "refused"; limit: SpendLimit }
  | { attempt: Attempt; type: "reserve_failed"; error: unknown };

type Wake = AttemptEvent | { type: "timer" } | { type: "abort" };

export async function* executeRouted(options: ExecuteOptions): AsyncGenerator<ExecutedChunk> {
  const { plan, provider, budget, breaker, report } = options;
  const random = options.random ?? Math.random;
  const startedAt = Date.now();
  const deadlineAt = startedAt + plan.deadlineMs;

  // One controller for the whole reply: the user's abort and the deadline stop every attempt.
  const request = new AbortController();
  let deadlineHit = false;
  const onUserAbort = () => request.abort();
  if (options.signal.aborted) request.abort();
  else options.signal.addEventListener("abort", onUserAbort, { once: true });
  const deadlineTimer = setTimeout(() => {
    deadlineHit = true;
    request.abort();
  }, plan.deadlineMs);

  const ignoreBreaker = plan.models.every((model) => breaker.isOpen(model, startedAt));
  const queue = plan.models.flatMap((model) => Array<string>(plan.triesPerModel).fill(model));
  const dropped = new Set<string>();
  const tries = new Map<string, number>();
  const live: Attempt[] = [];
  const all: Attempt[] = [];
  let lastError: unknown = null;
  // The earliest time each model may be tried again (backoff or Retry-After).
  // Kept for each model, so a failure on another model never shortens it.
  const notBefore = new Map<string, number>();
  let hedgeUsed = false;

  const abortError = () =>
    options.signal.aborted || !deadlineHit
      ? new ProviderError(provider.name, "aborted")
      : new ProviderError(provider.name, "timeout");

  const usable = (model: string) => {
    if (dropped.has(model)) return false;
    if (!ignoreBreaker && breaker.isOpen(model, Date.now())) {
      dropped.add(model);
      report.breakerSkips += 1;
      return false;
    }
    return true;
  };

  function takeSlot(): string | null {
    while (queue.length > 0 && report.attempts < plan.maxAttempts) {
      const model = queue.shift()!;
      if (usable(model)) return model;
    }
    return null;
  }

  function takeHedgeSlot(primary: string): string | null {
    if (report.attempts >= plan.maxAttempts) return null;
    // A hedge must start now, so a model that is still waiting to retry is not used.
    const now = Date.now();
    const index = queue.findIndex(
      (model) => model !== primary && (notBefore.get(model) ?? 0) <= now && usable(model),
    );
    return index === -1 ? null : queue.splice(index, 1)[0]!;
  }

  function pull(attempt: Attempt): Promise<AttemptEvent> {
    const iterator = attempt.iterator!;
    return iterator.next().then(
      (result): AttemptEvent => (result.done ? { attempt, type: "end" } : { attempt, type: "chunk", chunk: result.value }),
      (error: unknown): AttemptEvent => ({ attempt, type: "error", error }),
    );
  }

  function launch(model: string, hedge: boolean): void {
    const attempt: Attempt = {
      model,
      hedge,
      controller: new AbortController(),
      startedAt: Date.now(),
      firstTokenAt: null,
      hold: null,
      sent: false,
      closed: false,
      iterator: null,
      pending: null,
    };
    request.signal.addEventListener("abort", () => attempt.controller.abort(), { once: true });
    report.attempts += 1;
    report.modelsTried.push(model);
    tries.set(model, (tries.get(model) ?? 0) + 1);
    live.push(attempt);
    all.push(attempt);

    attempt.pending = (async (): Promise<AttemptEvent> => {
      let reserved: Awaited<ReturnType<AttemptBudget["reserve"]>>;
      try {
        reserved = await budget.reserve(model);
      } catch (error) {
        return { attempt, type: "reserve_failed", error };
      }
      if (!reserved.allowed) return { attempt, type: "refused", limit: reserved.limit };
      attempt.hold = reserved.hold;
      if (attempt.closed) {
        // Stopped while the hold was made: no call was sent.
        budget.settle(reserved.hold, model, { sent: false, usage: null });
        return { attempt, type: "error", error: new ProviderError(provider.name, "aborted") };
      }
      attempt.sent = true;
      try {
        const remaining = Math.max(1, deadlineAt - Date.now());
        attempt.iterator = provider
          .stream(
            {
              model,
              messages: options.messages,
              maxOutputTokens: plan.maxOutputTokens,
              thinkingBudgetTokens: plan.thinkingBudgetTokens,
              timeoutMs: remaining,
              tools: options.tools,
              toolChoice: options.toolChoice,
            },
            attempt.controller.signal,
          )
          [Symbol.asyncIterator]();
      } catch (error) {
        return { attempt, type: "error", error };
      }
      return pull(attempt);
    })();
  }

  /** Ends an attempt: stops its stream and settles its hold once. */
  function close(attempt: Attempt, usage: TokenUsage | null): void {
    if (attempt.closed) return;
    attempt.closed = true;
    const index = live.indexOf(attempt);
    if (index !== -1) live.splice(index, 1);
    attempt.controller.abort();
    const iterator = attempt.iterator;
    if (iterator?.return) {
      const end = () => {
        Promise.resolve()
          .then(() => iterator.return!())
          .catch(() => {});
      };
      if (attempt.pending) attempt.pending.then(end, end);
      else end();
    }
    // A hold still being made is settled by launch() when it arrives.
    if (attempt.hold) budget.settle(attempt.hold, attempt.model, { sent: attempt.sent, usage });
  }

  function closeAll(): void {
    for (const attempt of [...live]) close(attempt, null);
  }

  function recordFirstToken(attempt: Attempt): void {
    if (attempt.firstTokenAt !== null) return;
    attempt.firstTokenAt = Date.now();
    // The first attempt to send any token wins the race; the other one stops now.
    for (const other of [...live]) {
      if (other !== attempt) close(other, null);
    }
    if (attempt.hedge) report.hedgeWon = true;
  }

  function hedgeDueAt(): number | null {
    if (plan.hedgeAfterMs === null || hedgeUsed || live.length !== 1) return null;
    const primary = live[0]!;
    if (primary.hedge || primary.firstTokenAt !== null) return null;
    return primary.startedAt + plan.hedgeAfterMs;
  }

  /** Waits for the next attempt event, timer or abort. */
  async function wake(): Promise<Wake> {
    const dueTimes = live.filter((a) => a.firstTokenAt === null).map((a) => a.startedAt + plan.firstTokenTimeoutMs);
    const hedgeAt = hedgeDueAt();
    if (hedgeAt !== null) dueTimes.push(hedgeAt);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const waits: Promise<Wake>[] = live.map((attempt) => attempt.pending!);
    if (dueTimes.length > 0) {
      const delay = Math.max(0, Math.min(...dueTimes) - Date.now());
      waits.push(new Promise((resolve) => (timer = setTimeout(() => resolve({ type: "timer" }), delay))));
    }
    waits.push(
      new Promise((resolve) => {
        onAbort = () => resolve({ type: "abort" });
        if (request.signal.aborted) onAbort();
        else request.signal.addEventListener("abort", onAbort, { once: true });
      }),
    );
    try {
      return await Promise.race(waits);
    } finally {
      clearTimeout(timer);
      if (onAbort) request.signal.removeEventListener("abort", onAbort);
    }
  }

  async function sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", done);
        resolve();
      }
      request.signal.addEventListener("abort", done, { once: true });
    });
  }

  function onTimer(): void {
    const now = Date.now();
    for (const attempt of [...live]) {
      if (attempt.firstTokenAt === null && now >= attempt.startedAt + plan.firstTokenTimeoutMs) {
        // No token in time: stop this attempt and move on to the next model.
        close(attempt, null);
        breaker.recordFailure(attempt.model, now);
        dropped.add(attempt.model);
        lastError = new ProviderError(provider.name, "timeout");
      }
    }
    const hedgeAt = hedgeDueAt();
    if (hedgeAt !== null && now >= hedgeAt) {
      hedgeUsed = true;
      const model = takeHedgeSlot(live[0]!.model);
      if (model) {
        report.hedgeFired = true;
        launch(model, true);
      }
    }
  }

  function onFailure(attempt: Attempt, error: unknown): void {
    close(attempt, null);
    lastError = error;
    const action = classifyError(error);
    if (action === "stop") {
      closeAll();
      throw error;
    }
    breaker.recordFailure(attempt.model, Date.now());
    const retryAfterMs = error instanceof ProviderError ? error.retryAfterMs : undefined;
    if (action === "next_model" || (retryAfterMs ?? 0) > RETRY_POLICY.retryAfterMaxMs) {
      dropped.add(attempt.model);
      return;
    }
    const wait = Math.max(backoffMs(tries.get(attempt.model) ?? 1, random), retryAfterMs ?? 0);
    const until = Date.now() + wait;
    notBefore.set(attempt.model, Math.max(notBefore.get(attempt.model) ?? 0, until));
  }

  /** Runs attempts until one sends visible text or a tool call. Returns that attempt and its first chunk. */
  async function acquire(): Promise<{ attempt: Attempt; first: ExecutedChunk }> {
    for (;;) {
      if (request.signal.aborted) throw abortError();
      if (live.length === 0) {
        const model = takeSlot();
        if (!model) throw lastError ?? new ProviderError(provider.name, "unavailable");
        const wait = (notBefore.get(model) ?? 0) - Date.now();
        if (wait > 0) await sleep(Math.min(wait, Math.max(0, deadlineAt - Date.now())));
        if (request.signal.aborted) throw abortError();
        if (deadlineAt - Date.now() < RETRY_POLICY.minAttemptMs) {
          throw lastError ?? new ProviderError(provider.name, "timeout");
        }
        launch(model, false);
      }

      const event = await wake();
      if (event.type === "abort") throw abortError();
      if (event.type === "timer") {
        onTimer();
        continue;
      }
      const attempt = event.attempt;
      if (attempt.closed) continue;

      switch (event.type) {
        case "reserve_failed":
          // The budget could not be checked: fail closed.
          closeAll();
          throw event.error;
        case "refused":
          close(attempt, null);
          // A hedge is optional: without budget for it, the first attempt goes on alone.
          if (attempt.hedge) continue;
          closeAll();
          throw new BudgetExhaustedError(event.limit);
        case "error":
          if (request.signal.aborted) throw abortError();
          onFailure(attempt, event.error);
          continue;
        case "end":
          onFailure(attempt, new ProviderError(provider.name, "unavailable"));
          continue;
        case "chunk": {
          const chunk = event.chunk;
          if (chunk.type === "finish") {
            // Finished with no visible text: an empty reply. Try the next model.
            close(attempt, chunk.usage);
            dropped.add(attempt.model);
            lastError = new EmptyReplyError();
            continue;
          }
          recordFirstToken(attempt);
          if (chunk.type === "text" && chunk.text.length > 0) return { attempt, first: chunk };
          if (chunk.type === "tool_calls") return { attempt, first: chunk };
          attempt.pending = pull(attempt);
          continue;
        }
      }
    }
  }

  let committed: Attempt | null = null;
  let finished = false;
  try {
    const first = await acquire();
    committed = first.attempt;
    committed.pending = null;
    breaker.recordSuccess(committed.model);
    report.model = committed.model;
    report.fallback = committed.model !== plan.models[0];
    report.firstTokenMs = Date.now() - startedAt;
    yield first.first;

    // Committed: pass the stream through. No more retries or model switches.
    let usage: TokenUsage | null = null;
    for (;;) {
      let result: IteratorResult<CompletionChunk>;
      try {
        result = await committed.iterator!.next();
      } catch (error) {
        throw request.signal.aborted ? abortError() : error;
      }
      if (result.done) break;
      const chunk = result.value;
      if (chunk.type === "text" || chunk.type === "tool_calls") yield chunk;
      else if (chunk.type === "finish") {
        usage = chunk.usage;
        finished = true;
        close(committed, usage);
        yield chunk;
        break;
      }
    }
    if (!finished) throw new ProviderError(provider.name, "unavailable");
    report.outcome = "ok";
  } catch (error) {
    report.outcome = outcomeOf(error, options.signal);
    throw error;
  } finally {
    // Stopped early (Stop, disconnect, length cut) or failed: stop and settle everything left.
    if (report.outcome === null) report.outcome = "stopped";
    closeAll();
    clearTimeout(deadlineTimer);
    options.signal.removeEventListener("abort", onUserAbort);
    report.totalMs = Date.now() - startedAt;
  }
}

function outcomeOf(error: unknown, signal: AbortSignal): RouteOutcome {
  if (signal.aborted) return "aborted";
  if (error instanceof BudgetExhaustedError) return "budget";
  if (error instanceof EmptyReplyError) return "empty";
  if (error instanceof ProviderError && error.kind === "timeout") return "timeout";
  return "error";
}
