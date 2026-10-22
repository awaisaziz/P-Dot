// Starter prompts for an empty conversation and for Today. They fill the
// message box; the user sends. Pure, so they are unit-tested
// (tests/unit/chat-ui-request.test.ts).
import { MAX_MESSAGE_CHARS } from "@/lib/limits";
import type { GoogleProducts } from "@/types/connectors";
import type { GoogleLinkState } from "./connectors";

export const STARTERS_HINT = "Turn on web search or Google in + when you need them.";

export const FLIGHT_STARTER = "Find flights from London to New York next Friday";
export const CALENDAR_STARTER = "What's on my calendar tomorrow?";
export const DRIVE_STARTER = "Summarise my latest Google Doc about the budget";
export const RESEARCH_STARTER = "Research the best phone under $500 with sources";

/** Each Google starter shows only when the grant covers its product. Null: no Google starters. */
export function starterSuggestions(google: GoogleProducts | null): string[] {
  return [
    FLIGHT_STARTER,
    ...(google?.calendar ? [CALENDAR_STARTER] : []),
    ...(google?.drive ? [DRIVE_STARTER] : []),
    RESEARCH_STARTER,
  ];
}

/**
 * The chat's starters. The Google ones need the chip on as well as a
 * connection, since a message sent with the chip off cannot read Google;
 * turning the chip on stays the user's own choice (decision 0011).
 */
export function chatStarters(link: GoogleLinkState, chipOn: boolean): string[] {
  return starterSuggestions(chipOn && link.state === "connected" ? link.products : null);
}

export const WEEK_STARTER = "What's on my calendar this week?";

export interface TodayStarter {
  title: string;
  /** One line under the title. */
  example: string;
  /** Put in the chat's message box; the user sends it. */
  prompt: string;
}

/**
 * Today's "Start something" list. The calendar one shows only where Google
 * can be used (the same server-side check as Today's Coming up panel), so
 * previews and users not on the allow list never get a starter that cannot
 * read their calendar.
 */
export function todayStarters(googleUsable: boolean): TodayStarter[] {
  return [
    { title: "Find a flight", example: "Flights from London to New York, quoted with sources.", prompt: FLIGHT_STARTER },
    ...(googleUsable
      ? [{ title: "Check your week", example: "With Google on in chat, ask what is on your calendar.", prompt: WEEK_STARTER }]
      : []),
    { title: "Research with sources", example: "Ask a question; every fact is quoted from a page.", prompt: RESEARCH_STARTER },
    {
      title: "Plan something",
      example: "Turn a plan into tasks and reminders you approve.",
      prompt: "Help me turn my plans for this week into tasks and reminders",
    },
  ];
}

/** A link that opens the chat with `text` in the message box, not sent. */
export function starterHref(text: string): string {
  return `/chat?q=${encodeURIComponent(text)}`;
}

/** The chat's `q` parameter as a draft: one value, trimmed, at most one message long. Null when there is none. */
export function draftFromQuery(value: string | string[] | undefined): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, MAX_MESSAGE_CHARS) : null;
}
