import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ConfigError } from "@/lib/supabase-config";
import type { AuthContext } from "@/server/auth/session";
import { readChatStream } from "@/features/chat/stream";
import { bindTavily } from "@/server/assistant/workflows/core";
import { createGoogleConnector } from "@/server/connectors/google/connector";
import type { ModelCallRequest } from "@/server/providers/model";
import type { MessageResultsPayload } from "@/types/workflows";
import { ALICE_GOOGLE, FakeConnectorDb, FakeGoogle, seedGrant, testConnectorConfig } from "../support/connector-fakes";
import {
  FakeContextRecords,
  FakeMessageResults,
  FakeQuota,
  FakeSpend,
  MemoryRepository,
  TEST_SPEND_CAPS,
  fakeDeps,
  testRouting,
} from "../support/fakes";
import { collect } from "../support/streams";
import { fakeTavilyFetch, ScriptedProvider, textReply, toolReply, type ScriptedReply } from "../support/workflow-fakes";
import { WriteFaults, describeCase, hasFault, sweepWriteFaults, type SweepCase, type WriteFault } from "../support/write-faults";

vi.mock("@/server/auth/session", () => ({ getAuthContext: vi.fn() }));
vi.mock("@/server/config", () => ({ getAssistantConfig: vi.fn(), getSiteUrl: () => "http://localhost:3000" }));
vi.mock("@/server/assistant/deps", () => ({ createAssistantDeps: vi.fn() }));
vi.mock("@/server/db/conversations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/db/conversations")>()),
  createConversationRepository: vi.fn(),
}));
vi.mock("@/server/db/message-results", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/db/message-results")>()),
  createMessageResultsRepository: vi.fn(),
}));

const { getAuthContext } = await import("@/server/auth/session");
const { getAssistantConfig } = await import("@/server/config");
const { createAssistantDeps } = await import("@/server/assistant/deps");
const { createConversationRepository } = await import("@/server/db/conversations");
const { createMessageResultsRepository } = await import("@/server/db/message-results");
const chatRoute = await import("@/app/api/chat/route");
const listRoute = await import("@/app/api/conversations/route");
const itemRoute = await import("@/app/api/conversations/[id]/route");

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function signInAs(userId: string | null) {
  vi.mocked(getAuthContext).mockResolvedValue(
    userId ? ({ userId, email: `${userId}@example.com`, supabase: {} as SupabaseClient } satisfies AuthContext) : null,
  );
}

function chatRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function itemRequest(method: string, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/conversations/x", {
    method,
    headers: { host: "localhost", origin: "http://localhost", ...headers },
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

let repo: MemoryRepository;
let storedResults: FakeMessageResults;

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  repo = new MemoryRepository();
  vi.mocked(createConversationRepository).mockReturnValue(repo);
  storedResults = new FakeMessageResults();
  vi.mocked(createMessageResultsRepository).mockReturnValue(storedResults);
  vi.mocked(getAssistantConfig).mockReturnValue({
    nebius: { apiKey: "k", baseUrl: "https://nebius.test/v1" },
    ollama: { baseUrl: "http://127.0.0.1:11434/v1", embeddingModel: null },
    routing: testRouting(),
    tavily: null,
    quota: { requestsPerWindow: 30, windowSeconds: 3600 },
    spend: TEST_SPEND_CAPS,
  });
  vi.mocked(createAssistantDeps).mockReturnValue(fakeDeps({ repo }).deps);
});

