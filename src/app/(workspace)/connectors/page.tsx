import type { Metadata } from "next";
import { ConnectorDirectory, type BuiltInConnector, type DirectoryNotice } from "@/features/connectors/ConnectorDirectory";
import { builtInStatus } from "@/features/connectors/status";
import { DOCUMENT_LIST_LIMIT, MEMORY_LIST_LIMIT, REMINDER_LIST_LIMIT, TASK_LIST_LIMIT } from "@/lib/limits";
import { requireAuth, type AuthContext } from "@/server/auth/session";
import { getConnectorConfig, isConnectorUserAllowed, type ConnectorConfig } from "@/server/connectors/config";
import { toConnectorGrantDTO } from "@/server/connectors/route-helpers";
import { createConnectorGrantRepository } from "@/server/db/connector-grants";
import { createDocumentRepository } from "@/server/db/documents";
import { createMemoryRepository } from "@/server/db/memories";
import { createReminderRepository } from "@/server/db/reminders";
import { createTaskRepository } from "@/server/db/tasks";
import { logEvent } from "@/server/log";
import { CONNECTOR_ERROR_MESSAGES, isConnectorErrorCode, type ConnectorsResponse } from "@/types/connectors";

export const metadata: Metadata = { title: "Connectors · P-Dot" };

/** Reads the user's lists and turns them into status lines, as of the time of the request. */
async function loadBuiltInStatus(auth: AuthContext) {
  const [tasks, reminders, memories, documents] = await Promise.all([
    createTaskRepository(auth.supabase).listTasks(auth.userId, TASK_LIST_LIMIT),
    createReminderRepository(auth.supabase).listReminders(auth.userId, REMINDER_LIST_LIMIT),
    createMemoryRepository(auth.supabase).listMemories(auth.userId, undefined, MEMORY_LIST_LIMIT),
    createDocumentRepository(auth.supabase).listDocuments(auth.userId, DOCUMENT_LIST_LIMIT),
  ]);
  return builtInStatus(
    { tasks, reminders, memories, documents },
    { tasks: TASK_LIST_LIMIT, reminders: REMINDER_LIST_LIMIT, memories: MEMORY_LIST_LIMIT, documents: DOCUMENT_LIST_LIMIT },
    Date.now(),
  );
}

/**
 * The same answer as GET /api/connectors, read here so the page needs no
 * second request. Null when it could not be read; the page then offers Retry
 * and never shows a product as connected.
 */
async function loadGoogle(auth: AuthContext): Promise<ConnectorsResponse | null> {
  let config: ConnectorConfig | null;
  try {
    config = getConnectorConfig();
  } catch {
    // A malformed setting (ConfigError) reads as "not set up"; the API route reports it as 503.
    logEvent("warn", "connectors_page_config_invalid", { route: "connectors.page" });
    config = null;
  }
  try {
    const grant = await createConnectorGrantRepository(auth.supabase).getGrant(auth.userId, "google");
    return {
      google: grant ? toConnectorGrantDTO(grant) : null,
      available: config !== null,
      allowed: config !== null && isConnectorUserAllowed(config, auth.userId),
    };
  } catch {
    logEvent("warn", "connectors_page_grant_failed", { route: "connectors.page" });
    return null;
  }
}

/**
 * One line from the OAuth callback's redirect: ?connected=google or ?error=<code> from the closed set.
 * The success line needs a stored, active grant, so a typed URL cannot show it.
 */
function noticeFrom(
  params: { connected?: string | string[]; error?: string | string[] },
  google: ConnectorsResponse | null,
): DirectoryNotice | null {
  if (params.connected === "google") {
    return google?.google?.status === "active" ? { tone: "success", text: "Google is connected." } : null;
  }
  if (isConnectorErrorCode(params.error)) return { tone: "error", text: CONNECTOR_ERROR_MESSAGES[params.error] };
  return null;
}

interface ConnectorsPageProps {
  searchParams: Promise<{ connected?: string | string[]; error?: string | string[] }>;
}

export default async function ConnectorsPage({ searchParams }: ConnectorsPageProps) {
  const auth = await requireAuth("/connectors");
  const [status, google, params] = await Promise.all([loadBuiltInStatus(auth), loadGoogle(auth), searchParams]);

  // P-Dot's own lists and files. The first three are the only things an approved action can change (decision 0009).
  const builtIn: BuiltInConnector[] = [
    { icon: "tasks", name: "To-do list", description: "Adds the tasks you approve.", status: status.tasks, href: "/today", link: "Open to-do list" },
    { icon: "reminders", name: "Reminders", description: "Sets the reminders you approve.", status: status.reminders, href: "/workflows", link: "Open reminders" },
    { icon: "memory", name: "Memory", description: "Remembers what you approve and uses it in replies.", status: status.memory, href: "/memory", link: "Open memory" },
    {
      icon: "documents",
      name: "Documents",
      description: "Searches the text and Markdown files you add.",
      status: status.documents,
      href: "/memory#documents",
      link: "Open documents",
    },
  ];

  return (
    <main className="page page-wide stack">
      <div className="page-intro">
        <h1>Connectors</h1>
        <p className="muted">Connect accounts so P-Dot can read them when you turn them on; it asks before anything else.</p>
      </div>

      <ConnectorDirectory initialGoogle={google} builtIn={builtIn} initialNotice={noticeFrom(params, google)} />
    </main>
  );
}
