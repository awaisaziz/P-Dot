"use client";

// Today's "Coming up" panel: the next 24 hours from Google Calendar
// (decision 0016). One read per page load; a failure is a state, never made-up events.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ApiError, getJson } from "@/lib/api-client";
import type { UpcomingEventsResponse } from "@/types/connectors";
import type { CalendarEventItem } from "@/types/workflows";

const MAX_ROWS = 5;

export const TESTING_EXPIRY_LINE = "While P-Dot's Google app is in testing, access ends every 7 days; reconnect when asked.";

type PanelState = { state: "loading" } | UpcomingEventsResponse;

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** An all-day start is a plain date (YYYY-MM-DD) and means that day wherever the viewer is. */
function startDate(event: CalendarEventItem): Date {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(event.start);
  return day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : new Date(event.start);
}

/**
 * "9:30 AM" or "All day", plus the weekday when it is not today. Times are in the browser's zone.
 * Google also lists events still running, so one that has started reads as "Now" or "All day", with no weekday.
 */
export function whenLabel(event: CalendarEventItem, now: Date): { time: string; day: string | null } {
  const start = startDate(event);
  if (Number.isNaN(start.getTime())) return { time: event.allDay ? "All day" : event.start, day: null };
  if (start.getTime() <= now.getTime()) return { time: event.allDay ? "All day" : "Now", day: null };
  const time = event.allDay
    ? "All day"
    : new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(start);
  const day = sameLocalDay(start, now) ? null : new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(start);
  return { time, day };
}

/** An answer of an unknown shape (an older or newer server) shows the error state. */
export function isUpcoming(value: unknown): value is UpcomingEventsResponse {
  if (typeof value !== "object" || value === null) return false;
  const state = (value as { state?: unknown }).state;
  if (state === "ok") return Array.isArray((value as { events?: unknown }).events);
  return state === "needs_reconnect" || state === "not_connected" || state === "error";
}

/** Event text comes from Google: rendered as text, and a link only when it is https. */
export function safeHttpsLink(link: string | undefined): string | null {
  if (!link) return null;
  try {
    return new URL(link).protocol === "https:" ? link : null;
  } catch {
    return null;
  }
}

export function ComingUp() {
  const router = useRouter();
  const [panel, setPanel] = useState<PanelState>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  // Retry removes its own button, so focus moves to the panel instead of the page.
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    const path = `/api/connectors/google/upcoming?tz=${encodeURIComponent(browserTimeZone())}`;
    getJson<UpcomingEventsResponse>(path, controller.signal).then(
      (body) => setPanel(isUpcoming(body) ? body : { state: "error" }),
      (err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError && err.status === 401) router.replace("/login?next=/today");
        else setPanel({ state: "error" });
      },
    );
    return () => controller.abort();
  }, [attempt, router]);

  function retry() {
    sectionRef.current?.focus();
    setPanel({ state: "loading" });
    setAttempt((value) => value + 1);
  }

  let body: React.ReactNode;
  switch (panel.state) {
    case "loading":
      body = <p className="muted small">Checking your calendar…</p>;
      break;
    case "not_connected":
      body = (
        <p className="muted small">
          <Link href="/connectors">Connect Google Calendar</Link> to see what&apos;s next.
        </p>
      );
      break;
    case "needs_reconnect":
      body = (
        <p className="small">
          Google needs reconnecting · <Link href="/connectors">Reconnect</Link>
        </p>
      );
      break;
    case "error":
      body = (
        <p className="small">
          Could not load your calendar ·{" "}
          <button type="button" className="link-button" onClick={retry}>
            Retry
          </button>
        </p>
      );
      break;
    case "ok": {
      const now = new Date();
      const events = panel.events.slice(0, MAX_ROWS);
      body =
        events.length === 0 ? (
          <p className="muted small">Nothing in the next 24 hours.</p>
        ) : (
          <ul className="coming-up-list">
            {events.map((event, index) => {
              const link = safeHttpsLink(event.link);
              const when = whenLabel(event, now);
              return (
                <li key={`${event.start}-${index}`} className="coming-up-row">
                  <span className="coming-up-time">
                    {when.time}
                    {when.day && <span className="coming-up-day">{when.day}</span>}
                  </span>
                  <span className="coming-up-body">
                    <span className="coming-up-title">{event.title || "(No title)"}</span>
                    <span className="coming-up-meta">
                      {event.calendar}
                      {event.fromOthers && " · Invitation"}
                    </span>
                  </span>
                  {link && (
                    <a
                      className="coming-up-link"
                      href={link}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Open “${event.title || "event"}” in Google Calendar`}
                    >
                      Open
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        );
      break;
    }
  }

  // Decision 0016's 7-day Testing line. No server flag says Testing yet, so it is worded as a condition.
  const hasGrant = panel.state === "ok" || panel.state === "needs_reconnect";

  return (
    <section
      ref={sectionRef}
      className="panel coming-up"
      tabIndex={-1}
      aria-labelledby="coming-up-heading"
      aria-busy={panel.state === "loading"}
    >
      <div className="panel-heading">
        <h2 id="coming-up-heading">Coming up</h2>
        <span className="muted small">Next 24 hours</span>
      </div>
      {body}
      {hasGrant && <p className="muted small">{TESTING_EXPIRY_LINE}</p>}
    </section>
  );
}
