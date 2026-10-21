import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ConfigError } from "@/lib/supabase-config";
import type { AuthContext } from "@/server/auth/session";
import { readChatStream } from "@/features/chat/stream";
import { FakeContextRecords, FakeQuota, FakeSpend, MemoryRepository, TEST_SPEND_CAPS, fakeDeps, testRouting } from "../support/fakes";
import { collect } from "../support/streams";
import { WriteFaults, describeCase, hasFault, sweepWriteFaults, type SweepCase, type WriteFault } from "../support/write-faults";

vi.mock("@/server/auth/session", () => ({ getAuthContext: vi.fn() }));
vi.mock("@/server/config", () => ({ getAssistantConfig: vi.fn(), getSiteUrl: () => "http://localhost:3000" }));
vi.mock("@/server/assistant/deps", () => ({ createAssistantDeps: vi.fn() }));
vi.mock("@/server/db/conversations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/db/conversations")>()),
  createConversationRepository: vi.fn(),
}));

const { getAuthContext } = await import("@/server/auth/session");
const { getAssistantConfig } = await import("@/server/config");
const { createAssistantDeps } = await import("@/server/assistant/deps");
const { createConversationRepository } = await import("@/server/db/conversations");
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

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  repo = new MemoryRepository();
  vi.mocked(createConversationRepository).mockReturnValue(repo);
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

describe("POST /api/chat when one write fails", () => {
  const MESSAGE = "Plan my week";
  type Variant = "new" | "existing" | "search";

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
    const fake = fakeDeps({ repo, spend, quota, contextRecords });
    vi.mocked(createAssistantDeps).mockReturnValue(fake.deps);
    signInAs(ALICE);

    const webSearch = variant === "search";
    const send = () =>
      chatRoute.POST(
        chatRequest({ action: "send", message: MESSAGE, webSearch, ...(existing ? { conversationId: existing.id } : {}) }),
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
      const retry = await chatRoute.POST(chatRequest({ action: "retry", conversationId, webSearch }));
      const retried = await events(retry);
      if (retry.status !== 409) expect(retried.at(-1)?.type, `${at}: retry`).toBe("done");
    }

    const spendFaults = faults.fired.filter((f) => f.label.startsWith("FakeSpend")).length;
    const openNebius = spend.reservations.filter((r) => r.provider === "nebius" && r.settled === null).length;
    expect(openNebius, `${at}: only a failed spend write leaves a Nebius hold counted`).toBeLessThanOrEqual(spendFaults);
    // A search that was sent keeps its Tavily credit (decision 0006).
    const openTavily = spend.reservations.filter((r) => r.provider === "tavily" && r.settled === null).length;
    expect(openTavily, `${at}: Tavily holds`).toBeLessThanOrEqual(fake.searches.length + spendFaults);
    if (webSearch) expect(spend.reservations.some((r) => r.provider === "tavily"), `${at}: search spend`).toBe(true);

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

    if (!checkDuplicates) return;
    expect(mine, `${at}: no extra conversation`).toHaveLength(1);
    expect(thread.map((m) => m.role), `${at}: one message and one reply`).toEqual(["user", "assistant"]);
  }

  it.each(["new", "existing", "search"] as const)(
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
        ...(variant === "search" ? ["FakeSpend.reserve:tavily"] : []),
      ]) {
        expect(labels, label).toContain(label);
      }
    },
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
