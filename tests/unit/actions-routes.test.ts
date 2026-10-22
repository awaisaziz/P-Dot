import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthContext } from "@/server/auth/session";
import type { Embedder } from "@/server/assistant/embed";
import { actionPayloadSchema } from "@/lib/schemas";
import { RepositoryError } from "@/server/db/conversations";
import { createActionProposalRepository } from "@/server/db/action-proposals";
import { ProviderError } from "@/server/providers/errors";
import { EMBEDDING_MODEL } from "@/server/providers/nebius/embeddings";
import { FakeSpend, TEST_SPEND_CAPS, testEmbedder, testRouting } from "../support/fakes";
import { WriteFaults, describeCase, sweepWriteFaults, type SweepCase } from "../support/write-faults";

vi.mock("@/server/auth/session", () => ({ getAuthContext: vi.fn() }));
vi.mock("@/server/config", () => ({ getAssistantConfig: vi.fn(), getSiteUrl: () => "http://localhost:3000" }));
/** Work passed to waitUntil. Tests await it, as the Workers runtime would keep it alive. */
const { pendingWork } = vi.hoisted(() => ({ pendingWork: [] as Promise<unknown>[] }));
vi.mock("@/server/assistant/deps", () => ({
  createEmbedderForRequest: vi.fn(),
  waitUntil: (work: Promise<unknown>) => {
    pendingWork.push(work);
  },
}));

const { getAuthContext } = await import("@/server/auth/session");
const { getAssistantConfig } = await import("@/server/config");
const { createEmbedderForRequest } = await import("@/server/assistant/deps");
const listRoute = await import("@/app/api/actions/route");
const decisionRoute = await import("@/app/api/actions/[id]/decision/route");

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MISSING_ID = "99999999-9999-4999-8999-999999999999";
const DUE = "2026-10-30T17:00:00Z";
const VECTOR = [0.1, 0.2, 0.3];
/** Distinct text, so a test can find it if it ever reaches a log. */
const SECRET_TITLE = "Pay the Acme invoice";
const SECRET_MEMORY = "Lives in Leeds with a dog";

// ---------------------------------------------------------------------------
// A small in-memory stand-in for the Supabase query builder. It runs the real
// repositories and applies `eq`, `order`, `limit`, `select` (only the listed
// columns, like PostgREST), `single` and `maybeSingle`.
//
// `rpc("decide_action_proposal")` follows the contract of the database
// function in the migration: the same outcomes, the same claim on "proposed"
// rows of the session user, and "failed" with a code when the insert fails.
// The SQL itself is tested against a real Postgres (decision 0009). Tests can
// make an insert fail for one table, make the call itself fail, and run code
// just before the claim (to simulate a second request that wins a race).
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

class FakeDb {
  tables: Record<string, Row[]> = {
    action_proposals: [],
    action_log: [],
    tasks: [],
    reminders: [],
    memories: [],
  };
  /** When set, every insert into this table fails (also inside the decision function). */
  failInsertInto: string | null = null;
  /** When set, every select from this table answers with an error. */
  failReadFrom: string | null = null;
  /** Runs once, just before the next update on any table or the next claim. */
  beforeNextUpdate: (() => void) | null = null;
  /** When set, the next rpc call returns this error (for example a lost connection). */
  failRpc: { message: string } | null = null;
  /** The session user, as auth.uid() in the database. */
  uid: string | null = null;
  rpcCalls: { name: string; args: Row }[] = [];
  private seq = 0;

  nextTimestamp(): string {
    this.seq += 1;
    return new Date(Date.UTC(2026, 9, 19) + this.seq * 1000).toISOString();
  }

  from(table: string): FakeQuery {
    return new FakeQuery(this, table);
  }

  /** Every insert and update goes through here, so a test can make one fail. */
  async write(_table: string, run: () => FakeResult): Promise<FakeResult> {
    return run();
  }

  async rpc(name: string, args: Row): Promise<FakeResult> {
    this.rpcCalls.push({ name, args });
    if (this.failRpc) return { data: null, error: this.failRpc };
    if (name !== "decide_action_proposal") return { data: null, error: { message: "unknown function" } };
    return { data: this.decide(args.p_id as string, args.p_decision as string, args.p_payload as Row | null), error: null };
  }

