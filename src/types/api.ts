// Contracts shared by the browser and the API routes. No secrets or server-only types here.
import type { Effort, MessageRoute, ModelTier, RouteReason } from "@/lib/routing";

export type { Effort, MessageRoute, ModelTier, RouteReason } from "@/lib/routing";

export type MessageRole = "user" | "assistant";

/** Which side of life a conversation or task belongs to. */
export type Mode = "personal" | "work";

/** Outcome of web search for an assistant reply. */
export type WebSearchStatus = "off" | "used" | "no_results" | "failed";

export interface SourceRef {
  title: string;
  url: string;
}

export interface MessageDTO {
  id: string;
  role: MessageRole;
  content: string;
  webSearch: WebSearchStatus;
  sources: SourceRef[];
  /** Which model answered and why. Null for user messages and replies saved before routing. */
  route: MessageRoute | null;
  createdAt: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  mode: Mode;
  updatedAt: string;
}

export interface TaskDTO {
  id: string;
  mode: Mode;
  title: string;
  done: boolean;
  createdAt: string;
}

export interface ConversationDetail {
  id: string;
  title: string;
  mode: Mode;
  messages: MessageDTO[];
}

export type ApiErrorCode =
  | "unauthorized"
  | "forbidden"
  | "invalid_request"
  | "unsupported_media_type"
  | "payload_too_large"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "budget_exhausted"
  | "not_configured"
  | "provider_unavailable"
  | "provider_timeout"
  | "provider_rate_limited"
  | "internal_error";

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    requestId: string;
  };
}

/** Request body for POST /api/chat. */
export type ChatRequest =
  | { action: "send"; conversationId?: string; mode?: Mode; message: string; webSearch: boolean; effort?: Effort }
  | { action: "retry"; conversationId: string; webSearch: boolean; effort?: Effort };

/**
 * POST /api/chat responds with newline-delimited JSON (one event per line) once
 * the request has been accepted. Failures before that point use a normal JSON
 * error response with an HTTP error status.
 */
export type ChatStreamEvent =
  | {
      type: "start";
      requestId: string;
      conversation: ConversationSummary;
      userMessage: MessageDTO;
      /** The tier chosen for this reply. The model is known only at `done`. */
      route: { tier: ModelTier; reason: RouteReason };
    }
  | {
      type: "search";
      status: Exclude<WebSearchStatus, "off">;
      sources: SourceRef[];
      message?: string;
    }
  | { type: "delta"; text: string }
  /**
   * The assistant is about to use a tool. `text` is what it said before the
   * tool call (its plan) or a short description of the call. The browser shows
   * it as a status line and clears the partial reply; nothing of it is saved.
   */
  | { type: "thought"; text: string }
  /** The conversation got a title from its first exchange. Sent before `done`. */
  | { type: "title"; title: string }
  | { type: "done"; message: MessageDTO; truncated: boolean }
  | { type: "error"; code: ApiErrorCode; message: string; retryable: boolean };

// ---------------------------------------------------------------------------
// Memory, documents, action proposals, the action log, reminders and context
// records. Decision 0009.
// ---------------------------------------------------------------------------

/** "proposed": suggested by the assistant, waiting for the user. "active": used in replies. */
export type MemoryStatus = "proposed" | "active";
export type MemorySource = "user" | "assistant";

export interface MemoryDTO {
  id: string;
  mode: Mode;
  content: string;
  status: MemoryStatus;
  source: MemorySource;
  /** The message the memory came from, if it still exists. */
  sourceMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type DocumentMediaType = "text/plain" | "text/markdown";
export type DocumentStatus = "processing" | "ready" | "failed";

export interface DocumentDTO {
  id: string;
  mode: Mode;
  title: string;
  mediaType: DocumentMediaType;
  charCount: number;
  status: DocumentStatus;
  createdAt: string;
}

/** Actions the assistant may propose. None of them changes an outside account. */
export type ActionKind = "create_task" | "create_reminder" | "save_memory";
export type ActionStatus = "proposed" | "approved" | "rejected" | "executed" | "failed";

export type ActionPayload =
  | { kind: "create_task"; mode: Mode; title: string }
  | { kind: "create_reminder"; mode: Mode; title: string; dueAt: string }
  | { kind: "save_memory"; mode: Mode; content: string };

export interface ActionProposalDTO {
  id: string;
  conversationId: string | null;
  payload: ActionPayload;
  /** One plain sentence for the approval card, for example "Add task: Pay the invoice". */
  summary: string;
  status: ActionStatus;
  /**
   * What execution produced: the new row's ID, for example { "taskId": "..." },
   * or { "error": "execution_failed", "code": "<SQLSTATE>" }. Null until
   * executed or failed. Only the database writes it.
   */
  result: Record<string, string | number | boolean | null> | null;
  createdAt: string;
  decidedAt: string | null;
  /**
   * True only when the database function decide_action_proposal decided this
   * proposal, so `status` and `result` are a record of what the database ran.
   * False for a proposal decided by other writes (older code, or a user
   * during the expand step) and for older rows: their outcome is only what a
   * caller wrote. The screens show these as "Marked done".
   */
  verified: boolean;
}

/** Written only by database triggers (decision 0009). Keep in step with the `event` check in the migration. */
export type ActionLogEvent =
  | "proposed"
  | "approved"
  | "rejected"
  | "executed"
  | "failed"
  | "memory_added"
  | "memory_edited"
  | "memory_deleted"
  | "document_added"
  | "document_ready"
  | "document_failed"
  | "document_deleted"
  | "reminder_added"
  | "reminder_changed"
  | "reminder_deleted";

export interface ActionLogEntryDTO {
  id: string;
  proposalId: string | null;
  event: ActionLogEvent;
  /** IDs, kinds, modes, counts and flags only. Never message or memory text. Strings are at most 64 characters. */
  detail: Record<string, string | number | boolean | null>;
  createdAt: string;
  /**
   * True only for a row that the database log triggers wrote; for an action
   * outcome, only when decide_action_proposal decided it. False for a row an
   * app or a user inserted, and for older rows. A caller cannot set it.
   */
  verified: boolean;
}

export type ReminderStatus = "scheduled" | "done" | "cancelled";

export interface ReminderDTO {
  id: string;
  mode: Mode;
  title: string;
  dueAt: string;
  status: ReminderStatus;
  proposalId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * "What was sent" for one assistant reply. The app writes this record with the
 * user's own session, so it is the user's own record of what the app sent. It
 * is not proof that a model received that context.
 */
export interface ContextRecordDTO {
  messageId: string;
  model: string;
  historyMessageCount: number;
  historyChars: number;
  /** Memories used, with their current text. A deleted memory has content null. */
  memories: { id: string; content: string | null }[];
  /** Document chunks used, with the document title. A deleted chunk has title null. */
  documentChunks: { id: string; documentId: string | null; title: string | null }[];
  webSourceCount: number;
  promptVersion: string;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: string;
}
