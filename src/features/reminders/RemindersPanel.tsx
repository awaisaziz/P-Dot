"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LocalTime, useNow } from "@/components/ui/LocalTime";
import { fromLocalInputValue } from "@/features/actions/format";
import { ApiError, errorMessage } from "@/lib/api-client";
import { MAX_REMINDER_TITLE_CHARS } from "@/lib/limits";
import type { ReminderDTO } from "@/types/api";
import { createReminder, deleteReminder, updateReminder } from "./api";

function byDue(a: ReminderDTO, b: ReminderDTO) {
  return a.dueAt.localeCompare(b.dueAt);
}

/** Reminders: add, mark done, delete. P-Dot does not deliver them yet. */
export function RemindersPanel({ initialReminders }: { initialReminders: ReminderDTO[] }) {
  const router = useRouter();
  const [reminders, setReminders] = useState(initialReminders);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function fail(err: unknown, fallback: string) {
    if (err instanceof ApiError && err.status === 401) router.replace("/login?next=/workflows");
    else setError(errorMessage(err, fallback));
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    const text = title.trim();
    const dueAt = fromLocalInputValue(due);
    if (!text || adding) return;
    if (!dueAt) {
      setError("Choose a date and time.");
      return;
    }
    setAdding(true);
    setError(null);
    try {
      const reminder = await createReminder(text, dueAt);
      setReminders((list) => [...list, reminder].sort(byDue));
      setTitle("");
      setDue("");
    } catch (err) {
      fail(err, "Could not add the reminder.");
    } finally {
      setAdding(false);
    }
  }

  async function setStatus(reminder: ReminderDTO, status: ReminderDTO["status"]) {
    setBusyId(reminder.id);
    setError(null);
    try {
      const updated = await updateReminder(reminder.id, { status });
      setReminders((list) => list.map((r) => (r.id === updated.id ? updated : r)));
    } catch (err) {
      fail(err, "Could not update the reminder.");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(reminder: ReminderDTO) {
    setBusyId(reminder.id);
    setError(null);
    try {
      await deleteReminder(reminder.id);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) {
        fail(err, "Could not delete the reminder.");
        setBusyId(null);
        return;
      }
    }
    setReminders((list) => list.filter((r) => r.id !== reminder.id));
    setConfirmId(null);
    setBusyId(null);
  }

  const scheduled = reminders.filter((r) => r.status === "scheduled");
  const finished = reminders.filter((r) => r.status !== "scheduled");
  // "Overdue" depends on the viewer's clock, so it is shown only after hydration.
  const now = useNow();

  const item = (reminder: ReminderDTO) => {
    const overdue = now !== null && reminder.status === "scheduled" && Date.parse(reminder.dueAt) < now;
    return (
      <li key={reminder.id} className="reminder-item">
        <div className="reminder-body">
          <span className={reminder.status === "scheduled" ? undefined : "task-done"}>{reminder.title}</span>
          <span className="hint">
            <LocalTime iso={reminder.dueAt} />
            {overdue && <span className="status-pill status-failed reminder-flag">Overdue</span>}
            {reminder.status === "cancelled" && " · Cancelled"}
            {reminder.proposalId && " · Added from an approved proposal"}
          </span>
        </div>
        {confirmId === reminder.id ? (
          <div className="actions" role="group" aria-label={`Delete reminder “${reminder.title}”?`}>
            <button
              type="button"
              className="button button-danger button-small"
              disabled={busyId === reminder.id}
              onClick={() => void remove(reminder)}
            >
              Delete
            </button>
            <button type="button" className="button button-small" onClick={() => setConfirmId(null)}>
              Keep
            </button>
          </div>
        ) : (
          <div className="actions">
            {reminder.status === "scheduled" ? (
              <button
                type="button"
                className="button button-small"
                disabled={busyId === reminder.id}
                onClick={() => void setStatus(reminder, "done")}
              >
                Done
              </button>
            ) : (
              <button
                type="button"
                className="button button-small"
                disabled={busyId === reminder.id}
                onClick={() => void setStatus(reminder, "scheduled")}
              >
                Reopen
              </button>
            )}
            <button
              type="button"
              className="icon-button icon-button-danger"
              aria-label={`Delete reminder “${reminder.title}”`}
              onClick={() => setConfirmId(reminder.id)}
            >
              ×
            </button>
          </div>
        )}
      </li>
    );
  };

  return (
    <section className="panel" aria-labelledby="reminders-heading">
      <div className="panel-heading">
        <h2 id="reminders-heading">Reminders</h2>
        <span className="status-pill status-executed">Live</span>
      </div>
      <p className="muted small">Saved here; P-Dot cannot notify you when one is due yet.</p>

      {scheduled.length === 0 && <p className="muted">No upcoming reminders.</p>}
      <ul className="reminder-list">{scheduled.map(item)}</ul>

      <form className="reminder-form" onSubmit={(event) => void add(event)}>
        <div className="field">
          <label htmlFor="reminder-title">Remind me to</label>
          <input
            id="reminder-title"
            className="form-control"
            type="text"
            value={title}
            maxLength={MAX_REMINDER_TITLE_CHARS}
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="reminder-due">When</label>
          <input
            id="reminder-due"
            className="form-control"
            type="datetime-local"
            value={due}
            onChange={(event) => setDue(event.target.value)}
          />
        </div>
        <button type="submit" className="button button-primary" disabled={adding || !title.trim() || !due}>
          {adding ? "Adding…" : "Add reminder"}
        </button>
      </form>

      {error && (
        <p className="alert alert-error small" role="alert">
          {error}
        </p>
      )}

      {finished.length > 0 && (
        <details className="reminder-history">
          <summary>Done and cancelled ({finished.length})</summary>
          <ul className="reminder-list">{finished.map(item)}</ul>
        </details>
      )}
    </section>
  );
}
