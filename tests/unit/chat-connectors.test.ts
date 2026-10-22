import { describe, expect, it } from "vitest";
import { createConnectorForRequest } from "@/server/assistant/deps";
import { prepareChatTurn, streamChatTurn, type AssistantDeps } from "@/server/assistant/service";
import type { ToolCall } from "@/server/assistant/tools";
import { bindTavily } from "@/server/assistant/workflows/core";
import { createGoogleConnector, type GoogleConnector } from "@/server/connectors/google/connector";
import type { LogFields, LogLevel } from "@/server/log";
import type { CompletionChunk, ModelCallRequest } from "@/server/providers/model";
import type { AuthContext } from "@/server/auth/session";
import type { ChatRequest, ChatStreamEvent } from "@/types/api";
import { jsonbTextBytes, MESSAGE_RESULTS_MAX_BYTES } from "@/server/db/message-results";
import type { CalendarResult, FlightResult } from "@/types/workflows";
import {
  ALICE_GOOGLE,
  CALENDAR_SCOPE,
  connectorEnv,
  EMAIL_SCOPE,
  FakeConnectorDb,
  FakeGoogle,
  seedGrant,
  testConnectorConfig,
} from "../support/connector-fakes";
import { FakeMemories, FakeMessageResults, FakeSpend, MemoryRepository, fakeDeps } from "../support/fakes";
import { collect } from "../support/streams";
import { fakeTavilyFetch, ScriptedProvider, textReply, toolReply, type ScriptedReply } from "../support/workflow-fakes";

// The Google connector inside a chat turn (decision 0016, decision 0011's
// amendment and decision 0015's tainted replies): fake Google and a fake
// connector_grants table, with the real connector and token code.

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const MESSAGE = "What is on my calendar today?";
const WINDOW = { time_min: "2026-10-21T00:00:00Z", time_max: "2026-10-22T00:00:00Z" };
const CHIP_OFF = "Not run: Google is off for this message. Answer without it; the user can turn Google on in the composer.";
const ROME2RIO = "https://www.rome2rio.com/s/London/New-York";
const FLIGHT_ITEM = {
  airline_text: "Norse Atlantic",
  price_text: "£299",
  quote: "Norse Atlantic from £299 on Thu 12 Nov 2026, nonstop",
  source: 1,
};

const USAGE = { promptTokens: 100, completionTokens: 20 };

function call(id: string, name: string, args: unknown): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function callsReply(...calls: ToolCall[]): CompletionChunk[] {
  return [
    { type: "tool_calls", calls },
    { type: "finish", finishReason: "tool_calls", usage: USAGE },
  ];
}

interface Logged {
  level: LogLevel;
  event: string;
  fields: LogFields;
}

async function setup(
  options: {
    hops?: ScriptedReply[];
    scopes?: string[];
    status?: "active" | "needs_reconnect";
    seed?: boolean;
    allowed?: string;
    connector?: "real" | "none";
    /** Also wire the flight workflow on a fake Tavily. */
    workflow?: boolean;
  } = {},
) {
  const config = testConnectorConfig(options.allowed ? { CONNECTOR_ALLOWED_USER_IDS: options.allowed } : {});
  const db = new FakeConnectorDb();
  const google = new FakeGoogle();
  google.clock = () => NOW;
  const tokens = google.issue(ALICE_GOOGLE);
  if (options.seed !== false) {
    await seedGrant(db, config, {
      userId: ALICE,
      refreshToken: tokens.refresh,
      accessToken: tokens.access,
      accessExpiresAt: new Date(NOW + 3_000_000).toISOString(),
      scopes: options.scopes,
      status: options.status,
    });
  }
  google.events["primary-id@example.com"] = [
    { summary: "Standup", start: { dateTime: "2026-10-21T09:00:00Z" }, end: { dateTime: "2026-10-21T09:15:00Z" }, organizer: { self: true } },
    { summary: "Offsite", start: { date: "2026-10-21" }, end: { date: "2026-10-22" }, organizer: { self: false } },
  ];

  const connectorLogs: Logged[] = [];
  let built = 0;
  const factory = (): GoogleConnector | null => {
    built += 1;
    if (options.connector === "none") return null;
    return createGoogleConnector({
      supabase: db.client(ALICE),
      userId: ALICE,
      config,
      fetchImpl: google.fetch,
      now: () => NOW,
      log: (level, event, fields = {}) => connectorLogs.push({ level, event, fields }),
    });
  };

  const chat: ModelCallRequest[] = [];
  const hops = options.hops ?? [textReply("Nothing to do.")];
  const provider = new ScriptedProvider((request) => {
    if (typeof request.toolChoice === "object" && request.toolChoice.function.name === "submit_flight_spans") {
      return toolReply("submit_flight_spans", { items: [FLIGHT_ITEM] });
    }
    const hop = chat.length;
    chat.push(request);
    return hops[hop] ?? textReply("Done.");
  });
  const repo = new MemoryRepository();
  const spend = new FakeSpend();
  const messageResults = new FakeMessageResults();
  const tavily = fakeTavilyFetch({
    search: (_body, index) => (index === 0 ? [{ url: ROME2RIO, title: "London to New York flights", content: "fares", score: 0.9 }] : []),
    pages: { [ROME2RIO]: `## London to New York\n${FLIGHT_ITEM.quote}` },
  });
  const made = fakeDeps({
    repo,
    spend,
    provider,
    messageResults,
    connector: factory,
    ...(options.workflow ? { workflowTavily: bindTavily({ apiKey: "tvly-test" }, tavily.fetchImpl) } : {}),
  });
  return { ...made, repo, spend, chat, db, google, messageResults, connectorLogs, builtCount: () => built };
}

