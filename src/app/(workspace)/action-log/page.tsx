import type { Metadata } from "next";
import { ActionLogList } from "@/features/actions/ActionLogList";
import { ACTION_LOG_LIMIT } from "@/lib/limits";
import { requireAuth } from "@/server/auth/session";
import { createActionLogRepository } from "@/server/db/action-log";

export const metadata: Metadata = { title: "Action log · P-Dot" };

export default async function ActionLogPage() {
  const auth = await requireAuth("/action-log");
  const entries = await createActionLogRepository(auth.supabase).list(auth.userId, ACTION_LOG_LIMIT);

  return (
    <main className="page stack">
      <div className="page-intro">
        <h1>Action log</h1>
        <p className="muted">A permanent record of every proposal, decision, run, Google connection and change to your data.</p>
      </div>

      <ActionLogList initialEntries={entries} limit={ACTION_LOG_LIMIT} />

      <p className="hint">Kinds, counts and IDs only, never your text; to-dos you add yourself are not logged.</p>
    </main>
  );
}
