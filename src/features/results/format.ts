// Display helpers for verified result cards (decisions 0015, 0016). Pure
// functions, so they are unit-tested (tests/unit/chat-ui-results.test.ts).
// Every string here came from a page or an account and is shown as text.
import { toSafeHttpUrl } from "@/lib/safe-url";
import type {
  CalendarEventItem,
  DriveFileKind,
  DriveResult,
  DropReason,
  FlightResult,
  MessageResult,
  PriceBasis,
  QuotedSource,
  WorkflowStep,
} from "@/types/workflows";

/** Locale (en-GB when left out) and zone (the browser's own when left out) for formatting. Tests pass both. */
export interface FormatOptions {
  locale?: string;
  timeZone?: string;
}

const BASIS_ORDER: PriceBasis[] = ["from", "range", "per_person", "round_trip", "one_way"];

export const BASIS_LABELS: Record<PriceBasis, string> = {
  per_person: "per person",
  round_trip: "round trip",
  one_way: "one way",
  from: "from",
  range: "range",
};

/** Chip labels for a price's basis, known values only, each once, in a fixed order. */
export function basisChips(basis: readonly string[]): string[] {
  const given = new Set(basis);
  return BASIS_ORDER.filter((value) => given.has(value)).map((value) => BASIS_LABELS[value]);
}

/**
 * The message the Re-check button sends as a new message. "prices" is a
 * search cue, so the server's flight intent forces the verified workflow
 * (decision 0015).
 */
export function recheckMessage(result: Pick<FlightResult, "trip">): string {
  return `Check flight prices again: ${result.trip.line.replace(/\s+/g, " ").trim()}`;
}

/** Fares older than this get "fares change" and a Re-check button. */
export const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function validDate(iso: string): Date | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "21 Oct, 14:05" in the viewer's zone. */
export function formatReadTime(date: Date, options: FormatOptions = {}): string {
  return new Intl.DateTimeFormat(options.locale ?? "en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  }).format(date);
}

export interface ReadLine {
  text: string;
  /** Older than STALE_AFTER_MS. */
  stale: boolean;
}

/**
 * When P-Dot read the pages: "Read 21 Oct, 14:05", or after 6 hours "Read 3
 * days ago · fares change" (the suffix only when given). `now` is null before
 * the browser knows the time, which counts as fresh.
 */
export function readLine(
  retrievedAt: string,
  now: number | null,
  options: FormatOptions & { staleSuffix?: string } = {},
): ReadLine | null {
  const date = validDate(retrievedAt);
  if (!date) return null;
  const age = now === null ? 0 : now - date.getTime();
  if (age < STALE_AFTER_MS) return { text: `Read ${formatReadTime(date, options)}`, stale: false };
  const ago =
    age < DAY_MS
      ? `${Math.floor(age / HOUR_MS)} hours ago`
      : `${Math.floor(age / DAY_MS)} ${Math.floor(age / DAY_MS) === 1 ? "day" : "days"} ago`;
  return { text: `Read ${ago}${options.staleSuffix ? ` · ${options.staleSuffix}` : ""}`, stale: true };
}

export interface FlightFoot extends ReadLine {
  /** Show the Re-check button. */
  recheck: boolean;
}

/**
 * The flight card's foot. With no page read (search refused, failed or not
 * set up) it says so instead of a read time, and Re-check stays available.
 */
export function flightFoot(
  result: Pick<FlightResult, "sources" | "retrievedAt">,
  now: number | null,
  options: FormatOptions = {},
): FlightFoot | null {
  if ((result.sources ?? []).length === 0) return { text: "No page was read", stale: false, recheck: true };
  const read = readLine(result.retrievedAt, now, { ...options, staleSuffix: "fares change" });
  return read ? { ...read, recheck: read.stale } : null;
}

export const DROP_LABELS: Record<DropReason, string> = {
  quote_not_found: "quote not on the page",
  cross_chunk: "quote joined two passages",
  price_not_in_quote: "price not in quote",
  airline_not_in_quote: "airline not in quote",
  wrong_direction: "wrong direction",
  route_not_stated: "route not stated",
  ambiguous_quote: "more than one price or airline",
  addresses_assistant: "text aimed at the assistant",
  invalid: "unreadable",
};

/** "2 candidates dropped: wrong direction, price not in quote". Null when nothing was dropped. */
export function dropLine(dropped: Partial<Record<string, number>>): string | null {
  const entries = Object.entries(dropped).filter(
    (entry): entry is [DropReason, number] =>
      entry[0] in DROP_LABELS && typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] > 0,
  );
  if (entries.length === 0) return null;
  const total = entries.reduce((sum, [, n]) => sum + Math.floor(n), 0);
  const reasons = entries.map(([reason, n]) => (n > 1 ? `${DROP_LABELS[reason]} (${Math.floor(n)})` : DROP_LABELS[reason]));
  return `${total} ${total === 1 ? "candidate" : "candidates"} dropped: ${reasons.join(", ")}`;
}

