import "server-only";
import { z } from "zod";
import { EMBEDDING_DIMENSIONS } from "@/lib/limits";
import { ProviderError, createAbortScope, discardBody, kindFromStatus, type ProviderName } from "@/server/providers/errors";
import { parseRetryAfterMs } from "./client";

/**
 * The embedding model. Qwen3-Embedding-8B returns 4,096 numbers by default;
 * `dimensions: 1024` asks for a shorter vector (checked on 2026-10-19: the
 * result has 1,024 numbers and length 1). The database column is vector(1024).
 */
export const EMBEDDING_MODEL = "Qwen/Qwen3-Embedding-8B";

const EMBEDDING_TIMEOUT_MS = 20_000;

export interface EmbeddingSettings {
  apiKey: string;
  baseUrl: string;
  /** The model to call. Default EMBEDDING_MODEL; a local run names an Ollama model. */
  model?: string;
  /** Which provider this server is, for error reports. Default "nebius". */
  provider?: ProviderName;
}

export interface EmbeddingResult {
  vectors: number[][];
  /** Input tokens billed, or null when Nebius sent no valid usage. */
  promptTokens: number | null;
}

const responseSchema = z.object({
  data: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        embedding: z.array(z.number().finite()).length(EMBEDDING_DIMENSIONS),
      }),
    )
    .min(1),
  usage: z.object({ prompt_tokens: z.unknown() }).partial().optional(),
});

/**
 * Embeds `inputs` in one request. Throws ProviderError on HTTP errors,
 * timeouts and malformed responses. The error never includes the inputs.
 */
export async function createEmbeddings(
  settings: EmbeddingSettings,
  inputs: string[],
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<EmbeddingResult> {
  if (inputs.length === 0) return { vectors: [], promptTokens: 0 };
  const provider = settings.provider ?? "nebius";
  const scope = createAbortScope({ totalMs: options.timeoutMs ?? EMBEDDING_TIMEOUT_MS, parent: options.signal });
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    let response: Response;
    try {
      response = await fetchImpl(`${settings.baseUrl}/embeddings`, {
        method: "POST",
        headers: { Authorization: `Bearer ${settings.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: settings.model ?? EMBEDDING_MODEL, input: inputs, dimensions: EMBEDDING_DIMENSIONS }),
        signal: scope.signal,
      });
    } catch {
      if (scope.timedOut()) throw new ProviderError(provider, "timeout");
      if (options.signal?.aborted) throw new ProviderError(provider, "aborted");
      throw new ProviderError(provider, "unavailable");
    }
    if (!response.ok) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      await discardBody(response);
      throw new ProviderError(provider, kindFromStatus(response.status), response.status, { retryAfterMs });
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      if (scope.timedOut()) throw new ProviderError(provider, "timeout");
      throw new ProviderError(provider, "bad_response");
    }
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success || parsed.data.data.length !== inputs.length) {
      throw new ProviderError(provider, "bad_response");
    }
    const vectors: number[][] = new Array(inputs.length);
    for (const item of parsed.data.data) {
      if (item.index >= inputs.length || vectors[item.index]) throw new ProviderError(provider, "bad_response");
      vectors[item.index] = item.embedding;
    }
    const tokens = parsed.data.usage?.prompt_tokens;
    const promptTokens = typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0 ? tokens : null;
    return { vectors, promptTokens };
  } finally {
    scope.dispose();
  }
}

/** The pgvector text form of a vector, for example "[0.1,0.2]". */
export function toPgVector(vector: number[]): string {
  return `[${vector.join(",")}]`;
}