  private decide(id: string, decision: string, payload: Row | null): Row {
    const answer = (outcome: string, row: Row | null) => {
      if (!row) return { outcome, proposal: null };
      const proposal = { ...row };
      delete proposal.user_id;
      return { outcome, proposal };
    };
    const row = this.tables.action_proposals!.find((r) => r.id === id && r.user_id === this.uid) ?? null;
    if (!row) return answer("not_found", null);
    if (row.status !== "proposed") return answer("already_decided", row);
    if (!["approve", "reject"].includes(decision) || (decision === "reject" && payload)) return answer("invalid", row);

    const claim = (): boolean => {
      const hook = this.beforeNextUpdate;
      this.beforeNextUpdate = null;
      hook?.();
      return row.status === "proposed";
    };

    if (decision === "reject") {
      if (!claim()) return answer("already_decided", row);
      Object.assign(row, { status: "rejected", decided_at: this.nextTimestamp(), decided_by_function: true });
      return answer("rejected", row);
    }

    if (payload && payload.kind !== row.kind) return answer("kind_mismatch", row);
    const parsed = actionPayloadSchema.safeParse(payload ?? row.payload);
    if (!parsed.success || parsed.data.kind !== row.kind) return answer("invalid", row);
    if (!claim()) return answer("already_decided", row);
    Object.assign(row, { status: "approved", decided_at: this.nextTimestamp(), payload: parsed.data, decided_by_function: true });

    const action = parsed.data;
    const table = action.kind === "create_task" ? "tasks" : action.kind === "create_reminder" ? "reminders" : "memories";
    if (this.failInsertInto === table) {
      Object.assign(row, { status: "failed", result: { error: "execution_failed", code: "23514" } });
      return answer("failed", row);
    }
    const newId = randomUUID();
    const base = { id: newId, user_id: this.uid, mode: action.mode, created_at: this.nextTimestamp() };
    if (action.kind === "create_task") {
      this.tables.tasks!.push({ ...base, title: action.title, done: false });
      row.result = { taskId: newId };
    } else if (action.kind === "create_reminder") {
      this.tables.reminders!.push({ ...base, title: action.title, due_at: action.dueAt, status: "scheduled", proposal_id: id });
      row.result = { reminderId: newId };
    } else {
      this.tables.memories!.push({
        ...base,
        content: action.content,
        status: "active",
        source: "assistant",
        source_message_id: null,
        embedding: null,
        embedding_model: null,
        updated_at: base.created_at,
      });
      row.result = { memoryId: newId };
    }
    row.status = "executed";
    return answer("executed", row);
  }
}

interface FakeResult {
  data: unknown;
  error: { message: string } | null;
  count?: number;
}

class FakeQuery implements PromiseLike<FakeResult> {
  private filters: { column: string; value: unknown }[] = [];
  private op: "select" | "insert" | "update" = "select";
  private payload: Row = {};
  private columns: string | null = null;
  private ordering: { column: string; ascending: boolean } | null = null;
  private max = Number.POSITIVE_INFINITY;
  private shape: "many" | "single" | "maybe" = "many";

  constructor(
    private readonly db: FakeDb,
    private readonly table: string,
  ) {}

  select(columns: string): this {
    this.columns = columns;
    return this;
  }
  insert(row: Row): this {
    this.op = "insert";
    this.payload = row;
    return this;
  }
  update(changes: Row): this {
    this.op = "update";
    this.payload = changes;
    return this;
  }
  eq(column: string, value: unknown): this {
    this.filters.push({ column, value });
    return this;
  }
  order(column: string, options?: { ascending?: boolean }): this {
    this.ordering = { column, ascending: options?.ascending !== false };
    return this;
  }
  limit(count: number): this {
    this.max = count;
    return this;
  }
  single(): this {
    this.shape = "single";
    return this;
  }
  maybeSingle(): this {
    this.shape = "maybe";
    return this;
  }

  then<T1 = FakeResult, T2 = never>(
    onFulfilled?: ((value: FakeResult) => T1 | PromiseLike<T1>) | null,
    onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): Promise<T1 | T2> {
    const result = this.op === "select" ? Promise.resolve(this.execute()) : this.db.write(this.table, () => this.execute());
    return result.then(onFulfilled, onRejected);
  }

  private project(row: Row): Row {
    const columns = (this.columns ?? "").split(",").map((c) => c.trim()).filter(Boolean);
    return Object.fromEntries(columns.map((c) => [c, row[c]]));
  }

  private execute(): FakeResult {
    if (this.op === "insert" && this.db.failInsertInto === this.table) {
      return { data: null, error: { message: "simulated insert failure" } };
    }
    if (this.op === "select" && this.db.failReadFrom === this.table) {
      return { data: null, error: { message: "simulated read failure" } };
    }
    if (this.op === "update" && this.db.beforeNextUpdate) {
      const hook = this.db.beforeNextUpdate;
      this.db.beforeNextUpdate = null;
      hook();
    }

    const rows = this.db.tables[this.table] ?? [];

    if (this.op === "insert") {
      const row: Row = {
        id: randomUUID(),
        created_at: this.db.nextTimestamp(),
        updated_at: this.db.nextTimestamp(),
        decided_at: null,
        result: null,
        conversation_id: null,
        source_message_id: null,
        proposal_id: null,
        status: "scheduled",
        done: false,
        embedding: null,
        embedding_model: null,
        ...this.payload,
      };
      rows.push(row);
      return { data: this.columns ? this.shapeOne([this.project(row)]) : null, error: null };
    }

    const matches = rows.filter((row) => this.filters.every((f) => row[f.column] === f.value));

    if (this.op === "update") {
      for (const row of matches) Object.assign(row, this.payload);
      return { data: this.columns ? this.shapeOne(matches.map((r) => this.project(r))) : null, error: null };
    }

    let found = [...matches];
    if (this.ordering) {
      const { column, ascending } = this.ordering;
      found.sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : 1) * (ascending ? 1 : -1));
    }
    found = found.slice(0, this.max);
    return { data: this.shapeOne(found.map((r) => this.project(r))), error: null };
  }

  /** Applies single() and maybeSingle(): one row or null. Otherwise the array. */
  private shapeOne(rows: Row[]): unknown {
    if (this.shape === "many") return rows;
    return rows[0] ?? null;
  }
}

