import "server-only";
import { z } from "zod";
import { toSafeHttpUrl } from "@/lib/safe-url";
import { ProviderError } from "@/server/providers/errors";
import type { CalendarEventItem, DriveFileItem, DriveFileKind } from "@/types/workflows";
import { GOOGLE_API_HOST, googleApiGet, type GoogleRequestOptions } from "./http";

// Read-only calls to Google Calendar and Drive (decision 0016, amendments of
// 2026-10-21). GET only, to www.googleapis.com, with URLs built from parts.
// Every string that comes back is untrusted account data: it is cleaned and
// capped here, and encoded for the model in connector.ts.

const API = `https://${GOOGLE_API_HOST}`;

export const MAX_CALENDARS = 10;
export const MAX_EVENTS = 25;
export const MAX_DRIVE_FILES = 10;
export const MAX_SEARCH_TERMS = 4;
export const DRIVE_READ_MAX_BYTES = 48 * 1024;
export const DRIVE_READ_MAX_CHARS = 6_000;

const TITLE_CHARS = 200;
const PLACE_CHARS = 200;
const CALENDAR_NAME_CHARS = 100;
const FILE_NAME_CHARS = 200;
const TERM_CHARS = 50;

export const DRIVE_FILE_ID = /^[A-Za-z0-9_-]{10,128}$/;

// Control characters, zero-width and bidi format characters (embeddings,
// overrides and isolates): each becomes a space.
const CONTROL =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g;

// Characters that show nothing and attach to the one before: soft hyphen,
// combining grapheme joiner, variation selectors and Unicode tags. Text
// hidden in tags or selectors is unseen by people but read by models, so
// these are removed.
const HIDDEN = /[\u00ad\u034f\ufe00-\ufe0f\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;

/** One line of untrusted text: control and invisible characters removed, spaces collapsed, capped. */
export function cleanLine(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  const text = value.replace(HIDDEN, "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars - 1).trimEnd()}\u2026` : text;
}

/** Multi-line untrusted text: keeps line breaks and tabs, removes other control and invisible characters. */
export function cleanText(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(HIDDEN, "").replace(CONTROL, " ");
}

function safeLink(value: unknown): string | undefined {
  const url = toSafeHttpUrl(value);
  return url && new URL(url).protocol === "https:" ? url : undefined;
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

const calendarListSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().min(1).max(512),
        summary: z.string().nullish(),
        summaryOverride: z.string().nullish(),
        selected: z.boolean().nullish(),
        primary: z.boolean().nullish(),
        hidden: z.boolean().nullish(),
      }),
    )
    .default([]),
});

const eventTime = z.object({ date: z.string().nullish(), dateTime: z.string().nullish() }).nullish();

const eventsSchema = z.object({
  nextPageToken: z.string().nullish(),
  items: z
    .array(
      z.object({
        status: z.string().nullish(),
        summary: z.string().nullish(),
        location: z.string().nullish(),
        htmlLink: z.string().nullish(),
        start: eventTime,
        end: eventTime,
        organizer: z.object({ self: z.boolean().nullish() }).nullish(),
      }),
    )
    .default([]),
});

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** An RFC 3339 time as Google sends it, or a YYYY-MM-DD date for an all-day event. */
function isEventTime(value: string | null | undefined, allDay: boolean): value is string {
  if (typeof value !== "string" || !(allDay ? DATE : DATE_TIME).test(value)) return false;
  return !Number.isNaN(Date.parse(allDay ? `${value}T00:00:00Z` : value));
}

export interface ListEventsInput {
  /** ISO 8601 with an offset. */
  timeMin: string;
  timeMax: string;
  query?: string;
  /** IANA name; Google answers times in this zone. */
  timeZone?: string;
  maxEvents?: number;
}

export interface CalendarEvents {
  events: CalendarEventItem[];
  calendarsRead: number;
  calendarsFailed: number;
  /** The window holds more events than were read: the list cannot show that a time is free. */
  truncated: boolean;
}

