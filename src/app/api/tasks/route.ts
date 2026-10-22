import { MAX_CHAT_BODY_BYTES, TASK_LIST_LIMIT } from "@/lib/limits";
import { WORKSPACE_MODE } from "@/lib/mode";
import { createTaskSchema } from "@/lib/schemas";
import { createTaskRepository } from "@/server/db/tasks";
import { readJsonBody } from "@/server/http/request";
import { errorResponse, jsonResponse } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";

/** GET /api/tasks: every task of the signed-in user. A `?mode=` from an older tab is ignored (decision 0014). */
export async function GET(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "tasks.list" }, async ({ auth, requestId }) => {
    const tasks = await createTaskRepository(auth.supabase).listTasks(auth.userId, TASK_LIST_LIMIT);
    return jsonResponse({ tasks }, requestId);
  });
}

/** POST /api/tasks — add a task. Body: { title, mode? }; a sent mode is ignored and the task gets WORKSPACE_MODE (decision 0014). */
export async function POST(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "tasks.create", sameOrigin: true }, async ({ auth, requestId }) => {
    const body = await readJsonBody(request, MAX_CHAT_BODY_BYTES);
    if (!body.ok) return errorResponse(body.status, body.code, body.message, requestId);
    const parsed = createTaskSchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(400, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid request.", requestId);
    }

    const task = await createTaskRepository(auth.supabase).createTask(auth.userId, WORKSPACE_MODE, parsed.data.title);
    return jsonResponse(task, requestId, { status: 201 });
  });
}
