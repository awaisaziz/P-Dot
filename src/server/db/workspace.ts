import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { WORKSPACE_MODE } from "@/lib/mode";
import { actionPayloadSchema } from "@/lib/schemas";
import { logEvent } from "@/server/log";
import type { ActionPayload } from "@/types/api";
import { RepositoryError } from "./conversations";

/** The tables that kept a `mode` column after decision 0014. */
const MODE_TABLES = ["conversations", "tasks", "memories", "documents", "reminders"] as const;

/**
 * How many of the user's rows were saved in Work mode, for the one-time
 * "now one workspace" notice on Today (decision 0014). Head-only counts, so no
 * row is read. Any error answers 0: the notice must never break the page.
 */
export async function countWorkModeRows(supabase: SupabaseClient, userId: string): Promise<number> {
  try {
    const counts = await Promise.all(
      MODE_TABLES.map(async (table) => {
        const { count, error } = await supabase
          .from(table)
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("mode", "work");
        if (error || typeof count !== "number") throw new Error(`count failed: ${table}`);
        return count;
      }),
    );
    return counts.reduce((sum, count) => sum + count, 0);
  } catch {
    logEvent("warn", "work_mode_count_failed", { route: "today" });
    return 0;
  }
}

/**
 * For an approval without an edit (decision 0014): the stored payload of the
 * user's proposal with mode set to WORKSPACE_MODE, when it was saved with
 * another mode. Null when there is nothing to change: no such proposal, one
 * that is already decided, a payload that does not parse or names another
 * kind (the database then answers as before), or a payload that already has
 * WORKSPACE_MODE. Throws RepositoryError when the read fails.
 */
export async function workspacePayloadFor(
  supabase: SupabaseClient,
  userId: string,
  proposalId: string,
): Promise<ActionPayload | null> {
  const { data, error } = await supabase
    .from("action_proposals")
    .select("kind, status, payload")
    .eq("id", proposalId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new RepositoryError("readProposalPayload");
  if (!data || data.status !== "proposed") return null;
  const payload = actionPayloadSchema.safeParse(data.payload);
  if (!payload.success || payload.data.kind !== data.kind || payload.data.mode === WORKSPACE_MODE) return null;
  return { ...payload.data, mode: WORKSPACE_MODE };
}
