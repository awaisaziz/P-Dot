import type { Metadata } from "next";
import Link from "next/link";
import { RemindersPanel } from "@/features/reminders/RemindersPanel";
import { REMINDER_LIST_LIMIT } from "@/lib/limits";
import { requireAuth } from "@/server/auth/session";
import { createReminderRepository } from "@/server/db/reminders";

export const metadata: Metadata = { title: "Workflows · P-Dot" };

// Multi-step jobs that run inside a chat reply today (decisions 0015 and 0016).
const IN_CHAT = [
  {
    name: "Flight check",
    line: "Searches travel pages and shows only fares it could quote, with the source and time.",
    href: "/chat",
    link: "Try it in chat",
    pill: "In chat",
  },
  {
    name: "Checked research",
    line: "Reads several pages and keeps only the facts it found quoted on them.",
    href: "/chat",
    link: "Try it in chat",
    pill: "In chat",
  },
  {
    name: "Calendar and Drive",
    line: "Reads your calendar, Docs, Slides and Sheets while Google is on in chat.",
    href: "/connectors",
    link: "Connect Google",
    pill: "With Google",
  },
];

// Planned routines, shown as a preview. None of these run yet.
const PLANNED = [
  {
    name: "Morning brief",
    when: "Every weekday at 7:30",
    steps: ["Read today's calendar and unread email", "Write a short brief and a to-do list", "Send it to Telegram"],
  },
  {
    name: "Meeting summary",
    when: "After each meeting you mark as done",
    steps: ["Summarise the notes you paste or upload", "List action items as tasks", "Ask you before emailing the summary"],
  },
  {
    name: "Book an appointment",
    when: "When you ask in chat",
    steps: ["Find open times in your calendar", "Ask you to approve the time", "Call or message the provider to book"],
  },
  {
    name: "Weekly review",
    when: "Fridays at 16:00",
    steps: ["Collect finished tasks and open pull requests", "Draft a status update for you to edit"],
  },
];

export default async function WorkflowsPage() {
  const auth = await requireAuth("/workflows");
  const reminders = await createReminderRepository(auth.supabase).listReminders(auth.userId, REMINDER_LIST_LIMIT);

  return (
    <main className="page page-wide stack">
      <div className="page-intro">
        <h1>Workflows</h1>
        <p className="muted">Multi-step jobs P-Dot runs for you; anything that sends, books or deletes asks you first.</p>
      </div>

      <section className="stack" aria-labelledby="in-chat-heading">
        <div className="section-heading">
          <h2 id="in-chat-heading">Runs in chat</h2>
          <p className="muted small">Each step shows as one line under the reply, so you can see what it read.</p>
        </div>
        <div className="card-grid">
          {IN_CHAT.map((workflow) => (
            <article key={workflow.name} className="panel">
              <div className="panel-heading">
                <h3>{workflow.name}</h3>
                <span className="status-pill status-executed">{workflow.pill}</span>
              </div>
              <p>{workflow.line}</p>
              <Link href={workflow.href}>{workflow.link}</Link>
            </article>
          ))}
        </div>
      </section>

      <RemindersPanel initialReminders={reminders} />

      <section className="stack" aria-labelledby="planned-heading">
        <div className="section-heading">
          <h2 id="planned-heading">Planned routines</h2>
          <p className="muted small">Previews only; none of these run yet.</p>
        </div>
        <div className="card-grid">
          {PLANNED.map((workflow) => (
            <article key={workflow.name} className="panel">
              <div className="panel-heading">
                <h3>{workflow.name}</h3>
                <span className="status-pill">Coming soon</span>
              </div>
              <p className="muted">{workflow.when}</p>
              <ol className="plain-list">
                {workflow.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