// ---------------------------------------------------------------------------
// Test setup and helpers.
// ---------------------------------------------------------------------------

let db: FakeDb;
let embed: ReturnType<typeof vi.fn<(texts: string[], signal?: AbortSignal) => Promise<number[][]>>>;
let consoleLines: string[];

function signInAs(userId: string | null) {
  db.uid = userId;
  vi.mocked(getAuthContext).mockResolvedValue(
    userId ? ({ userId, email: `${userId}@example.com`, supabase: db as unknown as SupabaseClient } satisfies AuthContext) : null,
  );
}

function jsonRequest(url: string, method: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, {
    method,
    headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function plainRequest(url: string, method = "GET", headers: Record<string, string> = {}) {
  return new Request(url, { method, headers: { host: "localhost", origin: "http://localhost", ...headers } });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** Sends a decision, then waits for any work the route passed to waitUntil. */
async function decide(id: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await decisionRoute.POST(
    jsonRequest(`http://localhost/api/actions/${id}/decision`, "POST", body, headers),
    params(id),
  );
  await Promise.all(pendingWork.splice(0));
  return response;
}

const taskPayload = (title = "Pay the invoice") => ({ kind: "create_task" as const, mode: "personal" as const, title });
const reminderPayload = () => ({ kind: "create_reminder" as const, mode: "work" as const, title: "Call the supplier", dueAt: DUE });
const memoryPayload = (content = "Prefers short replies") => ({ kind: "save_memory" as const, mode: "personal" as const, content });

function seedProposal(userId: string, payload: Row, overrides: Partial<Row> = {}): Row {
  const row: Row = {
    id: randomUUID(),
    user_id: userId,
    conversation_id: null,
    kind: payload.kind,
    payload,
    summary: "Add a task",
    status: "proposed",
    result: null,
    created_at: db.nextTimestamp(),
    decided_at: null,
    ...overrides,
  };
  db.tables.action_proposals!.push(row);
  return row;
}

function storedProposal(id: string): Row | undefined {
  return db.tables.action_proposals!.find((r) => r.id === id);
}

function rowsOf(table: string, userId?: string): Row[] {
  return (db.tables[table] ?? []).filter((r) => userId === undefined || r.user_id === userId);
}

function logEvents(): Row[] {
  return db.tables.action_log ?? [];
}

beforeEach(() => {
  pendingWork.length = 0;
  db = new FakeDb();
  consoleLines = [];
  for (const level of ["info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((line: unknown) => {
      consoleLines.push(String(line));
    });
  }
  embed = vi.fn(async (texts: string[]) => texts.map(() => VECTOR));
  vi.mocked(createEmbedderForRequest).mockReturnValue({ embed } as Embedder);
  vi.mocked(getAssistantConfig).mockReturnValue({
    nebius: { apiKey: "k", baseUrl: "https://nebius.test/v1" },
    ollama: { baseUrl: "http://127.0.0.1:11434/v1", embeddingModel: null },
    routing: testRouting(),
    tavily: null,
    quota: { requestsPerWindow: 30, windowSeconds: 3600 },
    spend: TEST_SPEND_CAPS,
  });
});

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("sessions and origins", () => {
  it("requires a session on both routes and runs nothing", async () => {
    signInAs(null);
    const row = seedProposal(ALICE, taskPayload());
    const id = row.id as string;

    expect((await listRoute.GET(plainRequest("http://localhost/api/actions"))).status).toBe(401);
    expect((await decide(id, { decision: "approve" })).status).toBe(401);
    expect(storedProposal(id)?.status).toBe("proposed");
    expect(rowsOf("tasks")).toHaveLength(0);
  });

  it("rejects a cross-origin decision and changes nothing", async () => {
    signInAs(ALICE);
    const row = seedProposal(ALICE, taskPayload());
    const response = await decide(row.id as string, { decision: "approve" }, { origin: "https://evil.example" });
    expect(response.status).toBe(403);
    expect(storedProposal(row.id as string)?.status).toBe("proposed");
    expect(rowsOf("tasks")).toHaveLength(0);
  });
});

describe("GET /api/actions", () => {
  it("lists the user's proposals newest first, filters by status, and leaves out a row with a bad payload", async () => {
    signInAs(ALICE);
    const older = seedProposal(ALICE, taskPayload("older"), { summary: "older" });
    const newer = seedProposal(ALICE, reminderPayload(), { summary: "newer", status: "approved" });
    seedProposal(ALICE, { kind: "create_task", mode: "hobby", title: "bad mode" }, { summary: "bad" });
    seedProposal(BOB, taskPayload("bob's"), { summary: "bob" });

    const all = await (await listRoute.GET(plainRequest("http://localhost/api/actions"))).json();
    expect(all.actions.map((a: { id: string }) => a.id)).toEqual([newer.id, older.id]);
    expect(all.actions[0]).toMatchObject({
      id: newer.id,
      status: "approved",
      summary: "newer",
      payload: { kind: "create_reminder", mode: "work", title: "Call the supplier", dueAt: DUE },
    });

    const proposed = await (await listRoute.GET(plainRequest("http://localhost/api/actions?status=proposed"))).json();
    expect(proposed.actions.map((a: { id: string }) => a.id)).toEqual([older.id]);
  });

  it.each([
    ["an unknown status", "http://localhost/api/actions?status=archived"],
    ["an empty status", "http://localhost/api/actions?status="],
    ["a status in the wrong case", "http://localhost/api/actions?status=Proposed"],
  ])("answers 400 for %s", async (_label, url) => {
    signInAs(ALICE);
    expect((await listRoute.GET(plainRequest(url))).status).toBe(400);
  });
});

describe("POST /api/actions/:id/decision: request checks", () => {
  it.each([
    ["an unknown decision", { decision: "maybe" }],
    ["a missing decision", {}],
    ["an unknown field", { decision: "approve", userId: BOB }],
    ["a reject that carries a payload", { decision: "reject", payload: taskPayload("Changed") }],
    ["an edit that changes the kind", { decision: "approve", payload: reminderPayload() }],
    ["an edit with a blank title", { decision: "approve", payload: taskPayload("   ") }],
    ["a payload that is not an object", { decision: "approve", payload: "create_task" }],
  ])("answers 400 for %s and runs nothing", async (_label, body) => {
    signInAs(ALICE);
    const row = seedProposal(ALICE, taskPayload());
    const response = await decide(row.id as string, body);
    expect(response.status).toBe(400);
    expect(storedProposal(row.id as string)?.status).toBe("proposed");
    expect(rowsOf("tasks")).toHaveLength(0);
  });

  it("answers 400 when the edit changes the kind, using the stored kind in the message", async () => {
    signInAs(ALICE);
    const row = seedProposal(ALICE, taskPayload());
    const body = await (await decide(row.id as string, { decision: "approve", payload: reminderPayload() })).json();
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toBe("An edited action must keep the same kind.");
  });

  it("answers 415 for a body that is not JSON", async () => {
    signInAs(ALICE);
    const row = seedProposal(ALICE, taskPayload());
    const request = new Request(`http://localhost/api/actions/${row.id}/decision`, {
      method: "POST",
      headers: { host: "localhost", origin: "http://localhost", "content-type": "text/plain" },
      body: "decision=approve",
    });
    expect((await decisionRoute.POST(request, params(row.id as string))).status).toBe(415);
    expect(storedProposal(row.id as string)?.status).toBe("proposed");
  });

  it("answers 404 for an id that is not a UUID", async () => {
    signInAs(ALICE);
    expect((await decide("not-an-id", { decision: "approve" })).status).toBe(404);
  });
});

describe("POST /api/actions/:id/decision: ownership and stored payloads", () => {
  it("answers 404 for another user's proposal and runs nothing", async () => {
    signInAs(ALICE);
    const row = seedProposal(BOB, taskPayload("Bob's task"));
    const response = await decide(row.id as string, { decision: "approve" });
    expect(response.status).toBe(404);
    expect((await response.json()).error.message).toBe("Action not found.");
    expect(storedProposal(row.id as string)?.status).toBe("proposed");
    expect(rowsOf("tasks")).toHaveLength(0);
  });

  it("answers 404 for a stored payload that does not parse, and never runs it", async () => {
    signInAs(ALICE);
    const row = seedProposal(ALICE, { kind: "create_task", mode: "personal", title: "" });
    const response = await decide(row.id as string, { decision: "approve" });
    expect(response.status).toBe(404);
    expect(storedProposal(row.id as string)?.status).toBe("proposed");
    expect(rowsOf("tasks")).toHaveLength(0);
  });

  it("answers 404 for an unknown proposal", async () => {
    signInAs(ALICE);
    expect((await decide(MISSING_ID, { decision: "reject" })).status).toBe(404);
  });
});


describe("POST /api/actions/:id/decision: approve", () => {
  it("creates a task once and returns the executed proposal with the task ID", async () => {
    signInAs(ALICE);
    const row = seedProposal(ALICE, taskPayload());
    const response = await decide(row.id as string, { decision: "approve" });
    expect(response.status).toBe(200);
    const body = await response.json();
    const task = rowsOf("tasks", ALICE)[0] as Row;

    expect(rowsOf("tasks")).toHaveLength(1);
    expect(task).toMatchObject({ mode: "personal", title: "Pay the invoice", done: false });
    expect(body).toMatchObject({ id: row.id, status: "executed", result: { taskId: task.id }, decidedAt: expect.any(String) });
    expect(body).not.toHaveProperty("user_id");
    expect(body.verified).toBe(true);
    expect(storedProposal(row.id as string)).toMatchObject({ status: "executed", result: { taskId: task.id } });
  });

  it("sends one call to the database function, with no user ID", async () => {
    signInAs(ALICE);
    const row = seedProposal(ALICE, taskPayload());
    await decide(row.id as string, { decision: "approve" });
    expect(db.rpcCalls).toEqual([
      { name: "decide_action_proposal", args: { p_id: row.id, p_decision: "approve", p_payload: null } },
    ]);
  });

  it("creates a reminder once, linked to the proposal", async () => {
    signInAs(ALICE);
    const row = seedProposal(ALICE, reminderPayload());
    const response = await decide(row.id as string, { decision: "approve" });
    expect(response.status).toBe(200);
    const reminder = rowsOf("reminders", ALICE)[0] as Row;

    expect(rowsOf("reminders")).toHaveLength(1);
    expect(reminder).toMatchObject({ mode: "personal", title: "Call the supplier", due_at: DUE, proposal_id: row.id });
    expect((await response.json()).result).toEqual({ reminderId: reminder.id });
  });

  it.each([
    ["create_task", { ...taskPayload(), mode: "work" as const }, "tasks"],
    ["create_reminder", reminderPayload(), "reminders"],
    ["save_memory", { ...memoryPayload(), mode: "work" as const }, "memories"],
  ])("%s: a plain approval of a Work proposal sends the stored payload with WORKSPACE_MODE (decision 0014)", async (_kind, payload, table) => {
    signInAs(ALICE);
    const row = seedProposal(ALICE, payload);
    const response = await decide(row.id as string, { decision: "approve" });
    expect(response.status).toBe(200);
    expect(db.rpcCalls).toEqual([
      { name: "decide_action_proposal", args: { p_id: row.id, p_decision: "approve", p_payload: { ...payload, mode: "personal" } } },
    ]);
    expect(rowsOf(table, ALICE)).toEqual([expect.objectContaining({ mode: "personal" })]);
    expect(storedProposal(row.id as string)).toMatchObject({ status: "executed", payload: { ...payload, mode: "personal" } });
  });

  it("sends no payload for a plain approval of a proposal that already has WORKSPACE_MODE", async () => {
    signInAs(ALICE);
    const row = seedProposal(ALICE, memoryPayload());
    await decide(row.id as string, { decision: "approve" });
    expect(db.rpcCalls[0]?.args.p_payload).toBeNull();
  });

  it.each([
    ["a stored Work payload that does not parse", ALICE, { kind: "create_task", mode: "work", title: "" }, {}, 404],
    ["a stored Work payload that names another kind", ALICE, reminderPayload(), { kind: "create_task" }, 404],
    ["another user's Work proposal", BOB, reminderPayload(), {}, 404],
    ["a Work proposal that was already decided", ALICE, reminderPayload(), { status: "rejected" }, 409],
  ])("leaves %s to the database, unchanged", async (_label, owner, payload, overrides, status) => {
    signInAs(ALICE);
    const row = seedProposal(owner, payload, overrides);
    const response = await decide(row.id as string, { decision: "approve" });
    expect(response.status).toBe(status);
    expect(db.rpcCalls[0]?.args.p_payload).toBeNull();
    expect(rowsOf("tasks")).toHaveLength(0);
    expect(rowsOf("reminders")).toHaveLength(0);
  });

  it("answers 500 and runs nothing when the stored payload cannot be read", async () => {
    signInAs(ALICE);
    const row = seedProposal(ALICE, reminderPayload());
    db.failReadFrom = "action_proposals";
    const response = await decide(row.id as string, { decision: "approve" });
    expect(response.status).toBe(500);
    expect(db.rpcCalls).toHaveLength(0);
    expect(storedProposal(row.id as string)?.status).toBe("proposed");
    expect(rowsOf("reminders")).toHaveLength(0);
  });

  it("saves a memory as active from the assistant, then adds its vector", async () => {
    signInAs(ALICE);
    const row = seedProposal(ALICE, memoryPayload());
    const response = await decide(row.id as string, { decision: "approve" });
    expect(response.status).toBe(200);
    const memory = rowsOf("memories", ALICE)[0] as Row;

    expect(rowsOf("memories")).toHaveLength(1);
    expect(memory).toMatchObject({
      mode: "personal",
      content: "Prefers short replies",
      status: "active",
      source: "assistant",
      embedding: "[0.1,0.2,0.3]",
      embedding_model: EMBEDDING_MODEL,
    });
    expect(embed.mock.calls[0]?.[0]).toEqual(["Prefers short replies"]);
    expect((await response.json()).result).toEqual({ memoryId: memory.id });
  });

  it("keeps the memory without a vector when the provider fails, and still counts it as executed", async () => {
    signInAs(ALICE);
    embed.mockRejectedValueOnce(new ProviderError("nebius", "unavailable"));
    const row = seedProposal(ALICE, memoryPayload());
    const response = await decide(row.id as string, { decision: "approve" });
    expect(response.status).toBe(200);
    expect(rowsOf("memories")).toHaveLength(1);
    expect(rowsOf("memories")[0]).toMatchObject({ embedding: null, embedding_model: null });
    expect(storedProposal(row.id as string)?.status).toBe("executed");
  });

  it("still answers 200 when the embedding settings are missing, because the memory is already saved", async () => {
    signInAs(ALICE);
    vi.mocked(getAssistantConfig).mockImplementationOnce(() => {
      throw new Error("missing settings");
    });
    const row = seedProposal(ALICE, memoryPayload(SECRET_MEMORY));
    const response = await decide(row.id as string, { decision: "approve" });
    expect(response.status).toBe(200);
    expect(rowsOf("memories")).toHaveLength(1);
    const warning = consoleLines.find((l) => l.includes('"event":"action_embedding_failed"'));
    expect(warning).toContain(row.id as string);
    expect(consoleLines.join("\n")).not.toContain(SECRET_MEMORY);
  });

  it("answers before the vector is written, and hands the work to waitUntil", async () => {
    signInAs(ALICE);
    let release: () => void = () => {};
    embed.mockImplementationOnce(
      (texts: string[]) => new Promise((resolve) => (release = () => resolve(texts.map(() => VECTOR)))),
    );
    const row = seedProposal(ALICE, memoryPayload());
    const response = await decisionRoute.POST(
      jsonRequest(`http://localhost/api/actions/${row.id}/decision`, "POST", { decision: "approve" }),
      params(row.id as string),
    );
    expect(response.status).toBe(200);
    expect(pendingWork).toHaveLength(1);
    expect(rowsOf("memories")[0]).toMatchObject({ embedding: null });

    release();
    await Promise.all(pendingWork.splice(0));
    expect(rowsOf("memories")[0]).toMatchObject({ embedding: "[0.1,0.2,0.3]", embedding_model: EMBEDDING_MODEL });
  });

  it("does not let a late vector replace the vector of text the user changed meanwhile", async () => {
    signInAs(ALICE);
    let release: () => void = () => {};
    embed.mockImplementationOnce(
      (texts: string[]) => new Promise((resolve) => (release = () => resolve(texts.map(() => VECTOR)))),
    );
    const row = seedProposal(ALICE, memoryPayload("Prefers tea"));
    const response = await decisionRoute.POST(
      jsonRequest(`http://localhost/api/actions/${row.id}/decision`, "POST", { decision: "approve" }),
      params(row.id as string),
    );
    expect(response.status).toBe(200);

    // The user edits the memory before the first vector arrives. The edit stores its own vector.
    const memory = rowsOf("memories", ALICE)[0] as Row;
    Object.assign(memory, { content: "Prefers coffee", embedding: "[0.9]", embedding_model: EMBEDDING_MODEL });

    release();
    await Promise.all(pendingWork.splice(0));
    expect(rowsOf("memories", ALICE)[0]).toMatchObject({ content: "Prefers coffee", embedding: "[0.9]" });
    expect(consoleLines.some((l) => l.includes('"event":"action_embedding_skipped"'))).toBe(true);
    expect(consoleLines.join("\n")).not.toContain("Prefers");
  });

  it("does not read the embedding settings for a task", async () => {
    signInAs(ALICE);
    const row = seedProposal(ALICE, taskPayload());
    await decide(row.id as string, { decision: "approve" });
    expect(getAssistantConfig).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
  });

  it("sends the edited values and stores them as the proposal payload", async () => {
    signInAs(ALICE);
    const row = seedProposal(ALICE, taskPayload("Pay the invoice"));
    const response = await decide(row.id as string, {
      decision: "approve",
      payload: taskPayload("  Pay the invoice today  "),
    });
    expect(response.status).toBe(200);
    expect(db.rpcCalls[0]?.args.p_payload).toEqual(taskPayload("Pay the invoice today"));
    expect(rowsOf("tasks", ALICE)[0]).toMatchObject({ title: "Pay the invoice today" });
    expect((await response.json()).payload).toEqual(taskPayload("Pay the invoice today"));
  });

  it.each([
    ["a Work mode", { mode: "work" }],
    ["an unknown mode", { mode: "hobby" }],
    ["no mode", { mode: undefined }],
  ])("gives an edit with %s WORKSPACE_MODE before validation (decision 0014)", async (_label, override) => {
    signInAs(ALICE);
    const row = seedProposal(ALICE, taskPayload("Pay the invoice"));
    const response = await decide(row.id as string, {
      decision: "approve",
      payload: { ...taskPayload("Pay the invoice today"), ...override },
    });
    expect(response.status).toBe(200);
    expect(db.rpcCalls[0]?.args.p_payload).toEqual(taskPayload("Pay the invoice today"));
    expect(rowsOf("tasks", ALICE)[0]).toMatchObject({ mode: "personal", title: "Pay the invoice today" });
  });

  it("gives an edited reminder from a Work proposal WORKSPACE_MODE", async () => {
    signInAs(ALICE);
    const row = seedProposal(ALICE, reminderPayload());
    const response = await decide(row.id as string, { decision: "approve", payload: reminderPayload() });
    expect(response.status).toBe(200);
    expect(rowsOf("reminders", ALICE)[0]).toMatchObject({ mode: "personal", title: "Call the supplier" });
  });

  it("runs an action once, and a second approval gets 409 without running it again", async () => {
    signInAs(ALICE);
    const row = seedProposal(ALICE, taskPayload());
    expect((await decide(row.id as string, { decision: "approve" })).status).toBe(200);

    const second = await decide(row.id as string, { decision: "approve" });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: { code: "conflict", message: "This action was already decided." } });
    expect(rowsOf("tasks")).toHaveLength(1);
  });

  it("runs nothing when another decision claims the proposal first", async () => {
    signInAs(ALICE);
    const row = seedProposal(ALICE, taskPayload());
    db.beforeNextUpdate = () => {
      row.status = "rejected";
    };
    const response = await decide(row.id as string, { decision: "approve" });
    expect(response.status).toBe(409);
    expect(storedProposal(row.id as string)?.status).toBe("rejected");
    expect(rowsOf("tasks")).toHaveLength(0);
  });
});

