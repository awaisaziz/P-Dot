import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { DocumentDTO, DocumentMediaType, DocumentStatus, Mode } from "@/types/api";
import { EMBEDDING_MODEL, toPgVector } from "@/server/providers/nebius/embeddings";
import { RepositoryError } from "./conversations";

export interface NewDocument {
  mode: Mode;
  title: string;
  mediaType: DocumentMediaType;
  charCount: number;
}

export interface NewChunk {
  index: number;
  content: string;
  embedding: number[];
}

/**
 * Persistence for uploaded documents and their chunks. Every method takes the
 * authenticated user's ID and filters by it explicitly; RLS enforces the same
 * rule in the database. Embeddings are written but never read back.
 */
export interface DocumentRepository {
  /** Newest first. `mode`, when given, keeps only the rows saved with it (decision 0014: the app passes none). */
  listDocuments(userId: string, limit: number, mode?: Mode): Promise<DocumentDTO[]>;
  /** Creates the document with status "processing". */
  createDocument(userId: string, document: NewDocument): Promise<DocumentDTO>;
  insertChunks(userId: string, documentId: string, chunks: NewChunk[]): Promise<void>;
  setStatus(userId: string, documentId: string, status: DocumentStatus): Promise<void>;
  /**
   * Settles at most `limit` of the user's documents that are still "processing"
   * and were created before `createdBefore`. Chunks are saved in one statement,
   * so a document has all its chunks or none. A document with chunks that all
   * have an embedding becomes "ready"; any other becomes "failed". Each update
   * applies only while the status is still "processing", so two requests cannot
   * fight. No embedding call is made. Returns the number of documents changed.
   */
  settleStaleDocuments(userId: string, createdBefore: Date, limit: number): Promise<number>;
  /** Returns false when no document with that ID belongs to the user. Chunks go with it. */
  deleteDocument(userId: string, documentId: string): Promise<boolean>;
}

const documentRow = z.object({
  id: z.string(),
  mode: z.enum(["personal", "work"]),
  title: z.string(),
  media_type: z.enum(["text/plain", "text/markdown"]),
  char_count: z.number(),
  status: z.enum(["processing", "ready", "failed"]),
  created_at: z.string(),
});

// The embedding column is deliberately left out: vectors are never sent to the client.
const DOCUMENT_COLUMNS = "id, mode, title, media_type, char_count, status, created_at";

function toDocument(row: unknown): DocumentDTO {
  const parsed = documentRow.parse(row);
  return {
    id: parsed.id,
    mode: parsed.mode,
    title: parsed.title,
    mediaType: parsed.media_type,
    charCount: parsed.char_count,
    status: parsed.status,
    createdAt: parsed.created_at,
  };
}

export function createDocumentRepository(supabase: SupabaseClient): DocumentRepository {
  return {
    async listDocuments(userId, limit, mode) {
      let query = supabase.from("documents").select(DOCUMENT_COLUMNS).eq("user_id", userId);
      if (mode) query = query.eq("mode", mode);
      const { data, error } = await query.order("created_at", { ascending: false }).limit(limit);
      if (error) throw new RepositoryError("listDocuments");
      return (data ?? []).map(toDocument);
    },

    async createDocument(userId, document) {
      const { data, error } = await supabase
        .from("documents")
        .insert({
          user_id: userId,
          mode: document.mode,
          title: document.title,
          media_type: document.mediaType,
          char_count: document.charCount,
          status: "processing",
        })
        .select(DOCUMENT_COLUMNS)
        .single();
      if (error || !data) throw new RepositoryError("createDocument");
      return toDocument(data);
    },

    async insertChunks(userId, documentId, chunks) {
      if (chunks.length === 0) return;
      const { error } = await supabase.from("document_chunks").insert(
        chunks.map((chunk) => ({
          user_id: userId,
          document_id: documentId,
          chunk_index: chunk.index,
          content: chunk.content,
          embedding: toPgVector(chunk.embedding),
          embedding_model: EMBEDDING_MODEL,
        })),
      );
      if (error) throw new RepositoryError("insertChunks");
    },

    async setStatus(userId, documentId, status) {
      const { error } = await supabase
        .from("documents")
        .update({ status })
        .eq("id", documentId)
        .eq("user_id", userId);
      if (error) throw new RepositoryError("setDocumentStatus");
    },

    async settleStaleDocuments(userId, createdBefore, limit) {
      const { data, error } = await supabase
        .from("documents")
        .select("id")
        .eq("user_id", userId)
        .eq("status", "processing")
        .lt("created_at", createdBefore.toISOString())
        .order("created_at", { ascending: true })
        .limit(limit);
      if (error) throw new RepositoryError("findStaleDocuments");
      const ids = z.array(z.object({ id: z.string() })).parse(data ?? []).map((row) => row.id);

      let settled = 0;
      for (const id of ids) {
        const [all, missing] = await Promise.all([
          supabase
            .from("document_chunks")
            .select("id", { count: "exact", head: true })
            .eq("user_id", userId)
            .eq("document_id", id),
          supabase
            .from("document_chunks")
            .select("id", { count: "exact", head: true })
            .eq("user_id", userId)
            .eq("document_id", id)
            .is("embedding", null),
        ]);
        if (all.error || missing.error || all.count == null || missing.count == null) {
          throw new RepositoryError("countDocumentChunks");
        }
        const status: DocumentStatus = all.count > 0 && missing.count === 0 ? "ready" : "failed";

        const { count, error: updateError } = await supabase
          .from("documents")
          .update({ status }, { count: "exact" })
          .eq("id", id)
          .eq("user_id", userId)
          .eq("status", "processing");
        if (updateError) throw new RepositoryError("settleStaleDocument");
        settled += count ?? 0;
      }
      return settled;
    },

    async deleteDocument(userId, documentId) {
      const { count, error } = await supabase
        .from("documents")
        .delete({ count: "exact" })
        .eq("id", documentId)
        .eq("user_id", userId);
      if (error) throw new RepositoryError("deleteDocument");
      return (count ?? 0) > 0;
    },
  };
}
