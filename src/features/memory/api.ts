import { ApiError, deleteResource, errorMessage, getJson, sendJson } from "@/lib/api-client";
import type { MemoryDTO, MemoryStatus } from "@/types/api";

export async function fetchMemories(status?: MemoryStatus, signal?: AbortSignal): Promise<MemoryDTO[]> {
  const query = status ? `?${new URLSearchParams({ status })}` : "";
  return (await getJson<{ memories: MemoryDTO[] }>(`/api/memories${query}`, signal)).memories;
}

export async function createMemory(content: string): Promise<MemoryDTO> {
  return sendJson<MemoryDTO>("/api/memories", "POST", { content });
}

/** Edit the text, or approve a proposed memory with status "active". */
export async function updateMemory(id: string, changes: { content?: string; status?: "active" }): Promise<MemoryDTO> {
  return sendJson<MemoryDTO>(`/api/memories/${encodeURIComponent(id)}`, "PATCH", changes);
}

export async function deleteMemory(id: string): Promise<void> {
  await deleteResource(`/api/memories/${encodeURIComponent(id)}`);
}

export interface SummarizeResult {
  ok: boolean;
  extractedCount: number;
  createdCount: number;
  skippedCount: number;
}

/**
 * Asks P-Dot to suggest lasting facts from a conversation as "Remember this?"
 * cards. Best effort: the chat calls it when a conversation is left or grows.
 */
export async function summarizeConversation(conversationId: string): Promise<SummarizeResult> {
  return sendJson<SummarizeResult>("/api/memories/summarize", "POST", { conversationId });
}

/** A user-facing message for a failed memory request. New or changed text needs the embedding service. */
export function memoryErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.code === "not_configured") {
    return "Saving memory text needs the Nebius embedding service, which is not configured on this server.";
  }
  return errorMessage(err, fallback);
}
