import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { MemoryDTO, MemorySource, MemoryStatus, Mode } from "@/types/api";
import { toPgVector, EMBEDDING_MODEL } from "@/server/providers/nebius/embeddings";
import { RepositoryError } from "./conversations";

/**
 * Memory persistence (decision 0009). As with tasks, every method filters by
 * the authenticated user's ID, and RLS enforces the same rule in the database.
 *
 * The embedding vector is written here but never read back: no method selects
 * the `embedding` column, so it never reaches a DTO or an API response.
 */
export interface NewMemory {
  mode: Mode;
  content: string;
  status: MemoryStatus;
  source: MemorySource;
  sourceMessageId: string | null;
}

export interface MemoryRepository {
  /**
   * Newest first. `status` filters by proposed or active; undefined returns both.
   * `mode`, when given, keeps only the rows saved with it (decision 0014: the app passes none).
   */
  listMemories(userId: string, status: MemoryStatus | undefined, limit: number, mode?: Mode): Promise<MemoryDTO[]>;
  /** Returns null when no memory with that ID belongs to the user. */
  getMemory(userId: string, memoryId: string): Promise<MemoryDTO | null>;
  /** A null embedding stores no vector and no model name. */
  createMemory(userId: string, memory: NewMemory, embedding: number[] | null): Promise<MemoryDTO>;
  /**
   * Returns null when no memory with that ID belongs to the user. When
   * `embedding` is passed (even null), the stored vector and model are replaced.
   * When `ifContent` is passed, the update applies only while the stored text
   * still equals it (the comparison is in the update); otherwise it returns null.
   */
  updateMemory(
    userId: string,
    memoryId: string,
    changes: { content?: string; mode?: Mode; status?: MemoryStatus },
    embedding?: number[] | null,
    ifContent?: string,
  ): Promise<MemoryDTO | null>;
  /**
   * Writes a vector only if the memory still has `content`, the text that was
   * embedded. The text comparison is part of the database update, so a late
   * vector can never replace the vector of newer text. Returns false when no
   * row matched (the text changed, or the memory is gone).
   */
  setEmbeddingIfContent(userId: string, memoryId: string, content: string, embedding: number[]): Promise<boolean>;
  /** Returns false when no memory with that ID belongs to the user. */
  deleteMemory(userId: string, memoryId: string): Promise<boolean>;
}

const memoryRow = z.object({
  id: z.string(),
  mode: z.enum(["personal", "work"]),
  content: z.string(),
  status: z.enum(["proposed", "active"]),
  source: z.enum(["user", "assistant"]),
  source_message_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

/** Explicit column list. The embedding vector is deliberately absent. */
const MEMORY_COLUMNS = "id, mode, content, status, source, source_message_id, created_at, updated_at";

function toMemory(row: unknown): MemoryDTO {
  const parsed = memoryRow.parse(row);
  return {
    id: parsed.id,
    mode: parsed.mode,
    content: parsed.content,
    status: parsed.status,
    source: parsed.source,
    sourceMessageId: parsed.source_message_id,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
  };
}

/** The pair of columns that store a vector. Both are null when there is no vector. */
function embeddingColumns(embedding: number[] | null): { embedding: string | null; embedding_model: string | null } {
  return embedding
    ? { embedding: toPgVector(embedding), embedding_model: EMBEDDING_MODEL }
    : { embedding: null, embedding_model: null };
}

export function createMemoryRepository(supabase: SupabaseClient): MemoryRepository {
  return {
    async listMemories(userId, status, limit, mode) {
      let query = supabase.from("memories").select(MEMORY_COLUMNS).eq("user_id", userId);
      if (mode) query = query.eq("mode", mode);
      if (status) query = query.eq("status", status);
      const { data, error } = await query.order("created_at", { ascending: false }).limit(limit);
      if (error) throw new RepositoryError("listMemories");
      return (data ?? []).map(toMemory);
    },

    async getMemory(userId, memoryId) {
      const { data, error } = await supabase
        .from("memories")
        .select(MEMORY_COLUMNS)
        .eq("id", memoryId)
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw new RepositoryError("getMemory");
      return data ? toMemory(data) : null;
    },

    async createMemory(userId, memory, embedding) {
      const { data, error } = await supabase
        .from("memories")
        .insert({
          user_id: userId,
          mode: memory.mode,
          content: memory.content,
          status: memory.status,
          source: memory.source,
          source_message_id: memory.sourceMessageId,
          ...embeddingColumns(embedding),
        })
        .select(MEMORY_COLUMNS)
        .single();
      if (error || !data) throw new RepositoryError("createMemory");
      return toMemory(data);
    },

    async updateMemory(userId, memoryId, changes, embedding, ifContent) {
      const update = embedding === undefined ? { ...changes } : { ...changes, ...embeddingColumns(embedding) };
      let query = supabase.from("memories").update(update).eq("id", memoryId).eq("user_id", userId);
      if (ifContent !== undefined) query = query.eq("content", ifContent);
      const { data, error } = await query.select(MEMORY_COLUMNS).maybeSingle();
      if (error) throw new RepositoryError("updateMemory");
      return data ? toMemory(data) : null;
    },

    async setEmbeddingIfContent(userId, memoryId, content, embedding) {
      const { data, error } = await supabase
        .from("memories")
        .update(embeddingColumns(embedding))
        .eq("id", memoryId)
        .eq("user_id", userId)
        .eq("content", content)
        .select("id")
        .maybeSingle();
      if (error) throw new RepositoryError("setMemoryEmbedding");
      return data !== null;
    },

    async deleteMemory(userId, memoryId) {
      const { count, error } = await supabase
        .from("memories")
        .delete({ count: "exact" })
        .eq("id", memoryId)
        .eq("user_id", userId);
      if (error) throw new RepositoryError("deleteMemory");
      return (count ?? 0) > 0;
    },
  };
}
