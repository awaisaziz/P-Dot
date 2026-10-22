"use client";

import { useState } from "react";
import { MAX_TASK_CHARS } from "@/lib/limits";
import type { TaskDTO } from "@/types/api";
import { createTask, deleteTask, updateTask } from "./api";

export function TaskList({ initialTasks }: { initialTasks: TaskDTO[] }) {
  const [tasks, setTasks] = useState(initialTasks);
  // A server refresh (for example after an approved "add a task" action) brings a new list.
  const [shownInitial, setShownInitial] = useState(initialTasks);
  if (initialTasks !== shownInitial) {
    setShownInitial(initialTasks);
    setTasks(initialTasks);
  }
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doneCount = tasks.filter((task) => task.done).length;

  async function add(event: React.FormEvent) {
    event.preventDefault();
    const title = draft.trim();
    if (!title || adding) return;
    setAdding(true);
    setError(null);
    try {
      const task = await createTask(title);
      setTasks((current) => [...current, task]);
      setDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add the task.");
    } finally {
      setAdding(false);
    }
  }

  async function toggle(task: TaskDTO) {
    setError(null);
    setTasks((current) => current.map((t) => (t.id === task.id ? { ...t, done: !t.done } : t)));
    try {
      await updateTask(task.id, { done: !task.done });
    } catch (err) {
      setTasks((current) => current.map((t) => (t.id === task.id ? { ...t, done: task.done } : t)));
      setError(err instanceof Error ? err.message : "Could not update the task.");
    }
  }

  async function remove(task: TaskDTO) {
    setError(null);
    try {
      await deleteTask(task.id);
      setTasks((current) => current.filter((t) => t.id !== task.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete the task.");
    }
  }

  return (
    <section className="panel" aria-labelledby="tasks-heading">
      <div className="panel-heading">
        <h2 id="tasks-heading">To-do list</h2>
        <span className="muted small">
          {tasks.length === 0 ? "Nothing yet" : `${doneCount} of ${tasks.length} done`}
        </span>
      </div>

      {tasks.length === 0 && <p className="muted">Add your first task below.</p>}
      <ul className="task-list">
        {tasks.map((task) => (
          <li key={task.id} className="task-item">
            <label className="task-label">
              <input type="checkbox" checked={task.done} onChange={() => void toggle(task)} />
              <span className={task.done ? "task-done" : undefined}>{task.title}</span>
            </label>
            <button
              type="button"
              className="icon-button icon-button-danger"
              aria-label={`Delete task “${task.title}”`}
              onClick={() => void remove(task)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>

      <form className="task-form" onSubmit={(event) => void add(event)}>
        <label htmlFor="new-task" className="visually-hidden">
          New task
        </label>
        <input
          id="new-task"
          type="text"
          value={draft}
          maxLength={MAX_TASK_CHARS}
          placeholder="Add a task…"
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="button button-primary" disabled={adding || !draft.trim()}>
          Add
        </button>
      </form>

      {error && (
        <p className="alert alert-error small" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
