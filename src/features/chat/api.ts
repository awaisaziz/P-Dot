import { ApiError, apiRequest as request } from "@/lib/api-client";
import type { ChatRequest, ContextRecordDTO, ConversationDetail, ConversationSummary } from "@/types/api";

export { ApiError };

export async function fetchConversations(): Promise<ConversationSummary[]> {
  const response = await request("/api/conversations");
  return ((await response.json()) as { conversations: ConversationSummary[] }).conversations;
}

export async function renameConversation(id: string, title: string): Promise<ConversationSummary> {
  const response = await request(`/api/conversations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  return (await response.json()) as ConversationSummary;
}

export async function fetchConversation(id: string): Promise<ConversationDetail> {
  const response = await request(`/api/conversations/${encodeURIComponent(id)}`);
  return (await response.json()) as ConversationDetail;
}

export async function deleteConversation(id: string): Promise<void> {
  await request(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** "What was sent" for one assistant reply. Throws ApiError 404 when the reply has no record. */
export async function fetchContextRecord(messageId: string, signal?: AbortSignal): Promise<ContextRecordDTO> {
  const response = await request(`/api/messages/${encodeURIComponent(messageId)}/context`, { signal });
  return (await response.json()) as ContextRecordDTO;
}

/** Starts a chat request and returns the NDJSON response body. */
export async function postChat(body: ChatRequest, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  const response = await request("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.body) throw new ApiError(response.status, "internal_error", "The server sent an empty response.");
  return response.body;
}
