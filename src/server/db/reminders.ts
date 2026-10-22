import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Mode, ReminderDTO, ReminderStatus } from "@/types/api";
import { RepositoryError } from "./conversations";

/**
 * Reminder persistence (decision 0009). As with tasks, every method filters by
 * the authenticated user's ID, and RLS enforces the same rule in the database.
 * Delivery of reminders (scheduled jobs, notifications) is not handled here.
 */
export interface NewReminder {
  mode: Mode;
  title: string;
  /** ISO 8601 date-time with a time zone. */
  dueAt: string;
  /** Set when an approved action proposal created this reminder. */
  proposalId?: string | null;
}

export interface ReminderChanges {
  title?: string;
  dueAt?: string;
  status?: ReminderStatus;
}

export interface ReminderRepository {
  /** Soonest first. `mode`, when given, keeps only the rows saved with it (decision 0014: the app passes none). */
  listReminders(userId: string, limit: number, mode?: Mode): Promise<ReminderDTO[]>;
  /** Returns null when no reminder with that ID belongs to the user. */
  getReminder(userId: string, reminderId: string): Promise<ReminderDTO | null>;
  createReminder(userId: string, reminder: NewReminder): Promise<ReminderDTO>;
  /** Returns null when no reminder with that ID belongs to the user. */
  updateReminder(userId: string, reminderId: string, changes: ReminderChanges): Promise<ReminderDTO | null>;
  /** Returns false when no reminder with that ID belongs to the user. */
  deleteReminder(userId: string, reminderId: string): Promise<boolean>;
}

const reminderRow = z.object({
  id: z.string(),
  mode: z.enum(["personal", "work"]),
  title: z.string(),
  due_at: z.string(),
  status: z.enum(["scheduled", "done", "cancelled"]),
  proposal_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const REMINDER_COLUMNS = "id, mode, title, due_at, status, proposal_id, created_at, updated_at";

function toReminder(row: unknown): ReminderDTO {
  const parsed = reminderRow.parse(row);
  return {
    id: parsed.id,
    mode: parsed.mode,
    title: parsed.title,
    dueAt: parsed.due_at,
    status: parsed.status,
    proposalId: parsed.proposal_id,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
  };
}

export function createReminderRepository(supabase: SupabaseClient): ReminderRepository {
  const getReminder = async (userId: string, reminderId: string): Promise<ReminderDTO | null> => {
    const { data, error } = await supabase
      .from("reminders")
      .select(REMINDER_COLUMNS)
      .eq("id", reminderId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw new RepositoryError("getReminder");
    return data ? toReminder(data) : null;
  };

  return {
    async listReminders(userId, limit, mode) {
      let query = supabase.from("reminders").select(REMINDER_COLUMNS).eq("user_id", userId);
      if (mode) query = query.eq("mode", mode);
      const { data, error } = await query.order("due_at", { ascending: true }).limit(limit);
      if (error) throw new RepositoryError("listReminders");
      return (data ?? []).map(toReminder);
    },

    getReminder,

    async createReminder(userId, reminder) {
      const { data, error } = await supabase
        .from("reminders")
        .insert({
          user_id: userId,
          mode: reminder.mode,
          title: reminder.title,
          due_at: reminder.dueAt,
          proposal_id: reminder.proposalId ?? null,
        })
        .select(REMINDER_COLUMNS)
        .single();
      if (error || !data) throw new RepositoryError("createReminder");
      return toReminder(data);
    },

    async updateReminder(userId, reminderId, changes) {
      const patch: Record<string, string> = {};
      if (changes.title !== undefined) patch.title = changes.title;
      if (changes.dueAt !== undefined) patch.due_at = changes.dueAt;
      if (changes.status !== undefined) patch.status = changes.status;

      // An empty update would send an UPDATE with no columns, so read the row instead.
      if (Object.keys(patch).length === 0) return getReminder(userId, reminderId);

      const { data, error } = await supabase
        .from("reminders")
        .update(patch)
        .eq("id", reminderId)
        .eq("user_id", userId)
        .select(REMINDER_COLUMNS)
        .maybeSingle();
      if (error) throw new RepositoryError("updateReminder");
      return data ? toReminder(data) : null;
    },

    async deleteReminder(userId, reminderId) {
      const { count, error } = await supabase
        .from("reminders")
        .delete({ count: "exact" })
        .eq("id", reminderId)
        .eq("user_id", userId);
      if (error) throw new RepositoryError("deleteReminder");
      return (count ?? 0) > 0;
    },
  };
}