interface CalendarRef {
  id: string;
  name: string;
}

async function listSelectedCalendars(accessToken: string, options: GoogleRequestOptions): Promise<CalendarRef[]> {
  const url = new URL(`${API}/calendar/v3/users/me/calendarList`);
  url.search = new URLSearchParams({
    minAccessRole: "reader",
    maxResults: "100",
    fields: "items(id,summary,summaryOverride,selected,primary,hidden)",
  }).toString();
  const body = await googleApiGet(accessToken, url, options);
  const parsed = calendarListSchema.safeParse(body.kind === "json" ? body.value : null);
  if (!parsed.success) throw new ProviderError("google", "bad_response");
  // The calendars the user shows in Google Calendar, primary first.
  return parsed.data.items
    .filter((c) => c.primary === true || (c.selected === true && c.hidden !== true))
    .sort((a, b) => Number(b.primary === true) - Number(a.primary === true))
    .slice(0, MAX_CALENDARS)
    .map((c) => ({ id: c.id, name: cleanLine(c.summaryOverride || c.summary || "Calendar", CALENDAR_NAME_CHARS) || "Calendar" }));
}

function eventStart(event: CalendarEventItem): number {
  return Date.parse(event.allDay ? `${event.start}T00:00:00Z` : event.start);
}

async function listEventsFor(
  accessToken: string,
  calendar: CalendarRef,
  input: ListEventsInput,
  maxEvents: number,
  options: GoogleRequestOptions,
): Promise<{ events: CalendarEventItem[]; more: boolean }> {
  const url = new URL(`${API}/calendar/v3/calendars/${encodeURIComponent(calendar.id)}/events`);
  const params = new URLSearchParams({
    timeMin: input.timeMin,
    timeMax: input.timeMax,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(maxEvents),
    // nextPageToken says this calendar has more events in the window; only the first page is read.
    fields: "nextPageToken,items(status,summary,location,htmlLink,start,end,organizer(self))",
  });
  if (input.query) params.set("q", input.query);
  if (input.timeZone) params.set("timeZone", input.timeZone);
  url.search = params.toString();
  const body = await googleApiGet(accessToken, url, options);
  const parsed = eventsSchema.safeParse(body.kind === "json" ? body.value : null);
  if (!parsed.success) throw new ProviderError("google", "bad_response");

  const events: CalendarEventItem[] = [];
  for (const item of parsed.data.items) {
    if (item.status === "cancelled") continue;
    const allDay = Boolean(item.start?.date && DATE.test(item.start.date));
    const start = allDay ? item.start?.date : item.start?.dateTime;
    const end = allDay ? item.end?.date : item.end?.dateTime;
    if (!isEventTime(start, allDay) || !isEventTime(end, allDay)) continue;
    const event: CalendarEventItem = {
      title: cleanLine(item.summary, TITLE_CHARS) || "(no title)",
      start,
      end,
      allDay,
      calendar: calendar.name,
      fromOthers: item.organizer ? item.organizer.self !== true : false,
    };
    const location = cleanLine(item.location, PLACE_CHARS);
    if (location) event.location = location;
    const link = safeLink(item.htmlLink);
    if (link) event.link = link;
    events.push(event);
  }
  const more = Boolean(parsed.data.nextPageToken) || parsed.data.items.length > maxEvents;
  return { events, more };
}

/**
 * Events from the user's selected calendars (at most 10) in a window, sorted
 * by start, at most 25 in all. `truncated` is set when a calendar had more
 * events than one page or the merged list was cut. A calendar that fails is
 * counted and skipped; when every calendar fails, the first error is thrown.
 */
