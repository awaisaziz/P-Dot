import { z } from "zod";
import { CONVERSATION_MESSAGE_LIMIT, MAX_CHAT_BODY_BYTES } from "@/lib/limits";
import { createAssistantDeps } from "@/server/assistant/deps";
import { getAssistantConfig } from "@/server/config";
import { readJsonBody } from "@/server/http/request";
import { errorResponse, jsonResponse } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";
import { summarizeSession } from "@/server/memory/summarizer";

const summarizeRequestSchema = z.object({ conversationId: z.uuid() }).strict();

/**
 * POST /api/memories/summarize. Body: { conversationId }. Reads the
 * conversation and suggests lasting facts about the user as `proposed`
 * memories (decision 0009), which the user keeps or discards. One fast-tier
 * model call and one embedding for each fact, both through the spend guard.
 * Answers { ok, extractedCount, createdCount, skippedCount }.
 */
export async function POST(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "memories.summarize", sameOrigin: true }, async ({ auth, requestId }) => {
    const body = await readJsonBody(request, MAX_CHAT_BODY_BYTES);
    if (!body.ok) return errorResponse(body.status, body.code, body.message, requestId);
    const parsed = summarizeRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(400, "invalid_request", "A conversation ID is required.", requestId);

    // Throws ConfigError (→ 503) when inference is not configured.
    const deps = createAssistantDeps(auth, getAssistantConfig());
    const conversation = await deps.repo.getConversation(auth.userId, parsed.data.conversationId);
    if (!conversation) return errorResponse(404, "not_found", "Conversation not found.", requestId);

    const messages = await deps.repo.listRecentMessages(auth.userId, conversation.id, CONVERSATION_MESSAGE_LIMIT);
    if (messages.length < 2) {
      return jsonResponse({ ok: true, extractedCount: 0, createdCount: 0, skippedCount: 0 }, requestId);
    }
    const lastReply = [...messages].reverse().find((message) => message.role === "assistant");
    const { memories, retrieval, embedder } = deps;
    if (!memories || !retrieval || !embedder) {
      return errorResponse(503, "not_configured", "Memory is not configured on this server.", requestId);
    }

    const result = await summarizeSession(
      { ...deps, memories, retrieval, embedder },
      {
        userId: auth.userId,
        requestId,
        mode: conversation.mode,
        transcript: messages.map(({ role, content }) => ({ role, content })),
        sourceMessageId: lastReply?.id ?? null,
        signal: request.signal,
      },
    );
    return jsonResponse({ ok: true, ...result }, requestId);
  });
}
