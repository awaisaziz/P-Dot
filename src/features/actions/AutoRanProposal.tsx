"use client";

import Link from "next/link";
import { useState } from "react";
import { deleteReminder } from "@/features/reminders/api";
import { deleteTask } from "@/features/today/api";
import { ApiError, errorMessage } from "@/lib/api-client";
import type { ActionProposalDTO } from "@/types/api";
import { KIND_LABELS, KIND_RESULT_LINKS, UNCONFIRMED_HINT, isUnconfirmedDone } from "./format";

type UndoState = "idle" | "busy" | "undone";

/** Removes what an auto-run action created. Only kinds that create something P-Dot owns can be undone. */
async function undo(proposal: ActionProposalDTO): Promise<void> {
  const result = proposal.result ?? {};
  try {
    if (proposal.payload.kind === "create_task" && typeof result.taskId === "string") return await deleteTask(result.taskId);
    if (proposal.payload.kind === "create_reminder" && typeof result.reminderId === "string") {
      return await deleteReminder(result.reminderId);
    }
  } catch (err) {
    // Already gone counts as undone.
    if (err instanceof ApiError && err.status === 404) return;
    throw err;
  }
  throw new Error("This action cannot be undone here.");
}

/**
 * An action P-Dot ran on its own in Auto mode, under the reply that made it.
 * It says so plainly and offers Undo, so Auto never changes things silently.
 */
export function AutoRanProposal({ proposal, running }: { proposal: ActionProposalDTO; running: boolean }) {
  const [state, setState] = useState<UndoState>("idle");
  const [error, setError] = useState<string | null>(null);
  const result = KIND_RESULT_LINKS[proposal.payload.kind];
  const unconfirmed = !running && isUnconfirmedDone(proposal);
  const done = !running && proposal.status === "executed" && !unconfirmed;

  async function onUndo() {
    setState("busy");
    setError(null);
    try {
      await undo(proposal);
      setState("undone");
    } catch (err) {
      setState("idle");
      setError(errorMessage(err, "Could not undo; remove it from the list instead."));
    }
  }

  const pill = running
    ? { label: "Running", className: "status-approved" }
    : state === "undone"
      ? { label: "Undone", className: "status-rejected" }
      : done
        ? { label: "Done on its own", className: "status-executed" }
        : unconfirmed
          ? { label: "Marked done", className: "status-unconfirmed" }
          : { label: "Failed", className: "status-failed" };

  return (
    <li className="past-action auto-action">
      <span className={`status-pill ${pill.className}`}>{pill.label}</span>
      <span className="past-action-body">
        <span className="past-action-summary">{proposal.summary}</span>
        <span className="hint">
          {KIND_LABELS[proposal.payload.kind]} ·{" "}
          {running
            ? "Auto is doing this now."
            : state === "undone"
              ? "Undone and removed."
              : done
                ? "Done on its own because Auto is on."
                : unconfirmed
                  ? UNCONFIRMED_HINT
                  : "Auto tried this, but it could not be completed."}
          {done && state !== "undone" && (
            <>
              {" "}
              <Link href={result.href}>{result.label}</Link>
            </>
          )}
        </span>
        {error && (
          <span className="alert alert-error small" role="alert">
            {error}
          </span>
        )}
      </span>
      {done && state !== "undone" && (
        <button
          type="button"
          className="button button-small auto-undo"
          disabled={state === "busy"}
          aria-label={`Undo: ${proposal.summary}`}
          onClick={() => void onUndo()}
        >
          {state === "busy" ? "Undoing…" : "Undo"}
        </button>
      )}
    </li>
  );
}
