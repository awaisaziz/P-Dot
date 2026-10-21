import "server-only";

export type ProviderName = "nebius" | "ollama" | "tavily";

export type ProviderErrorKind =
  | "timeout"
  | "rate_limited"
  | "auth" // credentials rejected: an operator problem, not the user's
  | "quota" // provider account out of credit or plan limit
  | "invalid_request" // e.g. context too long
  | "model_not_found" // the provider does not know this model ID
  | "unavailable"
  | "bad_response"
  | "aborted";

/**
 * Normalized provider failure. The message contains only the provider name,
 * kind, and HTTP status, so it is safe to log; it never includes response
 * bodies or credentials.
 */
export class ProviderError extends Error {
  constructor(
    public readonly provider: ProviderName,
    public readonly kind: ProviderErrorKind,
    public readonly status?: number,
    details: { retryAfterMs?: number } = {},
  ) {
    super(`${provider} request failed: ${kind}${status ? ` (HTTP ${status})` : ""}`);
    this.name = "ProviderError";
    this.retryAfterMs = details.retryAfterMs;
  }

  /** The provider's `Retry-After`, in milliseconds, when it sent one. */
  public readonly retryAfterMs?: number;
}

/**
 * The kind for a known OpenAI-compatible error label (`error.code` or
 * `error.type`), or null. A label is more exact than the HTTP status: for
 * example `insufficient_quota` can come with HTTP 429, but a retry cannot help.
 */
export function kindFromErrorLabel(label: string): ProviderErrorKind | null {
  const l = label.toLowerCase();
  if (/quota|billing|credit|payment|insufficient_funds/.test(l)) return "quota";
  if (/invalid_api_key|authentication|unauthori[sz]ed|permission|forbidden/.test(l)) return "auth";
  if (/model_not_found|model_not_exist|no_such_model/.test(l)) return "model_not_found";
  if (/rate_limit|rate limit|too_many_requests/.test(l)) return "rate_limited";
  if (/timeout|timed_out/.test(l)) return "timeout";
  if (/server_error|overloaded|internal|service_unavailable|unavailable/.test(l)) return "unavailable";
  return null;
}

export function kindFromStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 402 || status === 432 || status === 433) return "quota";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 404 || status === 413 || status === 422) return "invalid_request";
  return "unavailable";
}

export interface AbortScope {
  signal: AbortSignal;
  /** True when the scope aborted because a timer fired (not the caller). */
  timedOut(): boolean;
  /** Restarts the idle timer; call whenever data arrives. */
  touch(): void;
  dispose(): void;
}

/**
 * An abort signal that fires on caller cancellation, after `totalMs`, or when
 * no data arrives for `idleMs`.
 */
export function createAbortScope(options: {
  totalMs: number;
  idleMs?: number;
  parent?: AbortSignal;
}): AbortScope {
  const controller = new AbortController();
  let timedOut = false;
  const fire = () => {
    timedOut = true;
    controller.abort();
  };
  const total = setTimeout(fire, options.totalMs);
  let idle = options.idleMs ? setTimeout(fire, options.idleMs) : undefined;
  const onParentAbort = () => controller.abort();
  if (options.parent?.aborted) controller.abort();
  else options.parent?.addEventListener("abort", onParentAbort, { once: true });

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    touch() {
      if (idle === undefined) return;
      clearTimeout(idle);
      idle = setTimeout(fire, options.idleMs);
    },
    dispose() {
      clearTimeout(total);
      if (idle !== undefined) clearTimeout(idle);
      options.parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

/** Cancels an unread response body (e.g. on an error status) so the connection is released. */
export async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Ignore: the body may already be consumed or the stream errored.
  }
}
