import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { toSafeHttpUrl } from "@/lib/safe-url";
import { logEvent, type Logger } from "@/server/log";
import type { MessageResultsPayload } from "@/types/workflows";
import { RepositoryError } from "./conversations";

// Verified results and steps for an assistant reply (decision 0015,
// "Persistence"; table message_results). Every method filters by the
// authenticated user's ID, and RLS enforces the same rule. The payload is
// parsed with a strict schema on read and is only ever shown as text; it is
// never sent back into a prompt.

/** The database check: octet_length(payload::text) <= 32768. */
export const MESSAGE_RESULTS_MAX_BYTES = 32_768;

/** IDs per read request, so the request URL stays short. */
const LIST_BATCH = 100;

const text = (max: number) => z.string().max(max);
const safeUrl = z
  .string()
  .max(2048)
  .refine((value) => toSafeHttpUrl(value) !== null, "not a safe http(s) URL");
const count = z.number().int().min(0).max(10_000);

const stepSchema = z
  .object({
    id: text(80),
    label: text(300),
    status: z.enum(["running", "done", "partial", "failed"]),
    detail: text(500).optional(),
  })
  .strict();

const dropReason = z.enum([
  "quote_not_found",
  "cross_chunk",
  "price_not_in_quote",
  "airline_not_in_quote",
  "wrong_direction",
  "route_not_stated",
  "ambiguous_quote",
  "addresses_assistant",
  "invalid",
]);
const droppedSchema = z.partialRecord(dropReason, count);

const quotedSourceSchema = z
  .object({
    n: z.number().int().min(1).max(100),
    title: text(300),
    url: safeUrl,
    domain: text(255),
    retrievedAt: z.iso.datetime({ offset: true }),
    freshness: text(120).optional(),
  })
  .strict();

