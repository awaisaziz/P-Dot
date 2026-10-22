import type { Metadata } from "next";
import Link from "next/link";
import { ApprovalList } from "@/features/actions/ApprovalList";
import { starterHref, todayStarters } from "@/features/chat/starters";
import { ComingUp } from "@/features/today/ComingUp";
import { comingUpVisible } from "@/features/today/coming-up";
import { TaskList } from "@/features/today/TaskList";
import { WorkspaceMergedNotice } from "@/features/today/WorkspaceMergedNotice";
import { ACTION_LIST_LIMIT, TASK_LIST_LIMIT } from "@/lib/limits";
import { requireAuth } from "@/server/auth/session";
import { getConnectorConfig, isConnectorUserAllowed, type ConnectorConfig } from "@/server/connectors/config";
import { createActionProposalRepository } from "@/server/db/action-proposals";
import { createTaskRepository } from "@/server/db/tasks";
import { countWorkModeRows } from "@/server/db/workspace";
import { logEvent } from "@/server/log";
import type { ConnectorsResponse } from "@/types/connectors";

export const metadata: Metadata = { title: "Today · P-Dot" };

/** Whether Google can be used here, as GET /api/connectors would say. A malformed setting reads as "not set up". */
function googleHere(userId: string): Pick<ConnectorsResponse, "available" | "allowed"> {
  let config: ConnectorConfig | null;
  try {
    config = getConnectorConfig();
  } catch {
    logEvent("warn", "today_page_config_invalid", { route: "today.page" });
    config = null;
  }
  return { available: config !== null, allowed: config !== null && isConnectorUserAllowed(config, userId) };
}

export default async function TodayPage() {
  const auth = await requireAuth("/today");
  const [tasks, proposals, workModeRows] = await Promise.all([
    createTaskRepository(auth.supabase).listTasks(auth.userId, TASK_LIST_LIMIT),
    createActionProposalRepository(auth.supabase).listProposals(auth.userId, undefined, ACTION_LIST_LIMIT),
    // Never rejects: an error counts as 0 and hides the notice.
    countWorkModeRows(auth.supabase, auth.userId),
  ]);
  // Previews and users not on the allow list cannot connect, so they get no panel with a Connect link.
  const showComingUp = comingUpVisible(googleHere(auth.userId));
  // Things to try in chat. Each opens the chat with its prompt in the message box; the user sends it.
  // The calendar one follows the same check, so it never leads where Google cannot be used.
  const starters = todayStarters(showComingUp);

  return (
    <main className="page page-wide stack">
      <div className="page-title">
        <div className="page-intro">
          <h1>Your day</h1>
          <p className="muted">Your calendar, to-dos and approvals in one place.</p>
        </div>
        <Link className="button button-primary" href="/chat">
          Ask P-Dot
        </Link>
      </div>

      <WorkspaceMergedNotice count={workModeRows} />

      <div className="two-column">
        <div className="stack">
          {showComingUp && <ComingUp />}
          <TaskList initialTasks={tasks} />
        </div>

        <aside className="stack">
          <ApprovalList initial={proposals} />
          <section className="panel" aria-labelledby="start-heading">
            <h2 id="start-heading">Start something</h2>
            <ul className="today-starter-list">
              {starters.map((starter) => (
                <li key={starter.title}>
                  <Link className="today-starter" href={starterHref(starter.prompt)}>
                    <span className="today-starter-title">{starter.title}</span>
                    <span className="today-starter-example">{starter.example}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </main>
  );
}
