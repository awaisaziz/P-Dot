"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { ApiError } from "@/lib/api-client";
import { MAX_MEMORY_CHARS } from "@/lib/limits";
import type { MemoryDTO } from "@/types/api";
import { deleteMemory, memoryErrorMessage, updateMemory } from "./api";
import type { MemorySuggestion } from "./useMemorySuggestions";

const PILLS = {
  waiting: { label: "Suggestion", className: "status-proposed" },
  kept: { label: "Kept", className: "status-executed" },
  dropped: { label: "Not kept", className: "status-rejected" },
} as const;

/**
 * A memory P-Dot suggested, shown in the chat under the reply it came from.
 * It is not used until the user keeps it; "Don't keep" deletes it.
 */
export function MemorySuggestionCard({
  suggestion,
  onKept,
  onDropped,
  onUnauthorized,
  askReason,
}: {
  suggestion: MemorySuggestion;
  onKept: (memory: MemoryDTO) => void;
  onDropped: (memory: MemoryDTO) => void;
  onUnauthorized?: () => void;
  /** In Auto mode: why this still waits for the user. */
  askReason?: string;
}) {
  const id = useId();
  const { memory, outcome } = suggestion;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(memory.content);
  const [busy, setBusy] = useState<"keep" | "drop" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(kind: "keep" | "drop", work: () => Promise<void>, fallback: string) {
    setBusy(kind);
    setError(null);
    try {
      await work();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onUnauthorized?.();
      else if (err instanceof ApiError && err.status === 404) setError("This suggestion no longer exists.");
      else setError(memoryErrorMessage(err, fallback));
    } finally {
      setBusy(null);
    }
  }

  const keep = (content?: string) =>
    run(
      "keep",
      async () => {
        // Changed text is saved in the same request, so the memory is never kept with the old words.
        const changed = content !== undefined && content !== memory.content;
        onKept(await updateMemory(memory.id, changed ? { content, status: "active" } : { status: "active" }));
        setEditing(false);
      },
      "Could not keep this memory.",
    );

  const drop = () =>
    run(
      "drop",
      async () => {
        try {
          await deleteMemory(memory.id);
        } catch (err) {
          // Already gone counts as not kept.
          if (!(err instanceof ApiError && err.status === 404)) throw err;
        }
        onDropped(memory);
      },
      "Could not remove this suggestion.",
    );

  const cancelEdit = () => {
    setText(memory.content);
    setEditing(false);
    setError(null);
  };

  const pill = PILLS[outcome];
  return (
    <article
      className={`approval-card memory-suggestion${outcome === "waiting" ? " approval-proposed" : ""}`}
      aria-labelledby={`${id}-title`}
    >
      <div className="approval-head">
        <span id={`${id}-title`} className="approval-kind">
          Remember this?
        </span>
        <span className={`status-pill ${pill.className}`}>{pill.label}</span>
      </div>

      {editing ? (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            const content = text.trim();
            if (content) void keep(content);
          }}
        >
          <label htmlFor={`${id}-text`} className="visually-hidden">
            What P-Dot should remember
          </label>
          <textarea
            id={`${id}-text`}
            className="form-control"
            rows={2}
            value={text}
            maxLength={MAX_MEMORY_CHARS}
            autoFocus
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => event.key === "Escape" && cancelEdit()}
          />
          <div className="actions">
            <button type="submit" className="button button-primary button-small" disabled={busy !== null || !text.trim()}>
              {busy === "keep" ? "Keeping…" : "Keep with changes"}
            </button>
            <button type="button" className="button button-small" disabled={busy !== null} onClick={cancelEdit}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <p className="memory-text">{memory.content}</p>
      )}

      {outcome === "waiting" && !editing && (
        <>
          <p className="hint">Suggested memory; not used until you keep it.</p>
          {askReason && (
            <p className="approval-ask-reason small">
              <strong>Asks even in Auto:</strong> {askReason}
            </p>
          )}
          <div className="actions">
            <button
              type="button"
              className="button button-primary button-small"
              disabled={busy !== null}
              onClick={() => void keep()}
            >
              {busy === "keep" ? "Keeping…" : "Keep"}
            </button>
            <button type="button" className="button button-small" disabled={busy !== null} onClick={() => setEditing(true)}>
              Edit
            </button>
            <button
              type="button"
              className="button button-small"
              disabled={busy !== null}
              aria-label="Don't keep this suggestion"
              onClick={() => void drop()}
            >
              {busy === "drop" ? "Removing…" : "Don't keep"}
            </button>
          </div>
        </>
      )}

      {outcome === "kept" && (
        <p className="approval-outcome small">
          Kept. <Link href="/memory">Open what P-Dot remembers</Link>
        </p>
      )}
      {outcome === "dropped" && <p className="approval-outcome small muted">Not kept; the suggestion was deleted.</p>}
      {error && (
        <p className="alert alert-error small" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
