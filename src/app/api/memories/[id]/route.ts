import { z } from "zod";
import { MAX_CHAT_BODY_BYTES } from "@/lib/limits";
import { updateMemorySchema } from "@/lib/schemas";
import { createMemoryRepository } from "@/server/db/memories";
import { readJsonBody } from "@/server/http/request";
import { errorResponse, jsonResponse } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";
import { embedMemoryText } from "@/server/memories/embedding";

interface Context {
  params: Promise<{ id: string }>;
}

const idSchema = z.uuid();

const memoryNotFound = (requestId: string) => errorResponse(404, "not_found", "Memory not found.", requestId);

/**
 * PATCH /api/memories/:id: edit the text or approve a proposed memory. A sent
 * mode is ignored (decision 0014), so a body with only a mode changes nothing.
 */
export async function PATCH(request: Request, context: Context): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "memories.update", sameOrigin: true }, async ({ auth, requestId }) => {
    const id = idSchema.safeParse((await context.params).id);
    if (!id.success) return memoryNotFound(requestId);

    const body = await readJsonBody(request, MAX_CHAT_BODY_BYTES);
    if (!body.ok) return errorResponse(body.status, body.code, body.message, requestId);
    const parsed = updateMemorySchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(400, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid request.", requestId);
    }

    // Read the user's row first. A missing or foreign ID gets 404 before any
    // embedder work, so it cannot use provider spend or budget.
    const memories = createMemoryRepository(auth.supabase);
    const existing = await memories.getMemory(auth.userId, id.data);
    if (!existing) return memoryNotFound(requestId);

    // Only a changed text needs a new vector. The same text is not written at
    // all, so it cannot put old text back next to a newer text's vector. A
    // status change keeps the stored vector and model. The mode is never written.
    const changes: { content?: string; status?: "active" } = {};
    if (parsed.data.content !== undefined && parsed.data.content !== existing.content) changes.content = parsed.data.content;
    if (parsed.data.status !== undefined) changes.status = parsed.data.status;
    if (changes.content === undefined && changes.status === undefined) return jsonResponse(existing, requestId);
    const embedding = changes.content === undefined ? undefined : await embedMemoryText(auth, requestId, changes.content);

    // The update applies only while the text is still the one read above.
    // If another edit came first, the client reloads instead.
    const memory = await memories.updateMemory(auth.userId, id.data, changes, embedding, existing.content);
    if (!memory) {
      if (!(await memories.getMemory(auth.userId, id.data))) return memoryNotFound(requestId);
      return errorResponse(409, "conflict", "This memory changed. Reload it and try again.", requestId);
    }

    return jsonResponse(memory, requestId);
  });
}

/** DELETE /api/memories/:id: remove a memory and its vector. */
export async function DELETE(request: Request, context: Context): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "memories.delete", sameOrigin: true }, async ({ auth, requestId }) => {
    const id = idSchema.safeParse((await context.params).id);
    if (!id.success) return memoryNotFound(requestId);

    // The database writes the action log row for the delete.
    const deleted = await createMemoryRepository(auth.supabase).deleteMemory(auth.userId, id.data);
    if (!deleted) return memoryNotFound(requestId);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } });
  });
}