const MAX_MENTIONS = 6;
const MAX_MENTION_CHARS = 24;

/** "Not verified: £350, 09:40 appear in the reply but not on the pages read." Null when every mention checked out. */
export function unverifiedLine(mentions: readonly string[]): string | null {
  const shown = mentions
    .map((mention) => mention.replace(/\s+/g, " ").trim().slice(0, MAX_MENTION_CHARS))
    .filter(Boolean);
  if (shown.length === 0) return null;
  const listed = shown.slice(0, MAX_MENTIONS).join(", ");
  const more = shown.length > MAX_MENTIONS ? ` and ${shown.length - MAX_MENTIONS} more` : "";
  const verb = shown.length === 1 ? "appears" : "appear";
  return `Not verified: ${listed}${more} ${verb} in the reply but not on the pages read.`;
}

/** A flight or research card's warning about the reply's unverified mentions. Older research rows have none. */
export function resultWarning(result: { unverifiedMentions?: readonly string[] }): string | null {
  return unverifiedLine(result.unverifiedMentions ?? []);
}

/** The hostname without "www.", or null. */
export function displayHost(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    return host.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

export interface SourceView {
  /** A safe http(s) link, or null when the stored URL is not one. */
  url: string | null;
  /** Read from the link itself, so a stored domain cannot name another site. */
  domain: string;
}

const UNKNOWN_PAGE = "a page P-Dot read";

/** The link and domain for "Quoted from <domain>". Without a safe link the stored domain is not shown. */
export function sourceView(source: Pick<QuotedSource, "url" | "domain"> | undefined): SourceView {
  const url = source ? toSafeHttpUrl(source.url) : null;
  const host = url ? displayHost(url) : null;
  return url && host ? { url, domain: host } : { url: null, domain: UNKNOWN_PAGE };
}

/** The only hand-off sites, by host, with the path their links must start with. */
const HANDOFF_SITES: Record<string, { name: string; path: string }> = {
  "www.google.com": { name: "Google Flights", path: "/travel/flights" },
  "www.skyscanner.net": { name: "Skyscanner", path: "/transport/flights/" },
};

export interface HandOffLink {
  url: string;
  /** Button text: the first says "See live fares on Google Flights", the rest just the site. */
  text: string;
  /** The full name for assistive technology. */
  label: string;
}

/** Hand-off links that pass the allow list: https, a known host and its path, no credentials. */
export function handOffLinks(links: readonly { label: string; url: string }[]): HandOffLink[] {
  const shown: HandOffLink[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    const url = toSafeHttpUrl(link.url);
    if (!url) continue;
    const parsed = new URL(url);
    const site = HANDOFF_SITES[parsed.hostname];
    if (parsed.protocol !== "https:" || !site || !parsed.pathname.startsWith(site.path) || seen.has(site.name)) continue;
    seen.add(site.name);
    const label = `See live fares on ${site.name}`;
    shown.push({ url, label, text: shown.length === 0 ? label : site.name });
  }
  return shown;
}

/** Google's own hosts for each product, with the path a link must start with ("" for any). */
const GOOGLE_HOSTS: Record<"calendar" | "drive", Record<string, string>> = {
  // www.google.com also serves the /url redirector, so only its Calendar paths count.
  calendar: { "calendar.google.com": "", "www.google.com": "/calendar/" },
  drive: { "docs.google.com": "", "drive.google.com": "" },
};

/** A Google link for an event or a file, only on Google's own https hosts and paths. */
export function googleLink(value: string | undefined, product: keyof typeof GOOGLE_HOSTS): string | null {
  const url = toSafeHttpUrl(value);
  if (!url) return null;
  const parsed = new URL(url);
  const path = Object.hasOwn(GOOGLE_HOSTS[product], parsed.hostname) ? GOOGLE_HOSTS[product][parsed.hostname] : undefined;
  return parsed.protocol === "https:" && path !== undefined && parsed.pathname.startsWith(path) ? url : null;
}

const ALL_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "Wed 22 Oct". */
function dayText(date: Date, options: FormatOptions): string {
  return new Intl.DateTimeFormat(options.locale ?? "en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  }).format(date);
}

/** "14:00". */
function clockText(date: Date, options: FormatOptions): string {
  return new Intl.DateTimeFormat(options.locale ?? "en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  }).format(date);
}

/** "Wed 22 Oct · 14:00–15:00", "Wed 22 Oct · All day", or "Wed 22 Oct, 22:00 – Thu 23 Oct, 06:00". */
export function eventTimeText(event: Pick<CalendarEventItem, "start" | "end" | "allDay">, options: FormatOptions = {}): string {
  if (event.allDay) {
    const match = ALL_DAY.exec(event.start);
    // An all-day date has no zone: read it as a calendar day, not as midnight UTC.
    const day = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12)) : validDate(event.start);
    return day ? `${dayText(day, { ...options, timeZone: "UTC" })} · All day` : "All day";
  }
  const start = validDate(event.start);
  if (!start) return event.start.slice(0, 32);
  const end = validDate(event.end);
  const startDay = dayText(start, options);
  if (!end || end.getTime() <= start.getTime()) return `${startDay} · ${clockText(start, options)}`;
  const endDay = dayText(end, options);
  if (endDay === startDay) return `${startDay} · ${clockText(start, options)}–${clockText(end, options)}`;
  return `${startDay}, ${clockText(start, options)} – ${endDay}, ${clockText(end, options)}`;
}

export const DRIVE_KIND_LABELS: Record<DriveFileKind, string> = {
  doc: "Doc",
  slides: "Slides",
  sheet: "Sheet",
  pdf: "PDF",
  text: "Text",
  other: "File",
};

const NUMBER = new Intl.NumberFormat("en-US");

/**
 * A file read from Drive. `capped`: the server's 48 KB read cut the file, so
 * `totalChars` counts only the characters read and the file is longer.
 */
export type DriveRead = NonNullable<DriveResult["read"]>;

/**
 * "Read Budget 2026 · first 6,000 of 18,240 characters", "Read Budget 2026 ·
 * first 6,000 of more than 49,152 characters" after the byte cap, or "Read
 * Budget 2026 · 3,100 characters".
 */
export function driveReadLine(read: DriveRead): string {
  const name = read.name.trim() || "the file";
  if (!read.truncated) return `Read ${name} · ${NUMBER.format(read.chars)} ${read.chars === 1 ? "character" : "characters"}`;
  const total = `${read.capped ? "more than " : ""}${NUMBER.format(read.totalChars)}`;
  return `Read ${name} · first ${NUMBER.format(read.chars)} of ${total} characters`;
}

/** A Google read's step (google-<call>), which src/server/connectors/google/connector.ts names. */
const GOOGLE_STEP = /^google-/;

/**
 * Marks the Drive reads that the server's byte cap cut. A result that has
 * `capped` (true or false) keeps it. Older rows have no such field, so for
 * them the read's step detail is used: it says "first N of more than M
 * characters" (connector.ts, runDriveRead). The same array when nothing changes.
 */
export function markCappedReads(
  results: readonly MessageResult[],
  steps: readonly Pick<WorkflowStep, "id" | "detail">[] | undefined,
): readonly MessageResult[] {
  const details = (steps ?? []).flatMap((step) => (GOOGLE_STEP.test(step.id) && step.detail ? [step.detail] : []));
  if (details.length === 0) return results;
  let changed = false;
  const marked = results.map((result): MessageResult => {
    const original = result.kind === "drive" ? result.read : undefined;
    if (result.kind !== "drive" || !original || !original.truncated || original.capped !== undefined) return result;
    const phrase = `first ${NUMBER.format(original.chars)} of more than ${NUMBER.format(original.totalChars)} characters`;
    if (!details.some((detail) => detail.includes(phrase))) return result;
    changed = true;
    const read: DriveRead = { ...original, capped: true };
    return { ...result, read };
  });
  return changed ? marked : results;
}

/**
 * What a reply read from Google, one line each, for "What was sent": "6
 * calendar events", "3 Drive files listed" (or "Drive searched, no match"),
 * "Read Budget 2026 · first 6,000 of 18,240 characters". A read file is
 * its own line, not a listed one. Empty when the reply read nothing from Google.
 *
 * `trimmed`: the server cut the saved payload to fit, so a list may be
 * shorter than what was read. Counts then say "At least 6 calendar events",
 * and an empty list says only that it was checked.
 */
export function googleSentLines(results: readonly MessageResult[], trimmed = false): string[] {
  const lines: string[] = [];
  let calendarReads = 0;
  let events = 0;
  let driveSearches = 0;
  let files = 0;
  const reads: string[] = [];
  for (const result of results) {
    if (result.kind === "calendar") {
      calendarReads += 1;
      events += result.events?.length ?? 0;
    } else if (result.kind === "drive") {
      if (result.read) {
        reads.push(driveReadLine(result.read));
      } else {
        driveSearches += 1;
        files += result.files?.length ?? 0;
      }
    }
  }
  const atLeast = trimmed ? "At least " : "";
  if (calendarReads > 0) {
    if (events > 0) lines.push(`${atLeast}${events} calendar ${events === 1 ? "event" : "events"}`);
    else lines.push(trimmed ? "Calendar checked" : "Calendar checked, no events");
  }
  if (driveSearches > 0) {
    if (files > 0) lines.push(`${atLeast}${files} Drive ${files === 1 ? "file" : "files"} listed`);
    else lines.push(trimmed ? "Drive searched" : "Drive searched, no match");
  }
  return [...lines, ...reads];
}

export interface GoogleSentRow {
  /** One line per kind of read. */
  lines: string[];
  /** Shown when `lines` is empty. */
  none: string;
}

/**
 * The Google row of "What was sent". Its only record is the reply's saved
 * results and steps, so without them it says "None recorded", never "Not
 * used". A Google step whose result was not kept still counts as a read.
 * When the server trimmed the payload (`trimmed`), counts say "at least",
 * and Google reads whose whole result was cut get a line of their own.
 */
export function googleSentRow(
  payload:
    | { results: readonly MessageResult[]; steps: readonly Pick<WorkflowStep, "id" | "status">[]; trimmed?: boolean }
    | undefined,
): GoogleSentRow {
  if (!payload) return { lines: [], none: "None recorded" };
  const trimmed = payload.trimmed === true;
  const lines = googleSentLines(payload.results, trimmed);
  // Each Google call that did not fail has one step and one result (connector.ts).
  const reads = payload.steps.filter((step) => GOOGLE_STEP.test(step.id) && step.status !== "failed").length;
  if (lines.length === 0 && reads > 0) {
    return { lines: ["Read from Google; the details were not kept"], none: "Not used" };
  }
  const kept = payload.results.filter((result) => result.kind === "calendar" || result.kind === "drive").length;
  const lost = reads - kept;
  if (trimmed && lost > 0) {
    lines.push(`${lost} more ${lost === 1 ? "read" : "reads"} from Google; the details were not kept`);
  }
  return { lines, none: "Not used" };
}

/** "Edited 21 Oct". Null for a missing or invalid date. */
export function modifiedText(iso: string | undefined, options: FormatOptions = {}): string | null {
  const date = iso ? validDate(iso) : null;
  if (!date) return null;
  return `Edited ${new Intl.DateTimeFormat(options.locale ?? "en-GB", {
    day: "numeric",
    month: "short",
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  }).format(date)}`;
}
