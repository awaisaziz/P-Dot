"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { formatLocal } from "@/components/ui/LocalTime";
import { ApiError, errorMessage } from "@/lib/api-client";
import { MAX_MEMORY_CHARS, MAX_REMINDER_TITLE_CHARS, MAX_TASK_CHARS } from "@/lib/limits";
import type { ActionPayload, ActionProposalDTO, Mode } from "@/types/api";
import { decideAction } from "./api";
import {
  KIND_LABELS,
  KIND_RESULT_LINKS,
  UNCONFIRMED_HINT,
  fromLocalInputValue,
  isUnconfirmedDone,
  payloadDetails,
  toLocalInputValue,
} from "./format";

interface Draft {
  /** Kept from the payload unchanged; the card never shows it (decision 0014). */
  mode: Mode;
  /** Task or reminder title, or memory text. */
  text: string;
  /** datetime-local value; reminders only. */
  due: string;
}

function draftFrom(payload: ActionPayload): Draft {
  return {
    mode: payload.mode,
    text: payload.kind === "save_memory" ? payload.content : payload.title,
    due: payload.kind === "create_reminder" ? toLocalInputValue(payload.dueAt) : "",
  };
}

function payloadFrom(kind: ActionPayload["kind"], draft: Draft): ActionPayload | string {
  const text = draft.text.trim();
  if (!text) return "This field cannot be empty.";
  switch (kind) {
    case "create_task":
      return { kind, mode: draft.mode, title: text };
    case "save_memory":
      return { kind, mode: draft.mode, content: text };
    case "create_reminder": {
      const dueAt = fromLocalInputValue(draft.due);
      return dueAt ? { kind, mode: draft.mode, title: text, dueAt } : "Choose a date and time.";
    }
  }
}

const TEXT_LIMITS: Record<ActionPayload["kind"], number> = {
  create_task: MAX_TASK_CHARS,
  create_reminder: MAX_REMINDER_TITLE_CHARS,
  save_memory: MAX_MEMORY_CHARS,
};

const TEXT_LABELS: Record<ActionPayload["kind"], string> = {
  create_task: "Task",
  create_reminder: "Reminder",
  save_memory: "What to remember",
};

/**
 * One action P-Dot proposed. Nothing runs until the user presses Approve.
 * The details shown come from the stored payload, which is what will run;
 * the one-line summary is written by the assistant and is shown as its words.
 */
