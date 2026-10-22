import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Mode, TaskDTO } from "@/types/api";
import { RepositoryError } from "./conversations";

/**
 * To-do list persistence. As with conversations, every method filters by the
 * authenticated user's ID and RLS enforces the same rule in the database.
 */
export interface TaskRepository {
  /** Oldest first. `mode`, when given, keeps only the rows saved with it (decision 0014: the app passes none). */
  listTasks(userId: string, limit: number, mode?: Mode): Promise<TaskDTO[]>;
  createTask(userId: string, mode: Mode, title: string): Promise<TaskDTO>;
  /** Returns null when no task with that ID belongs to the user. */
  updateTask(userId: string, taskId: string, changes: { title?: string; done?: boolean }): Promise<TaskDTO | null>;
  /** Returns false when no task with that ID belongs to the user. */
  deleteTask(userId: string, taskId: string): Promise<boolean>;
}

const taskRow = z.object({
  id: z.string(),
  mode: z.enum(["personal", "work"]),
  title: z.string(),
  done: z.boolean(),
  created_at: z.string(),
});

const TASK_COLUMNS = "id, mode, title, done, created_at";

function toTask(row: unknown): TaskDTO {
  const parsed = taskRow.parse(row);
  return { id: parsed.id, mode: parsed.mode, title: parsed.title, done: parsed.done, createdAt: parsed.created_at };
}

export function createTaskRepository(supabase: SupabaseClient): TaskRepository {
  return {
    async listTasks(userId, limit, mode) {
      let query = supabase.from("tasks").select(TASK_COLUMNS).eq("user_id", userId);
      if (mode) query = query.eq("mode", mode);
      const { data, error } = await query.order("created_at", { ascending: true }).limit(limit);
      if (error) throw new RepositoryError("listTasks");
      return (data ?? []).map(toTask);
    },

    async createTask(userId, mode, title) {
      const { data, error } = await supabase
        .from("tasks")
        .insert({ user_id: userId, mode, title })
        .select(TASK_COLUMNS)
        .single();
      if (error || !data) throw new RepositoryError("createTask");
      return toTask(data);
    },

    async updateTask(userId, taskId, changes) {
      const { data, error } = await supabase
        .from("tasks")
        .update(changes)
        .eq("id", taskId)
        .eq("user_id", userId)
        .select(TASK_COLUMNS)
        .maybeSingle();
      if (error) throw new RepositoryError("updateTask");
      return data ? toTask(data) : null;
    },

    async deleteTask(userId, taskId) {
      const { count, error } = await supabase
        .from("tasks")
        .delete({ count: "exact" })
        .eq("id", taskId)
        .eq("user_id", userId);
      if (error) throw new RepositoryError("deleteTask");
      return (count ?? 0) > 0;
    },
  };
}
