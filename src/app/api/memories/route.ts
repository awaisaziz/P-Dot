import { z } from "zod";
import { MAX_CHAT_BODY_BYTES, MEMORY_LIST_LIMIT } from "@/lib/limits";
import { WORKSPACE_MODE } from "@/lib/mode";
import { createMemorySchema } from "@/lib/schemas";
import { createMemoryRepository } from "@/server/db/memories";
import { readJsonBody } from "@/server/http/request";
import { errorResponse, jsonResponse } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";
import { embedMemoryText } from "@/server/memories/embedding";
import type { MemoryStatus } from "@/types/api";

const statusFilterSchema = z.enum(["proposed", "active"]);

/**
 * GET /api/memories?status=proposed|active: every memory of the user. A `?mode=`
 * from an older tab is ignored (decision 0014).
 */
export async function GET(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "memories.list" }, async ({ auth, requestId }) => {
    const params = new URL(request.url).searchParams;

    // The status filter is optional. When it is sent, it must be a valid value.
    let status: MemoryStatus | undefined;
    const rawStatus = params.get("status");
    if (rawStatus !== null) {
      const parsed = statusFilterSchema.safeParse(rawStatus);
      if (!parsed.success) {
        return errorResponse(400, "invalid_request", "Choose a status: proposed or active.", requestId);
      }
      status = parsed.data;
    }

    const memories = await createMemoryRepository(auth.supabase).listMemories(auth.userId, status, MEMORY_LIST_LIMIT);
    return jsonResponse({ memories }, requestId);
  });
}

/** POST /api/memories: save a memory the user typed. Body: { content, mode? }; a sent mode is ignored and it gets WORKSPACE_MODE. */
export async function POST(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "memories.create", sameOrigin: true }, async ({ auth, requestId }) => {
    const body = await readJsonBody(request, MAX_CHAT_BODY_BYTES);
    if (!body.ok) return errorResponse(body.status, body.code, body.message, requestId);
    const parsed = createMemorySchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(400, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid request.", requestId);
    }

    const embedding = await embedMemoryText(auth, requestId, parsed.data.content);
    const memory = await createMemoryRepository(auth.supabase).createMemory(
      auth.userId,
      {
        mode: WORKSPACE_MODE,
        content: parsed.data.content,
        status: "active",
        source: "user",
        sourceMessageId: null,
      },
      embedding,
    );
    return jsonResponse(memory, requestId, { status: 201 });
  });
}