export function ApprovalCard({
  proposal,
  onDecided,
  onStale,
  onUnauthorized,
  askReason,
}: {
  proposal: ActionProposalDTO;
  onDecided: (updated: ActionProposalDTO) => void;
  /** Called when the server's copy changed (already decided, or the run failed), so the list can reload. */
  onStale?: () => void;
  onUnauthorized?: () => void;
  /** In Auto mode: why this action still waits for the user. */
  askReason?: string;
}) {
  const id = useId();
  const kind = proposal.payload.kind;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(proposal.payload));
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The stored proposal never changes, so an edited approval is remembered here to show what actually ran.
  const [approvedEdit, setApprovedEdit] = useState<ActionPayload | null>(null);
  const waiting = proposal.status === "proposed";
  const shownPayload = approvedEdit ?? proposal.payload;

  async function decide(decision: "approve" | "reject", payload?: ActionPayload) {
    setBusy(decision);
    setError(null);
    try {
      const updated = await decideAction(proposal.id, decision, payload);
      if (payload) setApprovedEdit(payload);
      onDecided(updated);
      setEditing(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onUnauthorized?.();
        return;
      }
      if (err instanceof ApiError && err.status === 409) {
        setError("This action was already decided, perhaps in another tab.");
        onStale?.();
      } else if (err instanceof ApiError && err.status === 404) {
        setError("This action no longer exists.");
      } else if (err instanceof ApiError && err.status >= 500) {
        // The decision was recorded; the run itself failed. Reload to show the stored status.
        setError(errorMessage(err, "The action could not be completed."));
        onStale?.();
      } else {
        setError(errorMessage(err, "Could not send your decision; please retry."));
      }
    } finally {
      setBusy(null);
    }
  }

  function submitEdit(event: React.FormEvent) {
    event.preventDefault();
    const payload = payloadFrom(kind, draft);
    if (typeof payload === "string") {
      setError(payload);
      return;
    }
    void decide("approve", payload);
  }

  const unconfirmed = isUnconfirmedDone(proposal);
  const statusLabel = unconfirmed
    ? "Marked done"
    : {
        proposed: "Needs your OK",
        approved: "Running…",
        rejected: "Cancelled",
        executed: "Done",
        failed: "Failed",
      }[proposal.status];
  const pillClass = unconfirmed ? "status-unconfirmed" : `status-${proposal.status}`;
  const detailsLabel = waiting
    ? "What will happen"
    : proposal.status === "executed" && !unconfirmed
      ? "What was done"
      : "What was proposed";

  return (
    <article className={`approval-card approval-${proposal.status}`} aria-labelledby={`${id}-title`}>
      <div className="approval-head">
        <span className="approval-kind">{KIND_LABELS[kind]}</span>
        <span className={`status-pill ${pillClass}`}>{statusLabel}</span>
      </div>
      <p id={`${id}-title`} className="approval-summary">
        {proposal.summary}
      </p>
      {approvedEdit && (
        <p className="hint">You edited this before approving; the details below are what ran.</p>
      )}
      {waiting && askReason && (
        <p className="approval-ask-reason small">
          <strong>Asks even in Auto:</strong> {askReason}
        </p>
      )}

      {editing ? (
        <form className="approval-edit stack" onSubmit={submitEdit}>
          <div className="field">
            <label htmlFor={`${id}-text`}>{TEXT_LABELS[kind]}</label>
            {kind === "save_memory" ? (
              <textarea
                id={`${id}-text`}
                className="form-control"
                rows={3}
                value={draft.text}
                maxLength={TEXT_LIMITS[kind]}
                autoFocus
                onChange={(event) => setDraft({ ...draft, text: event.target.value })}
              />
            ) : (
              <input
                id={`${id}-text`}
                className="form-control"
                type="text"
                value={draft.text}
                maxLength={TEXT_LIMITS[kind]}
                autoFocus
                onChange={(event) => setDraft({ ...draft, text: event.target.value })}
              />
            )}
          </div>
          {kind === "create_reminder" && (
            <div className="field">
              <label htmlFor={`${id}-due`}>Due</label>
              <input
                id={`${id}-due`}
                className="form-control"
                type="datetime-local"
                value={draft.due}
                onChange={(event) => setDraft({ ...draft, due: event.target.value })}
              />
            </div>
          )}
          <div className="actions">
            <button type="submit" className="button button-primary button-small" disabled={busy !== null}>
              {busy === "approve" ? "Approving…" : "Approve with changes"}
            </button>
            <button
              type="button"
              className="button button-small"
              disabled={busy !== null}
              onClick={() => {
                setDraft(draftFrom(proposal.payload));
                setEditing(false);
                setError(null);
              }}
            >
              Discard changes
            </button>
          </div>
        </form>
      ) : (
        <dl className="approval-details" aria-label={detailsLabel}>
          {payloadDetails(shownPayload, (iso) => formatLocal(iso)).map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}

      {waiting && !editing && (
        <div className="actions">
          <button
            type="button"
            className="button button-primary button-small"
            disabled={busy !== null}
            onClick={() => void decide("approve")}
          >
            {busy === "approve" ? "Approving…" : "Approve"}
          </button>
          <button type="button" className="button button-small" disabled={busy !== null} onClick={() => setEditing(true)}>
            Edit
          </button>
          <button
            type="button"
            className="button button-small"
            disabled={busy !== null}
            aria-label="Cancel this action"
            onClick={() => void decide("reject")}
          >
            {busy === "reject" ? "Cancelling…" : "Cancel"}
          </button>
        </div>
      )}

      {unconfirmed && <p className="approval-outcome small muted">Marked done; {UNCONFIRMED_HINT}</p>}
      {proposal.status === "executed" && !unconfirmed && (
        <p className="approval-outcome small">
          {approvedEdit ? "Done, with your changes. " : "Done. "}
          <Link href={KIND_RESULT_LINKS[kind].href}>{KIND_RESULT_LINKS[kind].label}</Link>
        </p>
      )}
      {proposal.status === "rejected" && <p className="approval-outcome small muted">Cancelled; nothing changed.</p>}
      {proposal.status === "failed" && (
        <p className="alert alert-error small" role="alert">
          Could not be completed; nothing else changed.
        </p>
      )}
      {/* A failed run is already explained above; other errors (a lost connection, a decision made elsewhere) are not. */}
      {error && proposal.status !== "failed" && (
        <p className="alert alert-error small" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
