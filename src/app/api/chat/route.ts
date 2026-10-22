import { MAX_CHAT_BODY_BYTES } from "@/lib/limits";
import { chatRequestSchema } from "@/lib/schemas";
import { createAssistantDeps } from "@/server/assistant/deps";
import { prepareChatTurn, streamChatTurn } from "@/server/assistant/service";
import { getAssistantConfig } from "@/server/config";
import { toNdjsonStream } from "@/server/http/ndjson";
import { readJsonBody } from "@/server/http/request";
import { errorResponse } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";

/**
 * The longest a reply may run on Vercel (decision 0017). Tool calls, a flight
 * check and the heavy tier can take minutes; 300 seconds is the Hobby maximum
 * with Fluid compute. Cloudflare Workers ignore it.
 */
export const maxDuration = 300;

/**
 * POST /api/chat — send a message (or retry the latest unanswered one) and
 * stream the assistant's reply as NDJSON. See ChatStreamEvent in src/types/api.ts.
 */
export async function POST(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "chat", sameOrigin: true }, async ({ auth, requestId }) => {
    const body = await readJsonBody(request, MAX_CHAT_BODY_BYTES);
    if (!body.ok) return errorResponse(body.status, body.code, body.message, requestId);

    const parsed = chatRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      const messageIssue = parsed.error.issues.find((issue) => issue.path[0] === "message");
      return errorResponse(400, "invalid_request", messageIssue?.message ?? "Invalid request.", requestId);
    }

    // Throws ConfigError (→ 503) when inference is not configured.
    const deps = createAssistantDeps(auth, getAssistantConfig());
    const prepared = await prepareChatTurn(deps, {
      userId: auth.userId,
      requestId,
      request: parsed.data,
    });
    if (!prepared.ok) {
      return errorResponse(prepared.status, prepared.code, prepared.message, requestId, prepared.headers);
    }

    return new Response(toNdjsonStream(streamChatTurn(deps, prepared.turn, request.signal)), {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
        "X-Request-Id": requestId,
      },
    });
  });
}
