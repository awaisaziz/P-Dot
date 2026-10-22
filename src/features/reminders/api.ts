import { deleteResource, sendJson } from "@/lib/api-client";
import type { ReminderDTO, ReminderStatus } from "@/types/api";

export async function createReminder(title: string, dueAt: string): Promise<ReminderDTO> {
  return sendJson<ReminderDTO>("/api/reminders", "POST", { title, dueAt });
}

export async function updateReminder(
  id: string,
  changes: { title?: string; dueAt?: string; status?: ReminderStatus },
): Promise<ReminderDTO> {
  return sendJson<ReminderDTO>(`/api/reminders/${encodeURIComponent(id)}`, "PATCH", changes);
}

export async function deleteReminder(id: string): Promise<void> {
  await deleteResource(`/api/reminders/${encodeURIComponent(id)}`);
}