describe("POST /api/actions/:id/decision: reject", () => {
  it("marks the proposal rejected and runs nothing", async () => {
    signInAs(ALICE);
    const row = seedProposal(ALICE, taskPayload());
    const response = await decide(row.id as string, { decision: "reject" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: row.id, status: "rejected", result: null, decidedAt: expect.any(String) });

    expect(rowsOf("tasks")).toHaveLength(0);
    expect(rowsOf("reminders")).toHaveLength(0);
    expect(rowsOf("memories")).toHaveLength(0);
  });

  it("answers 409 for a second decision after a reject, and does not approve it", async () => {
    signInAs(ALICE);
    const row = seedProposal(ALICE, taskPayload());
    await decide(row.id as string, { decision: "reject" });
    const second = await decide(row.id as string, { decision: "approve" });
    expect(second.status).toBe(409);
    expect(storedProposal(row.id as string)?.status).toBe("rejected");
    expect(rowsOf("tasks")).toHaveLength(0);
  });
});

describe("POST /api/actions/:id/decision: an older row with a payload that cannot be shown", () => {
  it("answers 200 with the ID and status after a reject, not 500", async () => {
    signInAs(ALICE);
    const row = seedProposal(ALICE, { kind: "save_memory", mode: "personal", content: "x" }, { kind: "create_task" });
    const response = await decide(row.id as string, { decision: "reject" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: row.id, status: "rejected" });
    expect(storedProposal(row.id as string)?.status).toBe("rejected");
  });

  it("never runs it: an approval answers 404 and changes nothing", async () => {
    signInAs(ALICE);
    const row = seedProposal(ALICE, { kind: "save_memory", mode: "personal", content: "x" }, { kind: "create_task" });
    expect((await decide(row.id as string, { decision: "approve" })).status).toBe(404);
    expect(storedProposal(row.id as string)?.status).toBe("proposed");
    expect(rowsOf("tasks")).toHaveLength(0);
  });
});

