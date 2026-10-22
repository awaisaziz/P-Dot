import { z } from "zod";
import { CONVERSATION_MESSAGE_LIMIT, MAX_CHAT_BODY_BYTES } from "@/lib/limits";
import { renameConversationSchema } from "@/lib/schemas";
import type { ConversationDetail, MessageDTO } from "@/types/api";
import type { MessageResultsPayload } from "@/types/workflows";
import { createConversationRepository } from "@/server/db/conversations";
import { createMessageResultsRepository } from "@/server/db/message-results";
import { logEvent } from "@/server/log";
import { readJsonBody } from "@/server/http/request";
import { errorResponse, jsonResponse, notFound } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";

interface Context {
  params: Promise<{ id: string }>;
}

const idSchema = z.uuid();

/**
 * GET /api/conversations/:id — one conversation with its messages. Assistant
 * replies that ran a workflow or read a connector carry their results and
 * steps (decision 0015).
 */
export async function GET(request: Request, context: Context): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "conversations.get" }, async ({ auth, requestId }) => {
    const id = idSchema.safeParse((await context.params).id);
    // Malformed, missing, and other users' IDs all look the same: 404.
    if (!id.success) return notFound(requestId);

    const repo = createConversationRepository(auth.supabase);
    const conversation = await repo.getConversation(auth.userId, id.data);
    if (!conversation) return notFound(requestId);

    const messages = await repo.listRecentMessages(auth.userId, conversation.id, CONVERSATION_MESSAGE_LIMIT);
    const replyIds = messages.filter((message) => message.role === "assistant").map((message) => message.id);
    let stored = new Map<string, MessageResultsPayload>();
    if (replyIds.length > 0) {
      // A missing table is an empty map. Any other failure keeps the replies, which still read
      // correctly with their [n] sources, and only the cards are left out.
      try {
        stored = await createMessageResultsRepository(auth.supabase).listForMessages(auth.userId, replyIds);
      } catch {
        logEvent("warn", "message_results_read_failed", { requestId, route: "conversations.get" });
      }
    }
    const withResults = messages.map((message): MessageDTO => {
      const results = stored.get(message.id);
      return results ? { ...message, results } : message;
    });
    const detail: ConversationDetail = {
      id: conversation.id,
      title: conversation.title,
      mode: conversation.mode,
      messages: withResults,
    };
    return jsonResponse(detail, requestId);
  });
}

/** PATCH /api/conversations/:id — rename a conversation. Body: { title }. */
export async function PATCH(request: Request, context: Context): Promise<Response> {
  return withAuthenticatedRoute(
    request,
    { route: "conversations.rename", sameOrigin: true },
    async ({ auth, requestId }) => {
      const id = idSchema.safeParse((await context.params).id);
      if (!id.success) return notFound(requestId);

      const body = await readJsonBody(request, MAX_CHAT_BODY_BYTES);
      if (!body.ok) return errorResponse(body.status, body.code, body.message, requestId);
      const parsed = renameConversationSchema.safeParse(body.value);
      if (!parsed.success) {
        return errorResponse(400, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid request.", requestId);
      }

      const repo = createConversationRepository(auth.supabase);
      const renamed = await repo.renameConversation(auth.userId, id.data, parsed.data.title);
      if (!renamed) return notFound(requestId);
      return jsonResponse(renamed, requestId);
    },
  );
}

/** DELETE /api/conversations/:id — permanently removes the conversation and its messages. */
export async function DELETE(request: Request, context: Context): Promise<Response> {
  return withAuthenticatedRoute(
    request,
    { route: "conversations.delete", sameOrigin: true },
    async ({ auth, requestId }) => {
      const id = idSchema.safeParse((await context.params).id);
      if (!id.success) return notFound(requestId);

      const repo = createConversationRepository(auth.supabase);
      const deleted = await repo.deleteConversation(auth.userId, id.data);
      if (!deleted) return notFound(requestId);
      return new Response(null, { status: 204, headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } });
    },
  );
}