describe("POST /api/chat", () => {
  it("rejects signed-out requests before touching providers", async () => {
    signInAs(null);
    const response = await chatRoute.POST(chatRequest({ action: "send", message: "hi", webSearch: false }));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "unauthorized" } });
    expect(createAssistantDeps).not.toHaveBeenCalled();
  });

  it("rejects cross-origin browser requests", async () => {
    signInAs(ALICE);
    const response = await chatRoute.POST(
      chatRequest({ action: "send", message: "hi", webSearch: false }, { origin: "https://evil.example" }),
    );
    expect(response.status).toBe(403);
    expect(getAuthContext).not.toHaveBeenCalled();
  });

  it.each([
    ["non-JSON content type", "hello", { "content-type": "text/plain" }, 415, "unsupported_media_type"],
    ["oversized body", { action: "send", message: "x".repeat(20_000), webSearch: false }, {}, 413, "payload_too_large"],
    ["malformed JSON", "{", {}, 400, "invalid_request"],
    ["schema violation", { action: "send", message: "", webSearch: false }, {}, 400, "invalid_request"],
    ["client-supplied user ID", { action: "send", message: "hi", webSearch: false, userId: BOB }, {}, 400, "invalid_request"],
  ])("rejects %s", async (_label, body, headers, status, code) => {
    signInAs(ALICE);
    const response = await chatRoute.POST(chatRequest(body, headers as Record<string, string>));
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
    expect(createAssistantDeps).not.toHaveBeenCalled();
  });

  it("returns 503 without details when inference is not configured", async () => {
    signInAs(ALICE);
    vi.mocked(getAssistantConfig).mockImplementation(() => {
      throw new ConfigError(["NEBIUS_API_KEY"]);
    });
    const response = await chatRoute.POST(chatRequest({ action: "send", message: "hi", webSearch: false }));
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).toContain("not_configured");
    expect(text).not.toContain("NEBIUS_API_KEY");
  });

  it("streams NDJSON events for the session user", async () => {
    signInAs(ALICE);
    const response = await chatRoute.POST(chatRequest({ action: "send", message: "hi", webSearch: false }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const events = await collect(readChatStream(response.body!));
    expect(events.map((e) => e.type)).toEqual(["start", "delta", "delta", "done"]);
    expect(repo.conversations[0]!.userId).toBe(ALICE);
  });

  it("returns 404 when posting into another user's conversation", async () => {
    const theirs = await repo.createConversation(ALICE, "private");
    signInAs(BOB);
    const response = await chatRoute.POST(
      chatRequest({ action: "send", conversationId: theirs.id, message: "hi", webSearch: false }),
    );
    expect(response.status).toBe(404);
    expect(repo.messages).toHaveLength(0);
  });

  it("returns 429 with Retry-After when over the usage limit", async () => {
    signInAs(ALICE);
    vi.mocked(createAssistantDeps).mockReturnValue(fakeDeps({ repo, quota: new FakeQuota(false) }).deps);
    const response = await chatRoute.POST(chatRequest({ action: "send", message: "hi", webSearch: false }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeTruthy();
  });

  it("returns budget_exhausted before streaming when the daily spend cap is reached", async () => {
    signInAs(ALICE);
    const spend = new FakeSpend();
    spend.refuse.nebius = "day";
    vi.mocked(createAssistantDeps).mockReturnValue(fakeDeps({ repo, spend }).deps);
    const response = await chatRoute.POST(chatRequest({ action: "send", message: "hi", webSearch: false }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeTruthy();
    const body = await response.json();
    expect(body.error).toMatchObject({
      code: "budget_exhausted",
      message: "P-Dot has reached its daily usage limit. Try again tomorrow.",
    });
    expect(repo.messages).toHaveLength(0);
  });

  it("returns 500, not a reply, when the spend cap cannot be checked", async () => {
    signInAs(ALICE);
    const spend = new FakeSpend();
    spend.failReserve = true;
    vi.mocked(createAssistantDeps).mockReturnValue(fakeDeps({ repo, spend }).deps);
    const response = await chatRoute.POST(chatRequest({ action: "send", message: "hi", webSearch: false }));
    expect(response.status).toBe(500);
    expect(repo.messages).toHaveLength(0);
  });
});

/** A flight search reply: the code-run flight check on a fake Tavily, then a text answer (decision 0015). */
const FLIGHT_MESSAGE = "Find me cheap flights from London to New York on 12 November";
const ROME2RIO = "https://www.rome2rio.com/s/London/New-York";

function flightModel(): ScriptedProvider {
  return new ScriptedProvider((request: ModelCallRequest): ScriptedReply => {
    const forced = typeof request.toolChoice === "object" ? request.toolChoice.function.name : null;
    if (forced === "submit_flight_spans") {
      return toolReply("submit_flight_spans", {
        items: [{ airline_text: "Norse Atlantic", price_text: "£299", quote: "Norse Atlantic from £299 on Thu 12 Nov 2026, nonstop", source: 1 }],
      });
    }
    return textReply("Norse Atlantic has a fare from £299 [1]. Confirm on the links.");
  });
}

/** A calendar question with the Google chip on: one read, then a text answer (decision 0016). */
function calendarModel(): ScriptedProvider {
  return new ScriptedProvider((request: ModelCallRequest): ScriptedReply => {
    if (request.messages.at(-1)?.role === "tool") return textReply("You have a standup at 09:00.");
    return toolReply("calendar_list_events", { time_min: "2026-10-21T00:00:00Z", time_max: "2026-10-22T00:00:00Z" });
  });
}

/**
 * The real Google connector on a fake grant table and a fake Google, with an
 * access token that expires within the refresh margin, so a chat turn writes
 * the refreshed token, last_used_at and, for a revoked grant, the status.
 */
async function googleForChat(revoked: boolean) {
  const config = testConnectorConfig();
  const db = new FakeConnectorDb();
  const google = new FakeGoogle();
  const tokens = google.issue(ALICE_GOOGLE);
  await seedGrant(db, config, {
    userId: ALICE,
    refreshToken: tokens.refresh,
    accessToken: tokens.access,
    accessExpiresAt: new Date(Date.now() + 10_000).toISOString(),
  });
  google.events["primary-id@example.com"] = [
    { summary: "Standup", start: { dateTime: "2026-10-21T09:00:00Z" }, end: { dateTime: "2026-10-21T09:15:00Z" }, organizer: { self: true } },
  ];
  if (revoked) google.refreshError = { status: 400, error: "invalid_grant" };
  const connector = () => createGoogleConnector({ supabase: db.client(ALICE), userId: ALICE, config, fetchImpl: google.fetch, log: () => {} });
  return { db, google, connector };
}

function flightTavily() {
  return fakeTavilyFetch({
    search: (_body, index) => (index === 0 ? [{ url: ROME2RIO, title: "London to New York flights", content: "fares", score: 0.9 }] : []),
    pages: { [ROME2RIO]: "## London to New York\nNorse Atlantic from £299 on Thu 12 Nov 2026, nonstop" },
  });
}

describe("POST /api/chat when one write fails", () => {
  const MESSAGE = "Plan my week";
  /** "google": a calendar read that refreshes the token; "revoked": a refresh that gets invalid_grant. */
  type Variant = "new" | "existing" | "search" | "workflow" | "google" | "revoked";

  /**
   * Faults that leave a duplicate today (see the it.fails tests below). A case
   * with one of them is still checked for stuck rows and for an error answer.
   */
  const KNOWN_DUPLICATES: Record<Variant, [WriteFault, string][]> = {
    new: [
      ["refused", "MemoryRepository.insertMessage:user"],
      ["lost", "MemoryRepository.createConversation"],
      ["lost", "MemoryRepository.insertMessage:user"],
    ],
    search: [
      ["refused", "MemoryRepository.insertMessage:user"],
      ["lost", "MemoryRepository.createConversation"],
      ["lost", "MemoryRepository.insertMessage:user"],
    ],
    existing: [["lost", "MemoryRepository.insertMessage:user"]],
    workflow: [
      ["refused", "MemoryRepository.insertMessage:user"],
      ["lost", "MemoryRepository.createConversation"],
      ["lost", "MemoryRepository.insertMessage:user"],
    ],
    google: [
      ["refused", "MemoryRepository.insertMessage:user"],
      ["lost", "MemoryRepository.createConversation"],
      ["lost", "MemoryRepository.insertMessage:user"],
    ],
    revoked: [
      ["refused", "MemoryRepository.insertMessage:user"],
      ["lost", "MemoryRepository.createConversation"],
      ["lost", "MemoryRepository.insertMessage:user"],
    ],
  };

  async function chatScenario(
    variant: Variant,
    faults: WriteFaults,
    sweepCase: SweepCase,
    checkDuplicates = !KNOWN_DUPLICATES[variant].some(([fault, label]) => hasFault(sweepCase, fault, label)),
    strictRecord = false,
  ) {
    const at = `${variant} conversation, ${describeCase(sweepCase)}`;
    repo = new MemoryRepository();
    const spend = new FakeSpend();
    const quota = new FakeQuota();
    const contextRecords = new FakeContextRecords();
    const messageResults = new FakeMessageResults();
    const workflow = variant === "workflow";
    const googleRead = variant === "google" || variant === "revoked";
    const tavily = flightTavily();
    const google = googleRead ? await googleForChat(variant === "revoked") : null;
    const existing = variant === "existing" ? await repo.createConversation(ALICE, "Earlier", "personal") : null;
    faults.wrap(repo, ["createConversation", "insertMessage"], {
      detail: (method, args) => (method === "insertMessage" ? String((args[1] as { role: string }).role) : ""),
    });
    faults.wrap(spend, ["reserve", "settle"], {
      detail: (method, args) =>
        method === "reserve" ? String(args[0]) : (spend.reservations.find((r) => r.id === args[0])?.provider ?? "unknown"),
    });
    faults.wrap(quota, ["consume"]);
    faults.wrap(contextRecords, ["insertContextRecord"]);
    faults.wrap(messageResults, ["insertResults"]);
    if (google) {
      // The grant table's writes (token store, last_used_at, status) and Google's token endpoint.
      faults.wrap(google.db, ["write"], {
        label: "db",
        detail: (_method, args) => String(args[0]),
        failWith: (error) => ({ data: null, error: { message: error.message } }),
      });
      faults.wrap(google.google, ["tokenWrite"], {
        label: "google",
        failWith: () => new Response(JSON.stringify({ error: "backend_error" }), { status: 503 }),
      });
    }
    const fake = fakeDeps({
      repo,
      spend,
      quota,
      contextRecords,
      messageResults,
      ...(workflow ? { provider: flightModel(), workflowTavily: bindTavily({ apiKey: "tvly-test" }, tavily.fetchImpl) } : {}),
      ...(google ? { provider: calendarModel(), connector: google.connector } : {}),
    });
    vi.mocked(createAssistantDeps).mockReturnValue(fake.deps);
    signInAs(ALICE);

    const webSearch = variant === "search" || workflow;
    const chips = google ? { connectors: { google: true }, timeZone: "UTC" } : {};
    const send = () =>
      chatRoute.POST(
        chatRequest({
          action: "send",
          message: workflow ? FLIGHT_MESSAGE : MESSAGE,
          webSearch,
          ...chips,
          ...(existing ? { conversationId: existing.id } : {}),
        }),
      );
    const events = async (response: Response) => {
      const read = response.status === 200 ? await collect(readChatStream(response.body!)) : [];
      await Promise.all(fake.waited.splice(0));
      return read;
    };

    const first = await send();
    const firstEvents = await events(first);
    faults.disarm();
    const started = firstEvents.find((e) => e.type === "start");
    const done = firstEvents.some((e) => e.type === "done");
    if (!started) expect(first.status, `${at}: an error before the stream`).toBeGreaterThanOrEqual(500);
    if (started && !done) expect(firstEvents.at(-1)?.type, at).toBe("error");

    // Recover like the chat screen: no start means the draft comes back and the user sends
    // again; a start without done means the screen offers "Retry reply".
    if (!started) {
      const again = await events(await send());
      expect(again.at(-1)?.type, `${at}: resend`).toBe("done");
    } else if (!done) {
      const conversationId = started.type === "start" ? started.conversation.id : "";
      const retry = await chatRoute.POST(chatRequest({ action: "retry", conversationId, webSearch, ...chips }));
      const retried = await events(retry);
      if (retry.status !== 409) expect(retried.at(-1)?.type, `${at}: retry`).toBe("done");
    }

    const spendFaults = faults.fired.filter((f) => f.label.startsWith("FakeSpend")).length;
    const openNebius = spend.reservations.filter((r) => r.provider === "nebius" && r.settled === null).length;
    expect(openNebius, `${at}: only a failed spend write leaves a Nebius hold counted`).toBeLessThanOrEqual(spendFaults);
    // A search that was sent keeps its Tavily credit (decision 0006); so does each workflow call that was sent.
    const openTavily = spend.reservations.filter((r) => r.provider === "tavily" && r.settled === null).length;
    expect(openTavily, `${at}: Tavily holds`).toBeLessThanOrEqual(fake.searches.length + tavily.calls.length + spendFaults);
    if (variant === "search") expect(spend.reservations.some((r) => r.provider === "tavily"), `${at}: search spend`).toBe(true);

    const mine = repo.conversations.filter((c) => c.userId === ALICE);
    const target = existing ?? mine.at(-1);
    const thread = repo.messages.filter((m) => m.conversationId === target?.id);
    const reply = thread.at(-1);
    expect(reply?.role, `${at}: the last message has its reply`).toBe("assistant");

    const records = contextRecords.records.filter((r) => r.messageId === reply?.id);
    // A refused record write only logs a warning (decision 0009). A lost reply response is the known defect below.
    const recordMayBeMissing =
      hasFault(sweepCase, "refused", "FakeContextRecords.insertContextRecord") ||
      (!strictRecord && hasFault(sweepCase, "lost", "MemoryRepository.insertMessage:assistant"));
    if (!recordMayBeMissing) expect(records, `${at}: one "what was sent" record for the reply`).toHaveLength(1);
    expect(records.length, at).toBeLessThanOrEqual(1);
    expect(contextRecords.records.length, `${at}: no record without a saved reply`).toBeLessThanOrEqual(1);

    // The workflow's results and steps, once, for the saved reply (decision 0015). A refused
    // write only logs a warning; a lost reply response is the same known defect as the record.
    const results = messageResults.rows.filter((r) => r.messageId === reply?.id);
    const resultsMayBeMissing =
      !(workflow || googleRead) ||
      hasFault(sweepCase, "refused", "FakeMessageResults.insertResults") ||
      (!strictRecord && hasFault(sweepCase, "lost", "MemoryRepository.insertMessage:assistant"));
    if (!resultsMayBeMissing) expect(results, `${at}: one results row for the reply`).toHaveLength(1);
    expect(results.length, at).toBeLessThanOrEqual(1);
    expect(messageResults.rows.length, `${at}: no results without a saved reply`).toBeLessThanOrEqual(workflow || googleRead ? 1 : 0);
    for (const row of results) {
      expect(row.userId, at).toBe(ALICE);
      expect(row.payload.steps.every((step) => step.status !== "running"), `${at}: no step left running`).toBe(true);
    }

    if (google) {
      // One grant, never in between: a refresh that worked keeps it active and usable, and an
      // invalid_grant answer marks it needs_reconnect unless that status write was refused.
      expect(google.db.grants, at).toHaveLength(1);
      const status = google.db.grants[0]!.status;
      if (variant === "google") {
        expect(status, at).toBe("active");
        // The grant still works for the next message: a fresh read succeeds.
        const outcome = await google.connector().run(
          { id: "call_check", type: "function", function: { name: "calendar_list_events", arguments: JSON.stringify({ time_min: "2026-10-21T00:00:00Z", time_max: "2026-10-22T00:00:00Z" }) } },
        );
        expect(outcome.failed, `${at}: the grant still reads`).toBe(false);
      } else if (!hasFault(sweepCase, "refused", "db.write:update")) {
        expect(status, at).toBe("needs_reconnect");
      }
    }

    if (!checkDuplicates) return;
    expect(mine, `${at}: no extra conversation`).toHaveLength(1);
    expect(thread.map((m) => m.role), `${at}: one message and one reply`).toEqual(["user", "assistant"]);
  }

  it.each(["new", "existing", "search", "workflow", "google", "revoked"] as const)(
    "%s conversation: every write, up to two faults, ends with one message, its reply and its record",
    async (variant) => {
      const cases = await sweepWriteFaults((faults, sweepCase) => chatScenario(variant, faults, sweepCase));
      const labels = new Set(cases.map((c) => c.at(-1)!.label));
      for (const label of [
        "FakeQuota.consume",
        "FakeSpend.reserve:nebius",
        "MemoryRepository.insertMessage:user",
        "MemoryRepository.insertMessage:assistant",
        "FakeSpend.settle:nebius",
        "FakeContextRecords.insertContextRecord",
        ...(variant === "search" || variant === "workflow" ? ["FakeSpend.reserve:tavily"] : []),
        ...(variant === "workflow" || variant === "google" || variant === "revoked" ? ["FakeMessageResults.insertResults"] : []),
        // The connector's own writes during the chat turn (decision 0016).
        ...(variant === "google" ? ["db.write:rpc.store_connector_tokens", "db.write:update", "google.tokenWrite"] : []),
        ...(variant === "revoked" ? ["db.write:update"] : []),
      ]) {
        expect(labels, label).toContain(label);
      }
    },
    // About 200 runs each; the workflow ones read pages too, which is slow when every file runs at once.
    60_000,
  );

  // Defect: these writes happen before the stream starts, so the route answers 500 and the
  // screen gives the draft back. A resend then repeats work the first request already saved.
  it.fails.each([
    ["new", "refused", "MemoryRepository.insertMessage:user", "leaves an empty conversation"],
    ["new", "lost", "MemoryRepository.createConversation", "leaves an empty conversation"],
    ["new", "lost", "MemoryRepository.insertMessage:user", "leaves a second conversation with the same message"],
    ["existing", "lost", "MemoryRepository.insertMessage:user", "saves the user message twice"],
  ] as const)("%s conversation, %s %s, then a resend: %s", async (variant, fault, label, _defect) => {
    void _defect;
    const dry = new WriteFaults();
    await chatScenario(variant, dry, []);
    const step = dry.calls.indexOf(label) + 1;
    expect(step).toBeGreaterThan(0);
    await chatScenario(variant, new WriteFaults().fail(fault, step), [{ step, fault, label }], true);
  });

  // Defect: the reply is saved but its response is lost, so the turn ends with an error and
  // writes no "what was sent" record. The retry gets 409, so the saved reply never gets one.
  it.fails("a lost response on the reply write: the saved reply has its record", async () => {
    const label = "MemoryRepository.insertMessage:assistant";
    const dry = new WriteFaults();
    await chatScenario("existing", dry, []);
    const step = dry.calls.indexOf(label) + 1;
    await chatScenario("existing", new WriteFaults().fail("lost", step), [{ step, fault: "lost", label }], true, true);
  });
});

describe("/api/conversations", () => {
  it("requires a session", async () => {
    signInAs(null);
    expect((await listRoute.GET(itemRequest("GET"))).status).toBe(401);
    expect((await itemRoute.GET(itemRequest("GET"), params(ALICE))).status).toBe(401);
    expect((await itemRoute.DELETE(itemRequest("DELETE"), params(ALICE))).status).toBe(401);
  });

  it("lists only the signed-in user's conversations", async () => {
    await repo.createConversation(ALICE, "Alice 1");
    await repo.createConversation(BOB, "Bob 1");
    signInAs(ALICE);
    const body = await (await listRoute.GET(itemRequest("GET"))).json();
    expect(body.conversations.map((c: { title: string }) => c.title)).toEqual(["Alice 1"]);
  });

  it("returns a conversation with its messages to its owner", async () => {
    const own = await repo.createConversation(ALICE, "Mine");
    await repo.insertMessage(ALICE, { conversationId: own.id, role: "user", content: "hello" });
    signInAs(ALICE);
    const response = await itemRoute.GET(itemRequest("GET"), params(own.id));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: own.id, title: "Mine", messages: [{ content: "hello" }] });
  });

  it("attaches each assistant reply's stored results and steps, and only the owner's", async () => {
    const own = await repo.createConversation(ALICE, "Trip");
    await repo.insertMessage(ALICE, { conversationId: own.id, role: "user", content: "flights?" });
    const reply = await repo.insertMessage(ALICE, { conversationId: own.id, role: "assistant", content: "Here." });
    const plain = await repo.insertMessage(ALICE, { conversationId: own.id, role: "assistant", content: "Plain." });
    const payload: MessageResultsPayload = {
      results: [{ kind: "drive", files: [{ id: "abcdefghij12", name: "Plan", kind: "doc" }] }],
      steps: [{ id: "google-call_1", label: "Found 1 file in Drive", status: "done" }],
    };
    await storedResults.insertResults(ALICE, reply.id, payload);
    await storedResults.insertResults(BOB, plain.id, payload);
    const listed = vi.spyOn(storedResults, "listForMessages");
    signInAs(ALICE);

    const body = await (await itemRoute.GET(itemRequest("GET"), params(own.id))).json();
    expect(body.messages.map((m: { content: string; results?: unknown }) => [m.content, m.results ?? null])).toEqual([
      ["flights?", null],
      ["Here.", payload],
      ["Plain.", null],
    ]);
    // Only the assistant replies are looked up, for the session user.
    expect(listed).toHaveBeenCalledWith(ALICE, [reply.id, plain.id]);
  });

  it("still returns the conversation without cards when the results cannot be read", async () => {
    const own = await repo.createConversation(ALICE, "Trip");
    await repo.insertMessage(ALICE, { conversationId: own.id, role: "assistant", content: "Here." });
    vi.spyOn(storedResults, "listForMessages").mockRejectedValue(new Error("db down: postgres://secret"));
    signInAs(ALICE);
    const response = await itemRoute.GET(itemRequest("GET"), params(own.id));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("secret");
    expect(JSON.parse(text).messages).toEqual([expect.not.objectContaining({ results: expect.anything() })]);
  });

  it("hides other users' conversations behind 404, including malformed IDs", async () => {
    const theirs = await repo.createConversation(ALICE, "Alice private");
    signInAs(BOB);
    expect((await itemRoute.GET(itemRequest("GET"), params(theirs.id))).status).toBe(404);
    expect((await itemRoute.GET(itemRequest("GET"), params("../../etc"))).status).toBe(404);
  });

  it("does not let one user delete another user's conversation", async () => {
    const theirs = await repo.createConversation(ALICE, "Alice private");
    signInAs(BOB);
    const response = await itemRoute.DELETE(itemRequest("DELETE"), params(theirs.id));
    expect(response.status).toBe(404);
    expect(repo.conversations).toHaveLength(1);
  });

  it("deletes the owner's conversation and its messages", async () => {
    const own = await repo.createConversation(ALICE, "Mine");
    await repo.insertMessage(ALICE, { conversationId: own.id, role: "user", content: "hello" });
    signInAs(ALICE);
    const response = await itemRoute.DELETE(itemRequest("DELETE"), params(own.id));
    expect(response.status).toBe(204);
    expect(repo.conversations).toHaveLength(0);
    expect(repo.messages).toHaveLength(0);
  });

  it("rejects cross-origin deletes", async () => {
    const own = await repo.createConversation(ALICE, "Mine");
    signInAs(ALICE);
    const response = await itemRoute.DELETE(itemRequest("DELETE", { origin: "https://evil.example" }), params(own.id));
    expect(response.status).toBe(403);
    expect(repo.conversations).toHaveLength(1);
  });

  it("returns JSON 500 without internals when storage fails", async () => {
    signInAs(ALICE);
    vi.spyOn(repo, "listConversations").mockRejectedValue(new Error("connection string postgres://secret"));
    const response = await listRoute.GET(itemRequest("GET"));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain("internal_error");
    expect(text).not.toContain("secret");
  });
});