async function run(deps: AssistantDeps, request: ChatRequest) {
  const prepared = await prepareChatTurn(deps, { userId: ALICE, requestId: "req-chat-google", request });
  if (!prepared.ok) throw new Error(`prepare failed: ${prepared.message}`);
  const events = await collect(streamChatTurn(deps, prepared.turn, new AbortController().signal));
  return { turn: prepared.turn, events };
}

const chipOn = (extra: Partial<Extract<ChatRequest, { action: "send" }>> = {}): ChatRequest => ({
  action: "send",
  message: MESSAGE,
  webSearch: false,
  connectors: { google: true },
  timeZone: "Europe/London",
  ...extra,
});

const toolNames = (request: ModelCallRequest | undefined) => (request?.tools ?? []).map((tool) => tool.function.name);
const doneOf = (events: ChatStreamEvent[]) => {
  const done = events.at(-1);
  if (done?.type !== "done") throw new Error(`no done event: ${JSON.stringify(done)}`);
  return done;
};

describe("the Google chip", () => {
  it.each([
    ["missing", {}],
    ["off", { connectors: { google: false } }],
    ["an empty connectors object", { connectors: {} }],
  ] as const)("chip %s: no Google tools, no grant read, and a call to one is refused without running", async (_label, extra) => {
    const { deps, chat, db, google, builtCount } = await setup({
      hops: [callsReply(call("call_c", "calendar_list_events", WINDOW)), textReply("I cannot see your calendar.")],
    });
    // The time zone marks the new chat screen, which reads step events.
    const request: ChatRequest = { action: "send", message: MESSAGE, webSearch: false, timeZone: "Europe/London", ...extra };
    const { turn, events } = await run(deps, request);

    expect(turn.googleChip).toBe(false);
    expect(builtCount()).toBe(0);
    expect(toolNames(chat[0])).toEqual(["web_search"]);
    expect(chat[1]!.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_c", content: CHIP_OFF });
    expect(google.requests).toEqual([]);
    expect(db.queries).toEqual([]);
    expect(events).toContainEqual({ type: "step", step: { id: "google-call_c", label: "Google is off for this message", status: "failed" } });
    expect(events.some((e) => e.type === "result")).toBe(false);
    // Nothing outside was read, so the reply is not tainted.
    expect(doneOf(events)).toMatchObject({ autoActions: true });
  });

  it("chip on with an active grant offers the Google tools after the others, by granted scope", async () => {
    const all = await setup();
    await run(all.deps, chipOn());
    expect(toolNames(all.chat[0])).toEqual(["web_search", "calendar_list_events", "drive_search_files", "drive_read_file"]);
    expect(all.builtCount()).toBe(1);

    const calendarOnly = await setup({ scopes: [CALENDAR_SCOPE, "openid", EMAIL_SCOPE] });
    await run(calendarOnly.deps, chipOn());
    expect(toolNames(calendarOnly.chat[0])).toEqual(["web_search", "calendar_list_events"]);
  });

  it("holds for the Google tools before the stream when the chip is on", async () => {
    const off = await setup();
    await prepareChatTurn(off.deps, { userId: ALICE, requestId: "r", request: chipOn({ connectors: { google: false } }) });
    const on = await setup();
    await prepareChatTurn(on.deps, { userId: ALICE, requestId: "r", request: chipOn() });
    expect(on.spend.reservations[0]!.held).toBeGreaterThan(off.spend.reservations[0]!.held);
  });

  it("offers nothing for a grant that needs reconnecting, and says so in one step line", async () => {
    const { deps, chat, google } = await setup({ status: "needs_reconnect" });
    const { events } = await run(deps, chipOn());
    expect(toolNames(chat[0])).toEqual(["web_search"]);
    expect(events).toContainEqual({ type: "step", step: { id: "google.grant", label: "Google needs reconnecting", status: "failed" } });
    expect(google.apiRequests()).toEqual([]);
    expect(doneOf(events)).toMatchObject({ autoActions: true });
  });

  it("offers nothing without a grant, for a user who is not allowed, or when connectors are not configured", async () => {
    for (const options of [{ seed: false }, { allowed: BOB }, { connector: "none" as const }]) {
      const { deps, chat } = await setup(options);
      const { events } = await run(deps, chipOn());
      expect(toolNames(chat[0]), JSON.stringify(options)).toEqual(["web_search"]);
      expect(doneOf(events).message.results).toBeUndefined();
    }
  });
});

describe("a Google read inside the chat turn", () => {
  it("turns the connector's outcome into the tool message, a step line and a result card", async () => {
    const { deps, chat, google, messageResults, waited } = await setup({
      hops: [callsReply(call("call_c", "calendar_list_events", WINDOW)), textReply("You have a standup at 09:00 and an offsite.")],
    });
    const { events } = await run(deps, chipOn());
    await Promise.all(waited);

    const tool = chat[1]!.messages.at(-1)!;
    expect(tool).toMatchObject({ role: "tool", tool_call_id: "call_c", name: "calendar_list_events" });
    expect(tool.content.startsWith('<connector_results provider="google-calendar">')).toBe(true);
    expect(tool.content.endsWith("</connector_results>")).toBe(true);
    expect(google.apiRequests().length).toBeGreaterThan(0);

    // One line, updated in place: running, then the connector's own outcome.
    const steps = events.filter((e) => e.type === "step");
    expect(steps).toEqual([
      { type: "step", step: { id: "google-call_c", label: "Reading your calendar", status: "running" } },
      { type: "step", step: { id: "google-call_c", label: "Read 2 events from your calendar", status: "done" } },
    ]);
    const result = events.find((e) => e.type === "result");
    expect(result?.type === "result" && result.result).toMatchObject({ kind: "calendar", window: { start: WINDOW.time_min, end: WINDOW.time_max } });
    expect(result?.type === "result" && (result.result as CalendarResult).events.map((e) => e.title).sort()).toEqual(["Offsite", "Standup"]);

    const done = doneOf(events);
    expect(done.message.content).toBe("You have a standup at 09:00 and an offsite.");
    expect(done.message.results).toEqual({
      results: [expect.objectContaining({ kind: "calendar" })],
      steps: [{ id: "google-call_c", label: "Read 2 events from your calendar", status: "done" }],
    });
    expect(messageResults.rows).toHaveLength(1);
    expect(messageResults.rows[0]!).toMatchObject({ userId: ALICE, messageId: done.message.id });
    expect(messageResults.rows[0]!.payload).toEqual(done.message.results);
  });

  it("taints the reply: later hops offer no web search, only Google reads, and Auto runs nothing", async () => {
    const { deps, chat } = await setup({
      hops: [callsReply(call("call_c", "calendar_list_events", WINDOW)), textReply("Here is your day.")],
    });
    const { events } = await run(deps, chipOn());

    expect(toolNames(chat[0])).toEqual(["web_search", "calendar_list_events", "drive_search_files", "drive_read_file"]);
    // A Google read sends nothing outside Google and P-Dot, so another one may follow; web search may not.
    expect(toolNames(chat[1])).toEqual(["calendar_list_events", "drive_search_files", "drive_read_file"]);
    expect(chat).toHaveLength(2);
    expect(doneOf(events)).toMatchObject({ autoActions: false, message: { content: "Here is your day." } });
  });

  it("reads the file a Drive search found, in the next hop of the same reply", async () => {
    const FILE_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345";
    const { deps, chat, google, messageResults, waited } = await setup({
      hops: [
        callsReply(call("call_s", "drive_search_files", { query: "trip plan" })),
        callsReply(call("call_r", "drive_read_file", { file_id: FILE_ID })),
        textReply("Your plan says to leave on Friday."),
      ],
    });
    google.files = [{ id: FILE_ID, name: "Trip plan", mimeType: "application/vnd.google-apps.document", content: "Leave on Friday." }];
    const { events } = await run(deps, chipOn({ message: "What does my trip plan say?" }));
    await Promise.all(waited);

    expect(toolNames(chat[1])).toEqual(["calendar_list_events", "drive_search_files", "drive_read_file"]);
    const read = chat[2]!.messages.find((m) => m.role === "tool" && m.tool_call_id === "call_r")!;
    expect(read.content.startsWith('<connector_results provider="google-drive">')).toBe(true);
    expect(read.content).toContain("Leave on Friday.");
    expect(google.apiRequests().some((r) => r.url.pathname.endsWith("/export"))).toBe(true);
    // The hop after the second read is the answer: hops are bounded as before.
    expect(chat).toHaveLength(3);
    expect(chat[2]!.tools).toBeUndefined();
    const done = doneOf(events);
    expect(done).toMatchObject({ autoActions: false });
    expect(messageResults.rows[0]!.payload.results.map((r) => r.kind)).toEqual(["drive", "drive"]);
  });

  it("refuses a web search on a tainted hop that still offers tools", async () => {
    const { deps, chat, searches } = await setup({
      hops: [
        callsReply(call("call_c", "calendar_list_events", WINDOW)),
        callsReply(call("call_w", "web_search", { query: "standup notes" })),
        textReply("Here is your day."),
      ],
    });
    deps.memories = new FakeMemories();
    const { events } = await run(deps, chipOn());

    expect(toolNames(chat[1])).toEqual(["save_memory", "calendar_list_events", "drive_search_files", "drive_read_file"]);
    expect(chat[2]!.messages.at(-1)).toMatchObject({
      role: "tool",
      tool_call_id: "call_w",
      content: "Not run: this reply already read outside results, so it cannot search or read accounts again. Answer with what you have.",
    });
    expect(searches).toEqual([]);
    expect(doneOf(events)).toMatchObject({ autoActions: false });
  });

  it("offers and runs no Google read after a workflow result, so web content never drives an account read", async () => {
    const { deps, chat, google } = await setup({
      workflow: true,
      hops: [callsReply(call("call_c", "calendar_list_events", WINDOW)), textReply("Norse Atlantic from £299 [1].")],
    });
    deps.memories = new FakeMemories();
    const { events } = await run(deps, chipOn({ message: "Find flights from London to New York on 12 November" }));

    // The code-run flight check came first; the model's hop offers no Google tool and no web tool.
    expect(toolNames(chat[0])).toEqual(["save_memory"]);
    expect(chat[1]!.messages.find((m) => m.role === "tool" && m.tool_call_id === "call_c")).toMatchObject({
      content: "Not run: this reply already read outside results, so it cannot search or read accounts again. Answer with what you have.",
    });
    expect(google.apiRequests()).toEqual([]);
    expect(doneOf(events)).toMatchObject({ autoActions: false });
  });

  it("trims an oversized results payload to fit, instead of losing the cards and steps on reload", async () => {
    const day = (d: number) => ({ time_min: `2026-11-${String(d).padStart(2, "0")}T00:00:00Z`, time_max: `2026-11-${String(d + 1).padStart(2, "0")}T00:00:00Z` });
    const { deps, google, messageResults, waited, logs } = await setup({
      workflow: true,
      hops: [
        callsReply(
          call("call_f", "search_flights", { origin: "London", destination: "New York", depart_date: "2026-11-12" }),
          call("call_1", "calendar_list_events", day(10)),
          call("call_2", "calendar_list_events", day(11)),
          call("call_3", "calendar_list_events", day(12)),
        ),
        textReply("Norse Atlantic from £299 [1]; a £199 fare also exists."),
      ],
    });
    // 25 events per read, with long titles and places: about 1 KB each as stored.
    google.events["primary-id@example.com"] = Array.from({ length: 25 }, (_, i) => ({
      summary: `Planning meeting ${i} ${"x".repeat(180)}`,
      location: `Conference room ${i} ${"y".repeat(180)}`,
      htmlLink: `https://www.google.com/calendar/event?eid=${"e".repeat(100)}${i}`,
      start: { dateTime: "2026-11-12T09:00:00Z" },
      end: { dateTime: "2026-11-12T09:30:00Z" },
      organizer: { self: true },
    }));
    const { events } = await run(
      deps,
      chipOn({ message: "Find me a flight, leaving London and going to New York on 12 November, and check my calendar" }),
    );
    await Promise.all(waited);

    const done = doneOf(events);
    const live = done.message.results!;
    expect(jsonbTextBytes(live)).toBeGreaterThan(MESSAGE_RESULTS_MAX_BYTES);
    expect(messageResults.rows).toHaveLength(1);
    const stored = messageResults.rows[0]!.payload;
    expect(jsonbTextBytes(stored)).toBeLessThanOrEqual(MESSAGE_RESULTS_MAX_BYTES);
    // The stored payload says it was cut; the live one the screen got was not.
    expect(stored.trimmed).toBe(true);
    expect(live.trimmed).toBeUndefined();
    expect(stored.results.map((r) => r.kind)).toEqual(["flights", "calendar", "calendar", "calendar"]);
    // The flight summary and its unverified mentions are never cut; the calendar lists are.
    const flights = stored.results[0] as FlightResult;
    expect(flights.summary).toBe((live.results[0] as FlightResult).summary);
    expect(flights.unverifiedMentions).toEqual(["£199"]);
    for (const result of stored.results.slice(1)) {
      expect((result as CalendarResult).events.length).toBeLessThan(25);
      expect((result as CalendarResult).events.length).toBeGreaterThanOrEqual(5);
    }
    expect(stored.steps.map((s) => s.id)).toEqual(live.steps.map((s) => s.id));
    const trimmed = logs.find((l) => l.event === "message_results_trimmed");
    expect(trimmed?.fields).toMatchObject({ fits: true });
    expect(Number(trimmed?.fields.events)).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).not.toContain("Planning meeting");
  });

  it("does not list the user's own calendar times as unverified on a flight card read in the same hop", async () => {
    const day = { time_min: "2026-11-12T00:00:00Z", time_max: "2026-11-13T00:00:00Z" };
    const { deps, google, messageResults, waited } = await setup({
      workflow: true,
      hops: [
        callsReply(
          call("call_f", "search_flights", { origin: "London", destination: "New York", depart_date: "2026-11-12" }),
          call("call_c", "calendar_list_events", day),
        ),
        textReply("Norse Atlantic from £299 [1]. You have the dentist at 14:30 that day; a £199 fare departs 07:15."),
      ],
    });
    google.events["primary-id@example.com"] = [
      { summary: "Dentist", start: { dateTime: "2026-11-12T14:30:00Z" }, end: { dateTime: "2026-11-12T15:00:00Z" }, organizer: { self: true } },
    ];
    // Not a form code reads, so the model calls the flight check and the calendar in one hop.
    const { events } = await run(
      deps,
      chipOn({ message: "Find me a flight, leaving London and going to New York on 12 November, and check my calendar" }),
    );
    await Promise.all(waited);

    const done = doneOf(events);
    expect(done.message.results!.results.map((r) => r.kind)).toEqual(["flights", "calendar"]);
    const flights = done.message.results!.results[0] as FlightResult;
    // 14:30 is the calendar event the connector read; the invented fare and time are still listed.
    expect(flights.unverifiedMentions).toEqual(["£199", "07:15"]);
    expect((messageResults.rows[0]!.payload.results[0] as FlightResult).unverifiedMentions).toEqual(["£199", "07:15"]);
  });

  it("logs the connector's tool, status and count, never account text", async () => {
    const { deps, logs, connectorLogs } = await setup({
      hops: [callsReply(call("call_c", "calendar_list_events", WINDOW)), textReply("Your day.")],
    });
    await run(deps, chipOn());
    const all = JSON.stringify([...logs, ...connectorLogs]);
    for (const secret of ["Standup", "Offsite", "alice@example.com", "ya29", "1//refresh"]) expect(all).not.toContain(secret);
    expect(logs.find((l) => l.event === "chat_completed")?.fields).toMatchObject({ connectorCalls: 1, tainted: true, results: 1 });
  });
});