export async function listCalendarEvents(
  accessToken: string,
  input: ListEventsInput,
  options: GoogleRequestOptions = {},
): Promise<CalendarEvents> {
  const maxEvents = Math.min(input.maxEvents ?? MAX_EVENTS, MAX_EVENTS);
  const calendars = await listSelectedCalendars(accessToken, options);
  const settled = await Promise.allSettled(
    calendars.map((calendar) => listEventsFor(accessToken, calendar, input, maxEvents, options)),
  );
  const events: CalendarEventItem[] = [];
  let failed = 0;
  let more = false;
  let firstError: unknown = null;
  for (const result of settled) {
    if (result.status === "fulfilled") {
      events.push(...result.value.events);
      more ||= result.value.more;
    } else {
      failed += 1;
      firstError ??= result.reason;
    }
  }
  if (calendars.length > 0 && failed === calendars.length) throw firstError;
  events.sort((a, b) => eventStart(a) - eventStart(b) || Number(b.allDay) - Number(a.allDay));
  return {
    events: events.slice(0, maxEvents),
    calendarsRead: calendars.length - failed,
    calendarsFailed: failed,
    truncated: more || events.length > maxEvents,
  };
}

// ---------------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------------

const GOOGLE_DOC = "application/vnd.google-apps.document";
const GOOGLE_SLIDES = "application/vnd.google-apps.presentation";
const GOOGLE_SHEET = "application/vnd.google-apps.spreadsheet";

const KIND_MIME_TYPES: Record<"doc" | "slides" | "sheet", string> = {
  doc: GOOGLE_DOC,
  slides: GOOGLE_SLIDES,
  sheet: GOOGLE_SHEET,
};

export function driveFileKind(mimeType: string | null | undefined): DriveFileKind {
  switch (mimeType) {
    case GOOGLE_DOC:
      return "doc";
    case GOOGLE_SLIDES:
      return "slides";
    case GOOGLE_SHEET:
      return "sheet";
    case "application/pdf":
      return "pdf";
    case "text/plain":
    case "text/markdown":
      return "text";
    default:
      return "other";
  }
}

/** A Drive query string literal: backslash and single quote escaped. */
export function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** The search words: cleaned, at most 4, each at most 50 characters. */
export function driveSearchTerms(query: string): string[] {
  return cleanLine(query, 400)
    .split(" ")
    .map((word) => word.slice(0, TERM_CHARS))
    .filter((word) => word.length > 0)
    .slice(0, MAX_SEARCH_TERMS);
}

/** The `q` for files.list, or null when the query has no words. */
export function buildDriveQuery(query: string, kind: "doc" | "slides" | "sheet" | "any" = "any"): string | null {
  const terms = driveSearchTerms(query);
  if (terms.length === 0) return null;
  const parts = ["trashed = false", ...terms.map((term) => `fullText contains '${escapeDriveQueryValue(term)}'`)];
  if (kind !== "any") parts.push(`mimeType = '${KIND_MIME_TYPES[kind]}'`);
  return parts.join(" and ");
}

const fileSchema = z.object({
  id: z.string(),
  name: z.string().nullish(),
  mimeType: z.string().nullish(),
  modifiedTime: z.string().nullish(),
  webViewLink: z.string().nullish(),
});

const filesSchema = z.object({ files: z.array(fileSchema).default([]) });

function toFile(file: z.infer<typeof fileSchema>): DriveFileItem | null {
  if (!DRIVE_FILE_ID.test(file.id)) return null;
  const item: DriveFileItem = {
    id: file.id,
    name: cleanLine(file.name, FILE_NAME_CHARS) || "(untitled)",
    kind: driveFileKind(file.mimeType),
  };
  if (file.modifiedTime && DATE_TIME.test(file.modifiedTime)) item.modified = file.modifiedTime;
  const link = safeLink(file.webViewLink);
  if (link) item.link = link;
  return item;
}

