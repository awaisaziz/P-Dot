import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { logEvent } from "@/server/log";
import type { ActionLogEntryDTO, ActionLogEvent } from "@/types/api";
import { RepositoryError } from "./conversations";

/**
 * The action log (decision 0009). Read-only for the app: database triggers on
 * memories, documents, reminders and action proposals write every row, and
 * users cannot insert, change or delete one. The detail holds IDs, kinds,
 * modes, counts and flags, never message or memory text.
 */
export interface ActionLogRepository {
  /** Newest first. A row that does not parse is left out, so one bad row cannot break the page. */
  list(userId: string, limit: number): Promise<ActionLogEntryDTO[]>;
}

const ACTION_LOG_EVENTS = [
  "proposed",
  "approved",
  "rejected",
  "executed",
  "failed",
  "memory_added",
  "memory_edited",
  "memory_deleted",
  "document_added",
  "document_ready",
  "document_failed",
  "document_deleted",
  "reminder_added",
  "reminder_changed",
  "reminder_deleted",
  "connector_added",
  "connector_removed",
  "connector_changed",
] as const satisfies readonly ActionLogEvent[];

const logRow = z.object({
  id: z.string(),
  proposal_id: z.string().nullable(),
  event: z.enum(ACTION_LOG_EVENTS),
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  created_at: z.string(),
  verified: z.boolean().optional(),
});

const rowId = z.object({ id: z.string() });

function toEntry(row: unknown): ActionLogEntryDTO | null {
  const parsed = logRow.safeParse(row);
  if (!parsed.success) {
    // The ID only. Never the detail.
    const id = rowId.safeParse(row);
    logEvent("warn", "action_log_row_skipped", { entryId: id.success ? id.data.id : null });
    return null;
  }
  const r = parsed.data;
  return {
    id: r.id,
    proposalId: r.proposal_id,
    event: r.event,
    detail: r.detail,
    createdAt: r.created_at,
    verified: r.verified === true,
  };
}

export function createActionLogRepository(supabase: SupabaseClient): ActionLogRepository {
  return {
    async list(userId, limit) {
      const { data, error } = await supabase
        .from("action_log")
        .select("id, proposal_id, event, detail, created_at, verified")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw new RepositoryError("listActionLog");
      return (data ?? []).map(toEntry).filter((entry): entry is ActionLogEntryDTO => entry !== null);
    },
  };
}
