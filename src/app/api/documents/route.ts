import {
  DOCUMENT_LIST_LIMIT,
  DOCUMENT_PROCESSING_STALE_MS,
  MAX_DOCUMENT_BODY_BYTES,
  STALE_DOCUMENT_SETTLE_LIMIT,
} from "@/lib/limits";
import { WORKSPACE_MODE } from "@/lib/mode";
import { createDocumentSchema } from "@/lib/schemas";
import { budgetRefusal, NebiusHoldTooLargeError } from "@/server/assistant/spend";
import { chunkText } from "@/server/assistant/chunk";
import { createEmbedderForRequest } from "@/server/assistant/deps";
import { EmbeddingBudgetError } from "@/server/assistant/embed";
import { getAssistantConfig } from "@/server/config";
import { createDocumentRepository } from "@/server/db/documents";
import { readJsonBody } from "@/server/http/request";
import { errorResponse, jsonResponse } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";
import { logEvent } from "@/server/log";
import { ProviderError } from "@/server/providers/errors";

/**
 * GET /api/documents. Lists every document of the signed-in user; a `?mode=`
 * from an older tab is ignored (decision 0014). First it settles the user's stale "processing" documents (an upload that stopped
 * before its final status write). If that fails, the list is still returned.
 */
export async function GET(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "documents.list" }, async ({ auth, requestId }) => {
    const repository = createDocumentRepository(auth.supabase);
    const staleBefore = new Date(Date.now() - DOCUMENT_PROCESSING_STALE_MS);
    await repository.settleStaleDocuments(auth.userId, staleBefore, STALE_DOCUMENT_SETTLE_LIMIT).catch(() => {
      logEvent("warn", "documents_settle_failed", { requestId, route: "documents.list" });
    });

    const documents = await repository.listDocuments(auth.userId, DOCUMENT_LIST_LIMIT);
    return jsonResponse({ documents }, requestId);
  });
}

/**
 * POST /api/documents uploads plain text or Markdown. Body: { title, mediaType, text, mode? };
 * a sent mode is ignored and the document gets WORKSPACE_MODE (decision 0014).
 * The text is split into chunks, embedded and stored. The document is "ready"
 * only when every step worked; otherwise it is "failed".
 */
export async function POST(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "documents.create", sameOrigin: true }, async ({ auth, requestId }) => {
    const body = await readJsonBody(request, MAX_DOCUMENT_BODY_BYTES);
    if (!body.ok) return errorResponse(body.status, body.code, body.message, requestId);
    const parsed = createDocumentSchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(400, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid request.", requestId);
    }
    const { title, mediaType, text } = parsed.data;

    // Read the config first: a missing key must fail before any document exists.
    const config = getAssistantConfig();
    const embedder = createEmbedderForRequest(auth, config);
    const documents = createDocumentRepository(auth.supabase);
    const document = await documents.createDocument(auth.userId, {
      mode: WORKSPACE_MODE,
      title,
      mediaType,
      charCount: text.length,
    });

    try {
      const chunks = chunkText(text);
      const vectors = await embedder.embed(chunks);
      if (vectors.length !== chunks.length) throw new ProviderError("nebius", "bad_response");
      await documents.insertChunks(
        auth.userId,
        document.id,
        chunks.map((content, index) => ({ index, content, embedding: vectors[index]! })),
      );
      await documents.setStatus(auth.userId, document.id, "ready");
    } catch (error) {
      // Mark the document failed. If that write also fails, log it and keep the first error for the user.
      // The document then stays "processing"; a later GET /api/documents settles it.
      await documents.setStatus(auth.userId, document.id, "failed").catch(() => {
        logEvent("warn", "document_status_write_failed", {
          requestId,
          route: "documents.create",
          documentId: document.id,
        });
      });

      if (error instanceof EmbeddingBudgetError) {
        const refusal = budgetRefusal(error.limit, new Date());
        return errorResponse(refusal.status, refusal.code, refusal.message, requestId, refusal.headers);
      }
      if (error instanceof NebiusHoldTooLargeError) {
        return errorResponse(413, "payload_too_large", "The document is too large to process.", requestId);
      }
      if (error instanceof ProviderError) {
        return errorResponse(
          502,
          "provider_unavailable",
          "The document could not be processed. Please retry.",
          requestId,
        );
      }
      throw error;
    }

    return jsonResponse({ ...document, status: "ready" }, requestId, { status: 201 });
  });
}
