// Display helpers for action proposals and the action log. Pure functions, so they are unit-tested.
import type {
  ActionKind,
  ActionLogEntryDTO,
  ActionLogEvent,
  ActionPayload,
  ActionProposalDTO,
  ActionStatus,
} from "@/types/api";

export const KIND_LABELS: Record<ActionKind, string> = {
  create_task: "Add a task",
  create_reminder: "Set a reminder",
  save_memory: "Remember something",
};

/** Where the result of an executed action can be seen. */
export const KIND_RESULT_LINKS: Record<ActionKind, { href: string; label: string }> = {
  create_task: { href: "/today", label: "Open your to-do list" },
  create_reminder: { href: "/workflows", label: "Open your reminders" },
  save_memory: { href: "/memory", label: "Open what P-Dot remembers" },
};

/**
 * Said next to an action that is marked done but that the database did not
 * confirm: decide_action_proposal did not decide it (decision 0009). Older
 * history, or an outcome a caller wrote, looks like this.
 */
export const UNCONFIRMED_HINT = "P-Dot did not confirm this action.";

/**
 * In Auto: why a proposal from a reply that read web pages or Google still
 * waits. Such a reply is tainted, so Auto runs nothing for it (decision 0015).
 */
export const TAINTED_ASK_REASON = "This reply read web pages or your Google data, so it waits for your OK.";

/** True when a proposal is marked done but the database did not confirm it. */
export function isUnconfirmedDone(proposal: Pick<ActionProposalDTO, "status" | "verified">): boolean {
  return proposal.status === "executed" && proposal.verified !== true;
}

export interface PastProposalView {
  label: string;
  /** CSS class of the status pill. */
  pill: string;
  note: string;
  /** Show the link to where the result can be seen. Only for a confirmed result. */
  showResult: boolean;
}

// "Approved" rather than "you approved": until the server records who decided (decision 0011),
// an approval made by Auto mode looks the same as one made with a click.
const PAST: Record<Exclude<ActionStatus, "proposed">, PastProposalView> = {
  approved: { label: "Running", pill: "status-approved", note: "Approved, still running.", showResult: false },
  executed: { label: "Done", pill: "status-executed", note: "Approved and done.", showResult: true },
  rejected: { label: "Cancelled", pill: "status-rejected", note: "Cancelled; nothing changed.", showResult: false },
  failed: { label: "Failed", pill: "status-failed", note: "Approved, but it could not be completed.", showResult: false },
};

const UNCONFIRMED_PAST: PastProposalView = {
  label: "Marked done",
  pill: "status-unconfirmed",
  note: UNCONFIRMED_HINT,
  showResult: false,
};

/** How chat shows a decided proposal. A done action that the database did not confirm is "Marked done". */
export function pastProposalView(proposal: ActionProposalDTO): PastProposalView | null {
  if (proposal.status === "proposed") return null;
  return isUnconfirmedDone(proposal) ? UNCONFIRMED_PAST : PAST[proposal.status];
}

/**
 * The fields that will be used when the action runs, as label/value pairs. Built from the payload, never the summary.
 * The payload's `mode` is not shown: there is one workspace (decision 0014).
 */
export function payloadDetails(payload: ActionPayload, formatDate: (iso: string) => string): [string, string][] {
  switch (payload.kind) {
    case "create_task":
      return [["Task", payload.title]];
    case "create_reminder":
      return [["Reminder", payload.title], ["Due", formatDate(payload.dueAt)]];
    case "save_memory":
      return [["Memory", payload.content]];
  }
}

export interface ProposalFilter {
  /** Only proposals from this conversation (chat). */
  conversationId?: string;
}

export function matchesFilter(proposal: ActionProposalDTO, filter: ProposalFilter): boolean {
  return filter.conversationId === undefined || proposal.conversationId === filter.conversationId;
}

/**
 * What an approval list shows: proposals still waiting, plus the ones decided
 * in this view so their outcome stays visible.
 */
export function visibleProposals(
  proposals: ActionProposalDTO[],
  filter: ProposalFilter,
  decidedHere: ReadonlySet<string>,
): ActionProposalDTO[] {
  return proposals.filter((p) => matchesFilter(p, filter) && (p.status === "proposed" || decidedHere.has(p.id)));
}

/** The value for an `<input type="datetime-local">`, in the browser's time zone. Empty when the date is invalid. */
export function toLocalInputValue(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

/** An ISO 8601 date-time (UTC) from a datetime-local value, read in the browser's time zone. Null when invalid. */
export function fromLocalInputValue(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const EVENT_LABELS: Record<ActionLogEvent, string> = {
  proposed: "P-Dot proposed an action",
  approved: "You approved an action",
  rejected: "You cancelled an action",
  executed: "Action completed",
  failed: "Action failed",
  memory_added: "Memory added",
  memory_edited: "Memory changed",
  memory_deleted: "Memory deleted",
  document_added: "Document added",
  document_ready: "Document ready to search",
  document_failed: "Document could not be processed",
  document_deleted: "Document deleted",
  reminder_added: "Reminder added",
  reminder_changed: "Reminder changed",
  reminder_deleted: "Reminder deleted",
  connector_added: "Connected Google",
  connector_removed: "Disconnected Google",
  connector_changed: "Google access changed",
};

const KIND_NOUNS: Record<string, string> = {
  create_task: "Task",
  create_reminder: "Reminder",
  save_memory: "Memory",
};

const STATUS_WORDS: Record<string, string> = {
  scheduled: "Scheduled",
  done: "Marked done",
  cancelled: "Cancelled",
  proposed: "Waiting for approval",
  active: "Active",
  processing: "Processing",
  needs_reconnect: "Needs reconnecting",
};

export type LogTone = "neutral" | "success" | "warning" | "danger";

export interface LogEntryView {
  title: string;
  /** Short facts from the entry's detail. IDs are left out. */
  facts: string[];
  tone: LogTone;
}

/** Turns a log entry into words. Unknown events and detail keys are shown generically, never dropped silently. */
export function describeLogEntry(entry: ActionLogEntryDTO): LogEntryView {
  const detail = entry.detail;
  const facts: string[] = [];
  if (typeof detail.kind === "string") facts.push(KIND_NOUNS[detail.kind] ?? detail.kind);
  if (detail.source === "assistant") facts.push("Suggested by P-Dot");
  if (detail.source === "user") facts.push("Added by you");
  if (typeof detail.status === "string") facts.push(STATUS_WORDS[detail.status] ?? detail.status);
  if (typeof detail.chunkCount === "number") {
    facts.push(`${detail.chunkCount} searchable ${detail.chunkCount === 1 ? "part" : "parts"}`);
  }
  if (typeof detail.scopeCount === "number") {
    facts.push(`${detail.scopeCount} ${detail.scopeCount === 1 ? "permission" : "permissions"}`);
  }
  if (detail.edited === true) facts.push("Edited before approval");
  if (typeof detail.error === "string") facts.push("Could not be completed");

  // Only a row the database wrote for a confirmed outcome says "completed".
  if (entry.event === "executed" && entry.verified !== true) {
    return { title: "Marked as completed", facts: [...facts, UNCONFIRMED_HINT], tone: "neutral" };
  }

  const tone: LogTone =
    entry.event === "executed"
      ? "success"
      : entry.event === "failed" || entry.event === "document_failed"
        ? "danger"
        : entry.event === "proposed" || (entry.event === "connector_changed" && detail.status === "needs_reconnect")
          ? "warning"
          : "neutral";

  return { title: EVENT_LABELS[entry.event] ?? entry.event.replaceAll("_", " "), facts, tone };
}