describe("createConnectorForRequest", () => {
  const auth = { userId: ALICE, email: "alice@example.com", supabase: new FakeConnectorDb().client(ALICE) } as AuthContext;

  it("builds one connector per request, or null when connectors are not configured", () => {
    const make = createConnectorForRequest(auth, connectorEnv() as NodeJS.ProcessEnv);
    const first = make();
    expect(first).not.toBeNull();
    expect(make()).toBe(first);
    expect(createConnectorForRequest(auth, connectorEnv({ GOOGLE_CLIENT_SECRET: undefined }) as NodeJS.ProcessEnv)()).toBeNull();
  });

  it("turns a malformed setting into null and logs only the variable name", () => {
    const logs: Logged[] = [];
    const make = createConnectorForRequest(auth, connectorEnv({ CONNECTOR_TOKEN_KEYS: "not json, secret-value" }) as NodeJS.ProcessEnv, (level, event, fields = {}) =>
      logs.push({ level, event, fields }),
    );
    expect(make()).toBeNull();
    expect(logs).toEqual([{ level: "warn", event: "connector_config_invalid", fields: expect.objectContaining({ names: "CONNECTOR_TOKEN_KEYS" }) }]);
    expect(JSON.stringify(logs)).not.toContain("secret-value");
  });
});