const flightOptionSchema = z
  .object({
    airline: text(120),
    priceText: text(120),
    amount: z.number().finite().nullable(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable(),
    basis: z.array(z.enum(["per_person", "round_trip", "one_way", "from", "range"])).max(5),
    departs: text(60).optional(),
    arrives: text(60).optional(),
    stops: text(60).optional(),
    quote: text(300),
    source: z.number().int().min(1).max(100),
  })
  .strict();

const flightResultSchema = z
  .object({
    kind: z.literal("flights"),
    trip: z
      .object({
        originLabel: text(120),
        destinationLabel: text(120),
        departDate: z.iso.date(),
        returnDate: z.iso.date().optional(),
        passengers: z.number().int().min(1).max(9),
        line: text(300),
      })
      .strict(),
    options: z.array(flightOptionSchema).max(16),
    typical: z.array(flightOptionSchema).max(16),
    dropped: droppedSchema,
    links: z.array(z.object({ label: text(120), url: safeUrl }).strict()).max(4),
    sources: z.array(quotedSourceSchema).max(20),
    summary: text(400),
    unverifiedMentions: z.array(text(60)).max(20),
    retrievedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

const researchResultSchema = z
  .object({
    kind: z.literal("research"),
    question: text(500),
    claims: z
      .array(
        z
          .object({ claim: text(300), quote: text(400), source: z.number().int().min(1).max(100), paraphrased: z.boolean() })
          .strict(),
      )
      .max(16),
    dropped: droppedSchema,
    sources: z.array(quotedSourceSchema).max(20),
    summary: text(400),
    // Older rows have none.
    unverifiedMentions: z.array(text(60)).max(20).optional(),
    retrievedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

const calendarResultSchema = z
  .object({
    kind: z.literal("calendar"),
    events: z
      .array(
        z
          .object({
            title: text(300),
            start: text(40),
            end: text(40),
            allDay: z.boolean(),
            calendar: text(300),
            location: text(300).optional(),
            link: safeUrl.optional(),
            fromOthers: z.boolean(),
          })
          .strict(),
      )
      .max(100),
    window: z.object({ start: text(40), end: text(40) }).strict(),
  })
  .strict();

const driveResultSchema = z
  .object({
    kind: z.literal("drive"),
    files: z
      .array(
        z
          .object({
            id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
            name: text(300),
            kind: z.enum(["doc", "slides", "sheet", "pdf", "text", "other"]),
            modified: text(40).optional(),
            link: safeUrl.optional(),
          })
          .strict(),
      )
      .max(50),
    read: z
      .object({
        id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
        name: text(300),
        chars: count.max(10_000_000),
        totalChars: count.max(10_000_000),
        truncated: z.boolean(),
        // Older rows have none.
        capped: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** The stored payload, checked strictly: unknown keys, bad URLs or oversized fields fail. */
export const messageResultsPayloadSchema = z
  .object({
    results: z
      .array(z.discriminatedUnion("kind", [flightResultSchema, researchResultSchema, calendarResultSchema, driveResultSchema]))
      .max(8),
    steps: z.array(stepSchema).max(40),
    // Older rows have none.
    trimmed: z.boolean().optional(),
  })
  .strict() satisfies z.ZodType<MessageResultsPayload>;

/**
 * The size of a JSON value as Postgres prints jsonb (", " and ": " between
 * items), in UTF-8 bytes. It bounds octet_length(payload::text).
 */
export function jsonbTextBytes(value: unknown): number {
  const encoder = new TextEncoder();
  const size = (v: unknown): number => {
    if (v === null || v === undefined) return 4;
    if (typeof v === "string") return encoder.encode(JSON.stringify(v)).length;
    if (typeof v === "number" || typeof v === "boolean") return String(v).length;
    if (Array.isArray(v)) {
      const items = v.map((item) => (item === undefined ? 4 : size(item)));
      return 2 + items.reduce((sum, n) => sum + n, 0) + Math.max(0, items.length - 1) * 2;
    }
    if (typeof v === "object") {
      const entries = Object.entries(v as Record<string, unknown>).filter(([, item]) => item !== undefined);
      const items = entries.map(([key, item]) => encoder.encode(JSON.stringify(key)).length + 2 + size(item));
      return 2 + items.reduce((sum, n) => sum + n, 0) + Math.max(0, items.length - 1) * 2;
    }
    return 4;
  };
  return size(value);
}

/** What fitResultsPayload left out, by kind, for a metadata-only log line. */
export interface ResultsTrim {
  details: number;
  events: number;
  files: number;
  quotes: number;
  results: number;
}

/** Items a stored calendar or Drive list keeps when it is cut, so a card never looks empty. */
const MIN_LIST_ITEMS = 5;
/** Flight options (fares, then typical prices) that keep their quote when quotes are cut. */
const QUOTED_OPTIONS = 3;

/**
 * Makes an oversized payload fit `maxBytes` instead of losing it (decision
 * 0015, changes after the final review). In order, until it fits: the step
 * details, largest first; then the calendar and Drive lists, longest first,
 * down to 5 items each; then the quotes of flight options after the first
 * three; then whole calendar and Drive results, last first. A flight result's
 * summary and unverified mentions are never cut. A cut payload has `trimmed`
 * set, so the card can say its lists may be partial. `fits` is false when
 * even that is not enough. Pure: the payload passed in is not changed.
 */
export function fitResultsPayload(
  payload: MessageResultsPayload,
  maxBytes = MESSAGE_RESULTS_MAX_BYTES,
): { payload: MessageResultsPayload; trim: ResultsTrim | null; fits: boolean } {
  if (jsonbTextBytes(payload) <= maxBytes) return { payload, trim: null, fits: true };
  // Marked before measuring, so the mark's own bytes are counted.
  const fitted: MessageResultsPayload = { ...structuredClone(payload), trimmed: true };
  const trim: ResultsTrim = { details: 0, events: 0, files: 0, quotes: 0, results: 0 };
  let bytes = jsonbTextBytes(fitted);
  const over = () => bytes > maxBytes;

  // 1. Step details, largest first.
  const detailed = fitted.steps.filter((step) => step.detail !== undefined);
  detailed.sort((a, b) => jsonbTextBytes(b.detail) - jsonbTextBytes(a.detail));
  for (const step of detailed) {
    if (!over()) break;
    delete step.detail;
    trim.details += 1;
    bytes = jsonbTextBytes(fitted);
  }

  // 2. Calendar events and Drive files, from the end of the longest list. Removing the last of
  //    n > 1 items takes away its own bytes and the ", " before it.
  const lists: { items: unknown[]; kind: "events" | "files" }[] = [];
  for (const result of fitted.results) {
    if (result.kind === "calendar") lists.push({ items: result.events, kind: "events" });
    else if (result.kind === "drive") lists.push({ items: result.files, kind: "files" });
  }
  while (over()) {
    const longest = lists.filter((list) => list.items.length > MIN_LIST_ITEMS).sort((a, b) => b.items.length - a.items.length)[0];
    if (!longest) break;
    const removed = longest.items.pop();
    bytes -= jsonbTextBytes(removed) + 2;
    trim[longest.kind] += 1;
  }
  bytes = jsonbTextBytes(fitted);

  // 3. The quotes of flight options after the first few; the card keeps the price and the source.
  for (const result of fitted.results) {
    if (!over()) break;
    if (result.kind !== "flights") continue;
    for (const option of [...result.options, ...result.typical].slice(QUOTED_OPTIONS)) {
      if (!over()) break;
      if (!option.quote) continue;
      option.quote = "";
      trim.quotes += 1;
      bytes = jsonbTextBytes(fitted);
    }
  }

  // 4. Whole calendar and Drive results, last first. Flight and research results stay.
  for (let index = fitted.results.length - 1; index >= 0 && over(); index -= 1) {
    const kind = fitted.results[index]!.kind;
    if (kind !== "calendar" && kind !== "drive") continue;
    fitted.results.splice(index, 1);
    trim.results += 1;
    bytes = jsonbTextBytes(fitted);
  }
  // Nothing could be cut: the payload is unchanged (and still too large).
  if (Object.values(trim).every((n) => n === 0)) delete fitted.trimmed;
  return { payload: fitted, trim, fits: !over() };
}

/**
 * True only when a database error says that message_results does not exist
 * yet (the migration has not run). Every other error returns false.
 */
export function isMissingResultsTable(error: { code?: string; message?: string } | null): boolean {
  const message = (error?.message ?? "").trim();
  switch (error?.code) {
    case "42P01":
      return /^relation "(?:public\.)?message_results" does not exist$/.test(message);
    case "PGRST205":
      return /^Could not find the table '(?:public\.)?message_results' in the schema cache$/.test(message);
    case "PGRST200":
      return /^Could not find a relationship between '(?:(?:public\.)?message_results' and '[a-z_.]+|[a-z_.]+' and '(?:public\.)?message_results)' in the schema cache$/.test(
        message,
      );
    default:
      return false;
  }
}

export interface MessageResultsRepository {
  /**
   * Stores the results and steps of one assistant reply. Does nothing when
   * there is nothing to store or the table does not exist yet. Throws
   * RepositoryError for an invalid or oversized payload, or a failed write.
   */
  insertResults(userId: string, messageId: string, payload: MessageResultsPayload): Promise<void>;
  /** The stored payloads of the user's messages, by message ID. A row that fails the schema is skipped. */
  listForMessages(userId: string, messageIds: string[]): Promise<Map<string, MessageResultsPayload>>;
}

const rowSchema = z.object({ message_id: z.string(), payload: z.unknown() });

export function createMessageResultsRepository(supabase: SupabaseClient, log: Logger = logEvent): MessageResultsRepository {
  return {
    async insertResults(userId, messageId, payload) {
      const parsed = messageResultsPayloadSchema.safeParse(payload);
      if (!parsed.success) throw new RepositoryError("insertMessageResults");
      if (parsed.data.results.length === 0 && parsed.data.steps.length === 0) return;
      if (jsonbTextBytes(parsed.data) > MESSAGE_RESULTS_MAX_BYTES) throw new RepositoryError("insertMessageResults");
      const kinds = [...new Set(parsed.data.results.map((result) => result.kind))];
      const { error } = await supabase.from("message_results").insert({
        user_id: userId,
        message_id: messageId,
        kinds,
        payload: parsed.data,
      });
      if (error && isMissingResultsTable(error)) return;
      if (error) throw new RepositoryError("insertMessageResults");
    },

    async listForMessages(userId, messageIds) {
      const found = new Map<string, MessageResultsPayload>();
      const ids = [...new Set(messageIds)];
      for (let start = 0; start < ids.length; start += LIST_BATCH) {
        const batch = ids.slice(start, start + LIST_BATCH);
        const { data, error } = await supabase
          .from("message_results")
          .select("message_id, payload")
          .eq("user_id", userId)
          .in("message_id", batch);
        if (error && isMissingResultsTable(error)) return new Map();
        if (error) throw new RepositoryError("listMessageResults");
        for (const raw of Array.isArray(data) ? data : []) {
          const row = rowSchema.safeParse(raw);
          if (!row.success) continue;
          const payload = messageResultsPayloadSchema.safeParse(row.data.payload);
          if (!payload.success) {
            log("warn", "message_results_invalid", { messageId: row.data.message_id });
            continue;
          }
          found.set(row.data.message_id, payload.data);
        }
      }
      return found;
    },
  };
}
