import "server-only";
import { EMBEDDING_BATCH_SIZE } from "@/lib/limits";
import type { SpendGuard, SpendLimit } from "@/server/db/spend";
import { EMBEDDING_MODEL, createEmbeddings, type EmbeddingSettings } from "@/server/providers/nebius/embeddings";
import { nebiusEmbeddingHoldMicroUsd, nebiusSettleMicroUsd } from "./spend";

/** The Nebius budget refused an embedding request. */
export class EmbeddingBudgetError extends Error {
  constructor(public readonly limit: SpendLimit) {
    super(`embedding refused by the spend guard: ${limit}`);
    this.name = "EmbeddingBudgetError";
  }
}

export interface Embedder {
  /** One vector for each text, in order. Throws EmbeddingBudgetError, NebiusHoldTooLargeError or ProviderError. */
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

/**
 * Embeds texts in batches. Every batch reserves its worst-case cost first and
 * settles the real cost after (the same rules as chat: no valid usage means
 * the full hold stays counted). See docs/PROVIDER-RELIABILITY.md.
 */
export function createBudgetedEmbedder(deps: {
  settings: EmbeddingSettings;
  spend: SpendGuard;
  fetchImpl?: typeof fetch;
  /** The model ID the hold is priced for. Default EMBEDDING_MODEL; a local model is `ollama/<model>`. */
  priceModel?: string;
}): Embedder {
  const priceModel = deps.priceModel ?? EMBEDDING_MODEL;
  return {
    async embed(texts, signal) {
      // Every batch's hold is checked before the first reservation, so a refusal spends nothing.
      const batches: { batch: string[]; hold: number }[] = [];
      for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
        const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
        batches.push({ batch, hold: nebiusEmbeddingHoldMicroUsd(priceModel, batch) });
      }
      const out: number[][] = [];
      for (const { batch, hold } of batches) {
        const reservation = await deps.spend.reserve("nebius", hold);
        if (!reservation.allowed) throw new EmbeddingBudgetError(reservation.limit);
        let charged = hold;
        try {
          const result = await createEmbeddings(deps.settings, batch, { signal, fetchImpl: deps.fetchImpl });
          const usage = result.promptTokens === null ? null : { promptTokens: result.promptTokens, completionTokens: 0 };
          charged = nebiusSettleMicroUsd(priceModel, hold, usage);
          out.push(...result.vectors);
        } finally {
          // A failed settle leaves the full hold counted, which is the safe side.
          await deps.spend.settle(reservation.id, charged).catch(() => {});
        }
      }
      return out;
    },
  };
}
