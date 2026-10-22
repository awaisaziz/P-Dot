import type { ApiErrorBody, TaskDTO } from "@/types/api";

async function request(path: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, credentials: "same-origin", cache: "no-store" });
  } catch {
    throw new Error("Could not reach the server; check your connection and retry.");
  }
  if (!response.ok) {
    let message = "Something went wrong. Please retry.";
    try {
      const body = (await response.json()) as Partial<ApiErrorBody>;
      if (body.error?.message) message = body.error.message;
    } catch {
      // Non-JSON error response.
    }
    throw new Error(message);
  }
  return response;
}

const jsonHeaders = { "Content-Type": "application/json" };

export async function createTask(title: string): Promise<TaskDTO> {
  const response = await request("/api/tasks", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ title }),
  });
  return (await response.json()) as TaskDTO;
}

export async function updateTask(id: string, changes: { title?: string; done?: boolean }): Promise<TaskDTO> {
  const response = await request(`/api/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify(changes),
  });
  return (await response.json()) as TaskDTO;
}

export async function deleteTask(id: string): Promise<void> {
  await request(`/api/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
}
