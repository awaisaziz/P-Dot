"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { LocalTime } from "@/components/ui/LocalTime";
import { ApiError } from "@/lib/api-client";
import { MAX_MEMORY_CHARS } from "@/lib/limits";
import type { MemoryDTO } from "@/types/api";
import { createMemory, deleteMemory, memoryErrorMessage as friendlyError, updateMemory } from "./api";

/**
 * Everything P-Dot remembers: memories the user added, and ones P-Dot
 * suggested. A suggestion is not used until the user keeps it.
 */
export function MemoryList({ initialMemories }: { initialMemories: MemoryDTO[] }) {
  const router = useRouter();
  const [memories, setMemories] = useState(initialMemories);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  const onError = (err: unknown, fallback: string) => {
    if (err instanceof ApiError && err.status === 401) {
      router.replace("/login?next=/memory");
      return;
    }
    setError(friendlyError(err, fallback));
  };

  async function add(event: React.FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || adding) return;
    setAdding(true);
    setError(null);
    try {
      const memory = await createMemory(content);
      setMemories((list) => [memory, ...list]);
      setDraft("");
      setStatus("Memory saved.");
    } catch (err) {
      onError(err, "Could not save the memory.");
    } finally {
      setAdding(false);
    }
  }

  function replace(updated: MemoryDTO) {
    setMemories((list) => list.map((m) => (m.id === updated.id ? updated : m)));
  }

  function remove(id: string) {
    setMemories((list) => list.filter((m) => m.id !== id));
  }

  const needle = filter.trim().toLowerCase();
  const shown = needle ? memories.filter((m) => m.content.toLowerCase().includes(needle)) : memories;
  const proposed = shown.filter((m) => m.status === "proposed");
  const active = shown.filter((m) => m.status === "active");

  return (
    <div className="stack">
      <form className="panel" onSubmit={(event) => void add(event)} aria-labelledby="add-memory-heading">
        <h2 id="add-memory-heading">Add a memory</h2>
        <div className="field">
          <label htmlFor="new-memory">Something P-Dot should know about you</label>
          <textarea
            id="new-memory"
            className="form-control"
            rows={2}
            value={draft}
            maxLength={MAX_MEMORY_CHARS}
            placeholder="For example: I'm vegetarian."
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>
        <div className="actions">
          <button type="submit" className="button button-primary" disabled={adding || !draft.trim()}>
            {adding ? "Saving…" : "Save memory"}
          </button>
          <span className="hint">Saving sends the text to Nebius once to index it.</span>
        </div>
      </form>

      {error && (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      )}

      {memories.length > 5 && (
        <div className="field">
          <label htmlFor="memory-filter">Filter memories</label>
          <input
            id="memory-filter"
            className="form-control"
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
      )}

      {proposed.length > 0 && (
        <section className="panel" aria-labelledby="proposed-heading">
          <div className="panel-heading">
            <h2 id="proposed-heading">Suggested by P-Dot</h2>
            <span className="status-pill status-proposed">{proposed.length} waiting</span>
          </div>
          <p className="muted small">These are not used until you keep them.</p>
          <ul className="memory-list">
            {proposed.map((memory) => (
              <MemoryItem
                key={memory.id}
                memory={memory}
                onChanged={replace}
                onDeleted={remove}
                onError={onError}
                onStatus={setStatus}
              />
            ))}
          </ul>
        </section>
      )}

      <section className="panel" aria-labelledby="active-heading">
        <div className="panel-heading">
          <h2 id="active-heading">Remembered</h2>
          <span className="muted small">
            {active.length === 0 ? "Nothing yet" : `${active.length} ${active.length === 1 ? "memory" : "memories"}`}
          </span>
        </div>
        {active.length === 0 && (
          <p className="muted">
            {needle ? "No memories match the filter." : "P-Dot remembers nothing yet."}
          </p>
        )}
        <ul className="memory-list">
          {active.map((memory) => (
            <MemoryItem
              key={memory.id}
              memory={memory}
              onChanged={replace}
              onDeleted={remove}
              onError={onError}
              onStatus={setStatus}
            />
          ))}
        </ul>
      </section>

      <p className="visually-hidden" role="status" aria-live="polite">
        {status}
      </p>
    </div>
  );
}

function MemoryItem({
  memory,
  onChanged,
  onDeleted,
  onError,
  onStatus,
}: {
  memory: MemoryDTO;
  onChanged: (memory: MemoryDTO) => void;
  onDeleted: (id: string) => void;
  onError: (err: unknown, fallback: string) => void;
  onStatus: (text: string) => void;
}) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(memory.content);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(work: () => Promise<void>, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      // Shown next to this memory; a lost session is handled by the list.
      if (err instanceof ApiError && err.status === 401) onError(err, fallback);
      else setError(friendlyError(err, fallback));
    } finally {
      setBusy(false);
    }
  }

  const cancelEdit = () => {
    setText(memory.content);
    setEditing(false);
    setError(null);
  };

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    const content = text.trim();
    if (!content) return;
    if (content === memory.content) {
      setEditing(false);
      return;
    }
    void run(async () => {
      onChanged(await updateMemory(memory.id, { content }));
      setEditing(false);
      onStatus("Memory updated.");
    }, "Could not update the memory.");
  };

  const keep = () =>
    void run(async () => {
      onChanged(await updateMemory(memory.id, { status: "active" }));
      onStatus("Memory kept.");
    }, "Could not keep the memory.");

  const destroy = () =>
    void run(async () => {
      try {
        await deleteMemory(memory.id);
      } catch (err) {
        // Already gone counts as deleted.
        if (!(err instanceof ApiError && err.status === 404)) throw err;
      }
      onDeleted(memory.id);
      onStatus("Memory deleted.");
    }, "Could not delete the memory.");

  return (
    <li className="memory-item">
      {editing ? (
        <form className="stack" onSubmit={save}>
          <label htmlFor={`${id}-edit`} className="visually-hidden">
            Memory text
          </label>
          <textarea
            id={`${id}-edit`}
            className="form-control"
            rows={2}
            value={text}
            maxLength={MAX_MEMORY_CHARS}
            autoFocus
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => event.key === "Escape" && cancelEdit()}
          />
          <div className="actions">
            <button type="submit" className="button button-primary button-small" disabled={busy || !text.trim()}>
              {busy ? "Saving…" : "Save"}
            </button>
            <button type="button" className="button button-small" disabled={busy} onClick={cancelEdit}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <p className="memory-text">{memory.content}</p>
          <p className="hint">
            {memory.source === "assistant" ? "Suggested by P-Dot" : "Added by you"} ·{" "}
            <LocalTime iso={memory.updatedAt} style="date" />
          </p>
          {confirmDelete ? (
            <div className="actions" role="group" aria-label="Delete this memory?">
              <span className="small">Delete this memory? Its text goes at once.</span>
              <button type="button" className="button button-danger button-small" disabled={busy} onClick={destroy}>
                {busy ? "Deleting…" : "Delete"}
              </button>
              <button type="button" className="button button-small" disabled={busy} onClick={() => setConfirmDelete(false)}>
                Keep it
              </button>
            </div>
          ) : (
            <div className="actions">
              {memory.status === "proposed" && (
                <button type="button" className="button button-primary button-small" disabled={busy} onClick={keep}>
                  Keep
                </button>
              )}
              <button type="button" className="button button-small" disabled={busy} onClick={() => setEditing(true)}>
                Edit
              </button>
              <button
                type="button"
                className="button button-small button-danger"
                disabled={busy}
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </button>
            </div>
          )}
        </>
      )}
      {error && (
        <p className="alert alert-error small" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}