describe("POST /api/actions/:id/decision: failures", () => {
  it("answers 502 when the database records the action as failed", async () => {
    signInAs(ALICE);
    db.failInsertInto = "tasks";
    const row = seedProposal(ALICE, taskPayload(SECRET_TITLE));
    const response = await decide(row.id as string, { decision: "approve" });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: { code: "internal_error", message: "The action could not be completed." },
    });

    expect(storedProposal(row.id as string)).toMatchObject({
      status: "failed",
      result: { error: "execution_failed", code: "23514" },
    });
    const line = consoleLines.find((l) => l.includes('"event":"action_execution_failed"'));
    expect(line).toContain('"kind":"create_task"');
    expect(line).toContain('"code":"23514"');
    expect(consoleLines.join("\n")).not.toContain(SECRET_TITLE);
    expect((await decide(row.id as string, { decision: "approve" })).status).toBe(409);
  });

  it("answers 500 and changes nothing when the database call fails", async () => {
    signInAs(ALICE);
    db.failRpc = { message: "connection lost" };
    const row = seedProposal(ALICE, taskPayload());
    const response = await decide(row.id as string, { decision: "approve" });
    expect(response.status).toBe(500);
    expect(storedProposal(row.id as string)?.status).toBe("proposed");
    expect(rowsOf("tasks")).toHaveLength(0);
  });
});