/** Files whose name or text contains every search word, at most 10. */
export async function searchDriveFiles(
  accessToken: string,
  input: { query: string; kind?: "doc" | "slides" | "sheet" | "any" },
  options: GoogleRequestOptions = {},
): Promise<DriveFileItem[]> {
  const q = buildDriveQuery(input.query, input.kind);
  if (q === null) return [];
  const url = new URL(`${API}/drive/v3/files`);
  url.search = new URLSearchParams({
    q,
    pageSize: String(MAX_DRIVE_FILES),
    spaces: "drive",
    fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
  }).toString();
  const body = await googleApiGet(accessToken, url, options);
  const parsed = filesSchema.safeParse(body.kind === "json" ? body.value : null);
  if (!parsed.success) throw new ProviderError("google", "bad_response");
  return parsed.data.files
    .map(toFile)
    .filter((file): file is DriveFileItem => file !== null)
    .slice(0, MAX_DRIVE_FILES);
}

/** The file is not a Doc, Slides deck, Sheet or plain text file. */
export class DriveFileUnsupportedError extends Error {
  constructor(readonly kind: DriveFileKind) {
    super("drive file type cannot be read");
    this.name = "DriveFileUnsupportedError";
  }
}

export interface DriveFileText {
  file: DriveFileItem;
  /** At most 6,000 characters, cleaned. */
  text: string;
  chars: number;
  /** The file's length in characters, or only the characters read (a lower bound) when `byteCapped`. */
  totalChars: number;
  truncated: boolean;
  /** The file was longer than the 48 KB read. */
  byteCapped: boolean;
}

/**
 * Reads one file's text: Docs and Slides exported as text/plain, Sheets as
 * text/csv (Drive exports the first sheet), plain text and Markdown
 * downloaded. Reads at most 48 KB and keeps the first 6,000 characters.
 */
export async function readDriveFile(
  accessToken: string,
  fileId: string,
  options: GoogleRequestOptions = {},
): Promise<DriveFileText> {
  if (!DRIVE_FILE_ID.test(fileId)) throw new ProviderError("google", "invalid_request");
  const id = encodeURIComponent(fileId);
  const metaUrl = new URL(`${API}/drive/v3/files/${id}`);
  metaUrl.search = new URLSearchParams({ fields: "id,name,mimeType,modifiedTime,webViewLink" }).toString();
  const meta = await googleApiGet(accessToken, metaUrl, options);
  const parsedMeta = fileSchema.safeParse(meta.kind === "json" ? meta.value : null);
  const file = parsedMeta.success ? toFile(parsedMeta.data) : null;
  if (!parsedMeta.success || !file || file.id !== fileId) throw new ProviderError("google", "bad_response");

  let url: URL;
  const mimeType = parsedMeta.data.mimeType;
  if (mimeType === GOOGLE_DOC || mimeType === GOOGLE_SLIDES || mimeType === GOOGLE_SHEET) {
    url = new URL(`${API}/drive/v3/files/${id}/export`);
    url.search = new URLSearchParams({ mimeType: mimeType === GOOGLE_SHEET ? "text/csv" : "text/plain" }).toString();
  } else if (mimeType === "text/plain" || mimeType === "text/markdown") {
    url = new URL(`${API}/drive/v3/files/${id}`);
    url.search = new URLSearchParams({ alt: "media" }).toString();
  } else {
    throw new DriveFileUnsupportedError(file.kind);
  }

  const body = await googleApiGet(accessToken, url, options, { maxBytes: DRIVE_READ_MAX_BYTES, timeoutMs: 15_000 });
  if (body.kind !== "bytes") throw new ProviderError("google", "bad_response");
  // A cut can split a character at the end; the decoder replaces it.
  const all = cleanText(new TextDecoder().decode(body.bytes).replace(/^\ufeff/, "")).trim();
  const characters = Array.from(all);
  const truncated = characters.length > DRIVE_READ_MAX_CHARS || body.truncated;
  const text = characters.slice(0, DRIVE_READ_MAX_CHARS).join("");
  return {
    file,
    text,
    chars: Math.min(characters.length, DRIVE_READ_MAX_CHARS),
    totalChars: characters.length,
    truncated,
    byteCapped: body.truncated,
  };
}
