import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { RepositoryError } from "@/server/db/conversations";
import {
  createMessageResultsRepository,
  fitResultsPayload,
  isMissingResultsTable,
  jsonbTextBytes,
  MESSAGE_RESULTS_MAX_BYTES,
  messageResultsPayloadSchema,
} from "@/server/db/message-results";
import type { LogFields, LogLevel } from "@/server/log";
import type {
  CalendarEventItem,
  CalendarResult,
  DriveResult,
  FlightResult,
  MessageResultsPayload,
  WorkflowStep,
} from "@/types/workflows";
import { SAMPLE_RESULTS_PAYLOAD as PAYLOAD } from "../support/workflow-fakes";

// Repository for message_results (decision 0015, "Persistence"), against a
// fake Supabase query builder.

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MESSAGE = "11111111-1111-4111-8111-111111111111";

interface Call {
  table: string;
  op: "insert" | "select" | "";
  payload?: unknown;
  columns?: string;
  filters: [string, string, unknown][];
}

type Result = { data?: unknown; error: { code?: string; message?: string } | null };

function fakeSupabase(responses: { insert?: Result; selects?: Result[] } = {}) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const call: Call = { table, op: "", filters: [] };
      calls.push(call);
      const builder = {
        insert(payload: unknown) {
          call.op = "insert";
          call.payload = payload;
          return Promise.resolve(responses.insert ?? { error: null });
        },
        select(columns: string) {
          call.op = "select";
          call.columns = columns;
          return builder;
        },
        eq(column: string, value: unknown) {
          call.filters.push(["eq", column, value]);
          return builder;
        },
        in(column: string, values: unknown) {
          call.filters.push(["in", column, values]);
          return builder;
        },
        then(resolve: (value: Result) => unknown, reject: (reason: unknown) => unknown) {
          return Promise.resolve(responses.selects?.shift() ?? { data: [], error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

function repository(responses?: Parameters<typeof fakeSupabase>[0]) {
  const fake = fakeSupabase(responses);
  const logs: { level: LogLevel; event: string; fields: LogFields }[] = [];
  const repo = createMessageResultsRepository(fake.client, (level, event, fields = {}) => {
    logs.push({ level, event, fields });
  });
  return { repo, calls: fake.calls, logs };
}

describe("message results repository", () => {
  it("inserts one row with the user's ID, the kinds and the checked payload", async () => {
    const { repo, calls } = repository();
    await repo.insertResults(ALICE, MESSAGE, PAYLOAD);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      table: "message_results",
      op: "insert",
      payload: { user_id: ALICE, message_id: MESSAGE, kinds: ["flights", "research", "calendar", "drive"], payload: PAYLOAD },
    });
  });

  it("refuses a payload that fails the strict schema or the size check, without a write", async () => {
    const extraKey = { ...PAYLOAD, note: "x" } as unknown as MessageResultsPayload;
    const unsafeUrl = structuredClone(PAYLOAD);
    (unsafeUrl.results[0] as { links: { label: string; url: string }[] }).links[0]!.url = "javascript:alert(1)";
    const huge = structuredClone(PAYLOAD);
    huge.steps = Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, label: "中".repeat(300), status: "done" as const, detail: "中".repeat(500) }));
    expect(jsonbTextBytes(huge)).toBeGreaterThan(MESSAGE_RESULTS_MAX_BYTES);
    for (const payload of [extraKey, unsafeUrl, huge]) {
      const { repo, calls } = repository();
      await expect(repo.insertResults(ALICE, MESSAGE, payload)).rejects.toBeInstanceOf(RepositoryError);
      expect(calls).toHaveLength(0);
    }
  });

  it("writes nothing for an empty payload", async () => {
    const { repo, calls } = repository();
    await repo.insertResults(ALICE, MESSAGE, { results: [], steps: [] });
    expect(calls).toHaveLength(0);
  });

  it("does nothing when the table does not exist yet, and throws for any other error", async () => {
    const missing = repository({ insert: { error: { code: "42P01", message: 'relation "public.message_results" does not exist' } } });
    await expect(missing.repo.insertResults(ALICE, MESSAGE, PAYLOAD)).resolves.toBeUndefined();
    const other = repository({ insert: { error: { code: "23503", message: "insert or update violates foreign key constraint" } } });
    await expect(other.repo.insertResults(ALICE, MESSAGE, PAYLOAD)).rejects.toBeInstanceOf(RepositoryError);
    const otherTable = repository({ insert: { error: { code: "42P01", message: 'relation "public.messages" does not exist' } } });
    await expect(otherTable.repo.insertResults(ALICE, MESSAGE, PAYLOAD)).rejects.toBeInstanceOf(RepositoryError);
  });

  it("lists payloads by message ID, filtered by the user, and skips a row that fails the schema", async () => {
    const other = "22222222-2222-4222-8222-222222222222";
    const { repo, calls, logs } = repository({
      selects: [
        {
          data: [
            { message_id: MESSAGE, payload: PAYLOAD },
            { message_id: other, payload: { results: [{ kind: "flights", injected: "<b>" }], steps: [] } },
          ],
          error: null,
        },
      ],
    });
    const found = await repo.listForMessages(ALICE, [MESSAGE, other, MESSAGE]);
    expect([...found.keys()]).toEqual([MESSAGE]);
    expect(found.get(MESSAGE)).toEqual(PAYLOAD);
    expect(calls[0]).toMatchObject({
      table: "message_results",
      op: "select",
      columns: "message_id, payload",
      filters: [
        ["eq", "user_id", ALICE],
        ["in", "message_id", [MESSAGE, other]],
      ],
    });
    // The warning names the message only.
    expect(logs).toEqual([{ level: "warn", event: "message_results_invalid", fields: { messageId: other } }]);
  });

  it("reads in batches and sends nothing for no IDs", async () => {
    const none = repository();
    expect((await none.repo.listForMessages(ALICE, [])).size).toBe(0);
    expect(none.calls).toHaveLength(0);
    const ids = Array.from({ length: 150 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const many = repository();
    await many.repo.listForMessages(ALICE, ids);
    expect(many.calls.map((c) => (c.filters[1]![2] as string[]).length)).toEqual([100, 50]);
  });

  it("treats a missing table as no results, and any other error as a failure", async () => {
    for (const error of [
      { code: "42P01", message: 'relation "message_results" does not exist' },
      { code: "PGRST205", message: "Could not find the table 'public.message_results' in the schema cache" },
      { code: "PGRST200", message: "Could not find a relationship between 'messages' and 'message_results' in the schema cache" },
    ]) {
      const { repo } = repository({ selects: [{ data: null, error }] });
      expect((await repo.listForMessages(ALICE, [MESSAGE])).size, error.code).toBe(0);
    }
    const { repo } = repository({ selects: [{ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }] });
    await expect(repo.listForMessages(ALICE, [MESSAGE])).rejects.toBeInstanceOf(RepositoryError);
  });
});

describe("isMissingResultsTable", () => {
  it("matches only the exact errors that name message_results", () => {
    expect(isMissingResultsTable({ code: "42P01", message: 'relation "public.message_results" does not exist' })).toBe(true);
    expect(isMissingResultsTable({ code: "PGRST205", message: "Could not find the table 'message_results' in the schema cache" })).toBe(true);
    expect(isMissingResultsTable({ code: "PGRST200", message: "Could not find a relationship between 'message_results' and 'messages' in the schema cache" })).toBe(true);
    expect(isMissingResultsTable({ code: "42P01", message: 'relation "public.message_results_old" does not exist' })).toBe(false);
    expect(isMissingResultsTable({ code: "PGRST205", message: "Could not find the table 'public.messages' in the schema cache" })).toBe(false);
    expect(isMissingResultsTable({ code: "42703", message: 'column "message_results" does not exist' })).toBe(false);
    expect(isMissingResultsTable({ message: 'relation "public.message_results" does not exist' })).toBe(false);
    expect(isMissingResultsTable(null)).toBe(false);
  });
});

describe("payload schema", () => {
  it("accepts every result kind and rejects unknown kinds and keys", () => {
    expect(messageResultsPayloadSchema.safeParse(PAYLOAD).success).toBe(true);
    expect(messageResultsPayloadSchema.safeParse({ results: [{ kind: "email" }], steps: [] }).success).toBe(false);
    expect(messageResultsPayloadSchema.safeParse({ ...PAYLOAD, steps: [{ id: "a", label: "b", status: "maybe" }] }).success).toBe(false);
    expect(messageResultsPayloadSchema.safeParse({ results: [] }).success).toBe(false);
  });

  it("measures the payload as Postgres prints jsonb", () => {
    expect(jsonbTextBytes({ a: 1, b: [1, 2], c: "中" })).toBe(new TextEncoder().encode('{"a": 1, "b": [1, 2], "c": "中"}').length);
    expect(jsonbTextBytes({})).toBe(2);
    expect(jsonbTextBytes([])).toBe(2);
    expect(jsonbTextBytes({ a: undefined, b: null })).toBe('{"b": null}'.length);
  });

  it("accepts the optional fields newer rows carry, and older rows without them", () => {
    const newer = structuredClone(PAYLOAD);
    newer.trimmed = true;
    const research = newer.results[1]!;
    if (research.kind === "research") research.unverifiedMentions = ["$50", "11:15"];
    const drive = newer.results[3]!;
    if (drive.kind === "drive" && drive.read) drive.read.capped = true;
    expect(messageResultsPayloadSchema.safeParse(newer).success).toBe(true);
    // The rows written before these fields existed still read.
    expect(messageResultsPayloadSchema.safeParse(PAYLOAD).success).toBe(true);
    // They are typed: a string is not a flag.
    expect(messageResultsPayloadSchema.safeParse({ ...PAYLOAD, trimmed: "yes" }).success).toBe(false);
    const badCap = structuredClone(newer);
    const badDrive = badCap.results[3]!;
    if (badDrive.kind === "drive" && badDrive.read) (badDrive.read as { capped: unknown }).capped = "yes";
    expect(messageResultsPayloadSchema.safeParse(badCap).success).toBe(false);
  });
});

describe("fitResultsPayload", () => {
  const event = (i: number): CalendarEventItem => ({
    title: `Planning meeting ${i} ${"中".repeat(150)}`,
    start: "2026-11-12T09:00:00Z",
    end: "2026-11-12T09:30:00Z",
    allDay: false,
    calendar: "Work",
    location: `Room ${i} ${"y".repeat(150)}`,
    fromOthers: false,
  });
  const calendar = (n: number): CalendarResult => ({
    kind: "calendar",
    events: Array.from({ length: n }, (_, i) => event(i)),
    window: { start: "2026-11-12T00:00:00Z", end: "2026-11-13T00:00:00Z" },
  });
  const flights = PAYLOAD.results[0] as FlightResult;

  it("returns a payload that fits as it is, without a trim or a mark", () => {
    const fitted = fitResultsPayload(PAYLOAD);
    expect(fitted).toEqual({ payload: PAYLOAD, trim: null, fits: true });
    expect(fitted.payload.trimmed).toBeUndefined();
  });

  it("cuts four 25-event calendar reads to fit, keeps the flight result whole, and marks the payload", () => {
    const payload: MessageResultsPayload = {
      results: [flights, calendar(25), calendar(25), calendar(25), calendar(25)],
      steps: PAYLOAD.steps,
    };
    expect(jsonbTextBytes(payload)).toBeGreaterThan(MESSAGE_RESULTS_MAX_BYTES);
    const before = structuredClone(payload);
    const fitted = fitResultsPayload(payload);

    expect(fitted.fits).toBe(true);
    expect(jsonbTextBytes(fitted.payload)).toBeLessThanOrEqual(MESSAGE_RESULTS_MAX_BYTES);
    expect(messageResultsPayloadSchema.safeParse(fitted.payload).success).toBe(true);
    expect(fitted.payload.trimmed).toBe(true);
    // The flight summary, its fares and its unverified mentions are never cut.
    expect(fitted.payload.results[0]).toEqual(flights);
    expect(fitted.payload.results.map((r) => r.kind)).toEqual(["flights", "calendar", "calendar", "calendar", "calendar"]);
    for (const result of fitted.payload.results.slice(1)) {
      const kept = (result as CalendarResult).events.length;
      expect(kept).toBeLessThan(25);
      expect(kept).toBeGreaterThanOrEqual(5);
    }
    expect(fitted.trim).toMatchObject({ details: 1, files: 0, quotes: 0, results: 0 });
    expect(fitted.trim!.events).toBeGreaterThan(0);
    // The steps stay, without their details; the payload passed in is not changed.
    expect(fitted.payload.steps.map((s) => s.id)).toEqual(PAYLOAD.steps.map((s) => s.id));
    expect(fitted.payload.steps.every((s) => s.detail === undefined)).toBe(true);
    expect(payload).toEqual(before);
  });

  it("drops step details, largest first, before any list", () => {
    const steps: WorkflowStep[] = [
      { id: "a", label: "Read a file", status: "done", detail: "x".repeat(400) },
      { id: "b", label: "Read a file", status: "done", detail: "short" },
    ];
    const payload: MessageResultsPayload = { results: [calendar(6)], steps };
    const limit = jsonbTextBytes(payload) - 100;
    const fitted = fitResultsPayload(payload, limit);
    expect(fitted.fits).toBe(true);
    expect(fitted.payload.steps).toEqual([{ id: "a", label: "Read a file", status: "done" }, steps[1]]);
    expect((fitted.payload.results[0] as CalendarResult).events).toHaveLength(6);
    expect(fitted.trim).toEqual({ details: 1, events: 0, files: 0, quotes: 0, results: 0 });
  });

  it("then cuts the quotes after the first three fares, then whole calendar and Drive results, last first", () => {
    const option = flights.options[0]!;
    const many: FlightResult = {
      ...flights,
      options: Array.from({ length: 8 }, (_, i) => ({ ...option, priceText: `£${400 + i}`, amount: 400 + i, quote: `British Airways from £${400 + i} ${"q".repeat(200)}` })),
      unverifiedMentions: ["$299", "07:15"],
    };
    const drive: DriveResult = { kind: "drive", files: [{ id: "abcdefghij12", name: "Plan", kind: "doc" }] };
    const payload: MessageResultsPayload = { results: [many, calendar(5), drive], steps: [] };

    const quotesOnly = fitResultsPayload(payload, jsonbTextBytes(payload) - 500);
    expect(quotesOnly.fits).toBe(true);
    const cut = quotesOnly.payload.results[0] as FlightResult;
    expect(cut.options.slice(0, 3).map((o) => o.quote)).toEqual(many.options.slice(0, 3).map((o) => o.quote));
    expect(cut.options.slice(3).some((o) => o.quote === "")).toBe(true);
    expect(cut.options.map((o) => o.priceText)).toEqual(many.options.map((o) => o.priceText));
    expect(quotesOnly.payload.results).toHaveLength(3);

    // No room even after every quote: the Drive result goes first, then the calendar; the flights stay.
    const tight = fitResultsPayload(payload, jsonbTextBytes({ ...payload, results: [many], trimmed: true }) - 1_000);
    expect(tight.payload.results.map((r) => r.kind)).toEqual(["flights"]);
    expect(tight.trim).toMatchObject({ results: 2 });
    const kept = tight.payload.results[0] as FlightResult;
    expect(kept.summary).toBe(many.summary);
    expect(kept.unverifiedMentions).toEqual(["$299", "07:15"]);
    expect(tight.fits).toBe(true);
  });

  it("says it does not fit when nothing more can be cut, and leaves the payload unmarked when nothing was cut", () => {
    const payload: MessageResultsPayload = { results: [flights], steps: [{ id: "a", label: "Searched", status: "done" }] };
    const fitted = fitResultsPayload(payload, 100);
    expect(fitted.fits).toBe(false);
    expect(fitted.payload.trimmed).toBeUndefined();
    expect(fitted.payload.results[0]).toEqual(flights);
  });
});