describe("POST /api/actions/:id/decision when one write fails", () => {
  const kinds = [
    ["create_task", taskPayload, "tasks"],
    ["create_reminder", reminderPayload, "reminders"],
    ["save_memory", () => memoryPayload(), "memories"],
  ] as const;

  let spend: FakeSpend;

  /** Fresh fakes with the real budgeted embedder for a saved memory. Every database and spend write is counted. */
  function arm(faults: WriteFaults) {
    db = new FakeDb();
    spend = new FakeSpend();
    signInAs(ALICE);
    faults.wrap(db, ["rpc", "write"], {
      label: "db",
      detail: (_method, args) => String(args[0]),
      failWith: (error) => ({ data: null, error: { message: error.message } }),
    });
    faults.wrap(spend, ["reserve", "settle"]);
    vi.mocked(createEmbedderForRequest).mockReturnValue(testEmbedder(spend));
  }

  /** Approve once, then approve again after an error, as the user would. `decide` waits for the work after the response. */
  async function approveScenario(payload: Row, table: string, faults: WriteFaults, sweepCase: SweepCase) {
    const at = describeCase(sweepCase);
    arm(faults);
    const id = seedProposal(ALICE, payload).id as string;

    const first = await decide(id, { decision: "approve" });
    faults.disarm();
    const afterFirst = storedProposal(id)!.status;
    expect(afterFirst, `${at}: no in-between status`).not.toBe("approved");
    expect(rowsOf(table), `${at}: the stored outcome matches the effect`).toHaveLength(afterFirst === "executed" ? 1 : 0);
    const spendFaults = faults.fired.filter((f) => f.label.startsWith("FakeSpend")).length;
    expect(spend.reservations.filter((r) => r.settled === null).length, `${at}: open holds`).toBeLessThanOrEqual(spendFaults);
    if (first.status === 200) {
      expect(afterFirst, at).toBe("executed");
      return;
    }
    expect([500, 502], at).toContain(first.status);

    const retry = await decide(id, { decision: "approve" });
    expect(retry.status, `${at}: retry`).toBe(afterFirst === "proposed" ? 200 : 409);
    expect(storedProposal(id)!.status, at).toBe(afterFirst === "proposed" ? "executed" : afterFirst);
    expect(rowsOf(table), `${at}: no duplicate on retry`).toHaveLength(afterFirst === "failed" ? 0 : 1);
  }

  it.each(kinds)("%s: never leaves a proposal approved or a false outcome, for every write, up to two faults", async (kind, payload, table) => {
    const cases = await sweepWriteFaults((faults, sweepCase) => approveScenario(payload(), table, faults, sweepCase));
    const labels = new Set(cases.map((c) => c.at(-1)!.label));
    expect(labels).toContain("db.rpc:decide_action_proposal");
    if (kind === "save_memory") {
      for (const label of ["FakeSpend.reserve", "FakeSpend.settle", "db.write:memories"]) expect(labels).toContain(label);
    }
  });

  it("PR #12 case: the result write is lost after the task was created, and a retry runs nothing", async () => {
    const faults = new WriteFaults().fail("lost", 1);
    await approveScenario(taskPayload(), "tasks", faults, [{ step: 1, fault: "lost", label: "db.rpc:decide_action_proposal" }]);
    expect(faults.fired.map((f) => f.label)).toEqual(["db.rpc:decide_action_proposal"]);
  });

  it("a saved memory keeps its executed result when the vector write fails after the response", async () => {
    const faults = new WriteFaults().fail("refused", 4);
    arm(faults);
    const id = seedProposal(ALICE, memoryPayload()).id as string;

    expect((await decide(id, { decision: "approve" })).status).toBe(200);
    expect(faults.calls).toEqual(["db.rpc:decide_action_proposal", "FakeSpend.reserve", "FakeSpend.settle", "db.write:memories"]);
    expect(faults.fired.map((f) => f.label)).toEqual(["db.write:memories"]);
    expect(storedProposal(id)!.status).toBe("executed");
    expect(rowsOf("memories")).toEqual([expect.objectContaining({ status: "active", embedding: null })]);
    expect(consoleLines.some((l) => l.includes('"event":"action_embedding_failed"'))).toBe(true);
  });
});

