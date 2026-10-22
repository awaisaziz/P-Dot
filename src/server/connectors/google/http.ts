import "server-only";
import { createAbortScope, discardBody, kindFromStatus, ProviderError } from "@/server/providers/errors";

// The only two ways this connector talks to Google: GET to the REST APIs on
// www.googleapis.com with a bearer token, and form POSTs to the OAuth
// endpoints on oauth2.googleapis.com. Every call has a timeout and a byte cap,
// and nothing here logs a URL, a token or a body.

export const GOOGLE_API_HOST = "www.googleapis.com";
export const GOOGLE_OAUTH_HOST = "oauth2.googleapis.com";

export interface GoogleRequestOptions {
  fetchImpl?: typeof fetch;
  /** The caller's cancel signal (for example the chat request). */
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** The most JSON accepted from an API or OAuth response. */
const MAX_JSON_BYTES = 1_000_000;

function assertHost(url: URL, host: string): void {
  if (url.protocol !== "https:" || url.host !== host || url.username || url.password) {
    throw new Error("Refused a Google request to an unexpected address");
  }
}

/** Reads at most `maxBytes` of the body and cancels the rest. */
export async function readCapped(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const room = maxBytes - total;
    if (value.byteLength > room) {
      if (room > 0) chunks.push(value.subarray(0, room));
      total = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}

async function readJson(response: Response): Promise<unknown> {
  const { bytes, truncated } = await readCapped(response, MAX_JSON_BYTES);
  if (truncated) throw new ProviderError("google", "bad_response", response.status);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ProviderError("google", "bad_response", response.status);
  }
}

/** Runs one Google call under a timeout. A network failure becomes a ProviderError. */
async function withTimeout<T>(
  options: GoogleRequestOptions,
  defaultTimeoutMs: number,
  run: (fetchImpl: typeof fetch, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const scope = createAbortScope({ totalMs: options.timeoutMs ?? defaultTimeoutMs, parent: options.signal });
  try {
    return await run(options.fetchImpl ?? fetch, scope.signal);
  } catch (error) {
    if (error instanceof ProviderError || error instanceof GoogleOAuthError) throw error;
    if (options.signal?.aborted) throw new ProviderError("google", "aborted");
    throw new ProviderError("google", scope.timedOut() ? "timeout" : "unavailable");
  } finally {
    scope.dispose();
  }
}

export type GoogleBody = { kind: "json"; value: unknown } | { kind: "bytes"; bytes: Uint8Array; truncated: boolean };

/**
 * GET from a Google REST API. Answers the parsed JSON, or the first
 * `maxBytes` of the body when `maxBytes` is given. An error status becomes a
 * ProviderError with its status and no body.
 */
export async function googleApiGet(
  accessToken: string,
  url: URL,
  options: GoogleRequestOptions,
  read: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<GoogleBody> {
  assertHost(url, GOOGLE_API_HOST);
  return withTimeout({ ...options, timeoutMs: options.timeoutMs ?? read.timeoutMs }, 10_000, async (fetchImpl, signal) => {
    const response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: read.maxBytes ? "*/*" : "application/json" },
      // Workers support only "follow" and "manual"; a redirect is answered as an error status below.
      redirect: "manual",
      signal,
    });
    if (!response.ok) {
      await discardBody(response);
      throw new ProviderError("google", kindFromStatus(response.status), response.status);
    }
    if (read.maxBytes !== undefined) {
      const { bytes, truncated } = await readCapped(response, read.maxBytes);
      return { kind: "bytes", bytes, truncated };
    }
    return { kind: "json", value: await readJson(response) };
  });
}

/** An error answer from the OAuth token endpoint, by its `error` label. Never the description. */
export class GoogleOAuthError extends Error {
  constructor(
    readonly label: string,
    readonly status: number,
  ) {
    super(`google oauth request failed (HTTP ${status})`);
    this.name = "GoogleOAuthError";
  }
}

const OAUTH_ERROR_LABEL = /^[a-z_]{1,64}$/;

/**
 * POSTs a form to an OAuth endpoint. Answers the JSON body of a success, or
 * throws GoogleOAuthError for a 4xx answer with an `error` label, or
 * ProviderError otherwise.
 */
export async function googleOAuthPost(
  url: URL,
  form: URLSearchParams,
  options: GoogleRequestOptions,
  expectJson = true,
): Promise<unknown> {
  assertHost(url, GOOGLE_OAUTH_HOST);
  return withTimeout(options, 10_000, async (fetchImpl, signal) => {
    const response = await fetchImpl(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form.toString(),
      // Workers support only "follow" and "manual"; a redirect is answered as an error status below.
      redirect: "manual",
      signal,
    });
    if (response.ok) {
      if (!expectJson) {
        await discardBody(response);
        return null;
      }
      return readJson(response);
    }
    if (response.status >= 400 && response.status < 500) {
      let label = "";
      try {
        const body = await readJson(response);
        const raw = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
        if (typeof raw === "string" && OAUTH_ERROR_LABEL.test(raw)) label = raw;
      } catch {
        // No label.
      }
      if (label) throw new GoogleOAuthError(label, response.status);
    } else {
      await discardBody(response);
    }
    throw new ProviderError("google", kindFromStatus(response.status), response.status);
  });
}
