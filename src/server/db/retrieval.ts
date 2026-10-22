import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Mode } from "@/types/api";
import { toPgVector } from "@/server/providers/nebius/embeddings";
import { RepositoryError } from "./conversations";

export interface MemoryMatch {
  id: string;
  content: string;
  similarity: number;
}

export interface DocumentChunkMatch {
  id: string;
  documentId: string;
  title: string;
  content: string;
  similarity: number;
}

const memoryRow = z.object({ id: z.string(), content: z.string(), similarity: z.number() });
const chunkRow = z.object({
  id: z.string(),
  document_id: z.string(),
  title: z.string(),
  content: z.string(),
  similarity: z.number(),
});

/** Every value the mode column can hold. A null-mode search asks for each one. */
const SAVED_MODES: readonly Mode[] = ["personal", "work"];

/** The cap match_memories and match_document_chunks put on p_count. */
const MAX_MATCH_COUNT = 20;

/**
 * Similarity search over the signed-in user's active memories and ready
 * documents. The database functions run as the caller (RLS applies) and cap
 * the count at 20. A null mode searches every row whatever mode it was saved
 * with (decision 0014).
 *
 * A null mode never reaches the database: it runs one search per saved mode
 * and merges them. The old functions filter `m.mode = p_mode` and match
 * nothing for null, so this returns the same rows before and after migration
 * 20261022000000_one_workspace.sql.
 */
export interface RetrievalRepository {
  matchMemories(vector: number[], mode: Mode | null, count: number): Promise<MemoryMatch[]>;
  matchDocumentChunks(vector: number[], mode: Mode | null, count: number): Promise<DocumentChunkMatch[]>;
}

export function createRetrievalRepository(supabase: SupabaseClient): RetrievalRepository {
  const matchMemoriesIn = async (query: string, mode: Mode, count: number): Promise<MemoryMatch[]> => {
    const { data, error } = await supabase.rpc("match_memories", { p_query: query, p_mode: mode, p_count: count });
    if (error) throw new RepositoryError("matchMemories");
    return z.array(memoryRow).parse(data ?? []);
  };

  const matchChunksIn = async (query: string, mode: Mode, count: number): Promise<DocumentChunkMatch[]> => {
    const { data, error } = await supabase.rpc("match_document_chunks", { p_query: query, p_mode: mode, p_count: count });
    if (error) throw new RepositoryError("matchDocumentChunks");
    return z
      .array(chunkRow)
      .parse(data ?? [])
      .map((r) => ({ id: r.id, documentId: r.document_id, title: r.title, content: r.content, similarity: r.similarity }));
  };

  return {
    async matchMemories(vector, mode, count) {
      const query = toPgVector(vector);
      if (mode !== null) return matchMemoriesIn(query, mode, count);
      return mergeMatches(await Promise.all(SAVED_MODES.map((m) => matchMemoriesIn(query, m, count))), count);
    },
    async matchDocumentChunks(vector, mode, count) {
      const query = toPgVector(vector);
      if (mode !== null) return matchChunksIn(query, mode, count);
      return mergeMatches(await Promise.all(SAVED_MODES.map((m) => matchChunksIn(query, m, count))), count);
    },
  };
}

/**
 * Most similar first, one row per id, cut to `count` with the same 1 to 20
 * bounds the database functions apply to p_count.
 */
function mergeMatches<T extends { id: string; similarity: number }>(lists: T[][], count: number): T[] {
  const best = new Map<string, T>();
  for (const row of lists.flat()) {
    const seen = best.get(row.id);
    if (!seen || row.similarity > seen.similarity) best.set(row.id, row);
  }
  const limit = Math.min(Math.max(count, 1), MAX_MATCH_COUNT);
  return [...best.values()].sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}