describe("privacy", () => {
  it("never writes task, reminder or memory text to the logger", async () => {
    signInAs(ALICE);
    const task = seedProposal(ALICE, taskPayload(SECRET_TITLE));
    const memory = seedProposal(ALICE, memoryPayload(SECRET_MEMORY));
    embed.mockRejectedValueOnce(new ProviderError("nebius", "unavailable"));
    await decide(task.id as string, { decision: "approve" });
    await decide(memory.id as string, { decision: "approve" });

    expect(consoleLines.join("\n")).not.toContain(SECRET_TITLE);
    expect(consoleLines.join("\n")).not.toContain(SECRET_MEMORY);
  });

  it("writes no action-log rows: the database writes them from triggers", async () => {
    signInAs(ALICE);
    const row = seedProposal(ALICE, taskPayload());
    await decide(row.id as string, { decision: "approve" });
    expect(logEvents()).toHaveLength(0);
  });
});

describe("the proposal repository", () => {
  const repo = () => createActionProposalRepository(db as unknown as SupabaseClient);

  it("stores a valid proposal as proposed", async () => {
    const dto = await repo().createProposal(ALICE, {
      conversationId: null,
      payload: taskPayload(),
      summary: "  Add task: Pay the invoice  ",
    });
    expect(dto).toMatchObject({ status: "proposed", summary: "Add task: Pay the invoice", payload: taskPayload() });
    expect(storedProposal(dto.id)).toMatchObject({ user_id: ALICE, status: "proposed", kind: "create_task" });
  });

  it("throws and stores nothing for an invalid payload or summary", async () => {
    await expect(
      repo().createProposal(ALICE, { conversationId: null, payload: taskPayload("  "), summary: "Add a task" }),
    ).rejects.toThrow();
    await expect(
      repo().createProposal(ALICE, { conversationId: null, payload: taskPayload(), summary: "   " }),
    ).rejects.toThrow();
    expect(db.tables.action_proposals).toHaveLength(0);
  });

  it("returns the stored outcome when another decision came first", async () => {
    db.uid = ALICE;
    const row = seedProposal(ALICE, taskPayload(), {
      status: "executed",
      result: { taskId: MISSING_ID },
      decided_at: "2026-10-19T10:00:00.000Z",
    });
    const answer = await repo().decide(row.id as string, "approve");
    expect(answer.outcome).toBe("already_decided");
    expect(answer.proposal).toMatchObject({ id: row.id, status: "executed", result: { taskId: MISSING_ID } });
  });

  it("gives the same answer for another user's proposal and a missing one", async () => {
    db.uid = ALICE;
    const bobs = seedProposal(BOB, taskPayload());
    expect(await repo().decide(bobs.id as string, "approve")).toEqual({ outcome: "not_found", proposal: null, row: null });
    expect(await repo().decide(MISSING_ID, "approve")).toEqual({ outcome: "not_found", proposal: null, row: null });
  });

  it.each([
    ["an error", { data: null, error: { message: "boom" } }],
    ["an unknown outcome", { data: { outcome: "maybe", proposal: null }, error: null }],
    ["no data", { data: null, error: null }],
    ["an executed row that does not parse", { data: { outcome: "executed", proposal: { id: "x" } }, error: null }],
  ])("throws RepositoryError for %s", async (_label, reply) => {
    const client = { rpc: async () => reply } as unknown as SupabaseClient;
    await expect(createActionProposalRepository(client).decide(MISSING_ID, "approve")).rejects.toThrow(
      new RepositoryError("decideActionProposal"),
    );
  });
});
