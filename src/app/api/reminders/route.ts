import { MAX_CHAT_BODY_BYTES, REMINDER_LIST_LIMIT } from "@/lib/limits";
import { WORKSPACE_MODE } from "@/lib/mode";
import { createReminderSchema } from "@/lib/schemas";
import { createReminderRepository } from "@/server/db/reminders";
import { readJsonBody } from "@/server/http/request";
import { errorResponse, jsonResponse } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";

/**
 * GET /api/reminders — every reminder of the signed-in user, soonest first. A
 * `?mode=` from an older tab is ignored (decision 0014).
 */
export async function GET(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "reminders.list" }, async ({ auth, requestId }) => {
    const reminders = await createReminderRepository(auth.supabase).listReminders(auth.userId, REMINDER_LIST_LIMIT);
    return jsonResponse({ reminders }, requestId);
  });
}

/** POST /api/reminders — add a reminder. Body: { title, dueAt, mode? }; a sent mode is ignored and it gets WORKSPACE_MODE. */
export async function POST(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "reminders.create", sameOrigin: true }, async ({ auth, requestId }) => {
    const body = await readJsonBody(request, MAX_CHAT_BODY_BYTES);
    if (!body.ok) return errorResponse(body.status, body.code, body.message, requestId);
    const parsed = createReminderSchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(400, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid request.", requestId);
    }

    const reminder = await createReminderRepository(auth.supabase).createReminder(auth.userId, {
      title: parsed.data.title,
      dueAt: parsed.data.dueAt,
      mode: WORKSPACE_MODE,
    });
    return jsonResponse(reminder, requestId, { status: 201 });
  });
}
