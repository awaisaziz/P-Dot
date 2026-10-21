import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthContext } from "@/server/auth/session";
import { ConfigError } from "@/lib/supabase-config";
import type { Embedder } from "@/server/assistant/embed";
import { EmbeddingBudgetError } from "@/server/assistant/embed";
import { ProviderError } from "@/server/providers/errors";
import { EMBEDDING_MODEL } from "@/server/providers/nebius/embeddings";
import { FakeSpend, TEST_SPEND_CAPS, testEmbedder, testRouting } from "../support/fakes";
import { WriteFaults, describeCase, hasFault, sweepWriteFaults, type SweepCase } from "../support/write-faults";

vi.mock("@/server/auth/session", () => ({ getAuthContext: vi.fn() }));
vi.mock("@/server/config", () => ({ getAssistantConfig: vi.fn(), getSiteUrl: () => "http://localhost:3000" }));
vi.mock("@/server/assistant/deps", () => ({ createEmbedderForRequest: vi.fn() }));

const { getAuthContext } = await import("@/server/auth/session");
const { getAssistantConfig } = await import("@/server/config");
const { createEmbedderForRequest } = await import("@/server/assistant/deps");
const listRoute = await import("@/app/api/memories/route");
const itemRoute = await import("@/app/api/memories/[id]/route");

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VECTOR = [0.1, 0.2, 0.3];
const OLD_VECTOR = "[9,9,9]";

// ---------------------------------------------------------------------------
// A small in-memory stand-in for the Supabase query builder. It runs the real
// repositories: it applies `eq` filters, `order`, `limit`, returns only the
// selected columns (like PostgREST), and records every query so tests can check
// which columns and filters the code used.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

interface QueryRecord {
  table: string;
  op: "select" | "insert" | "update" | "delete";
  filters: string[];
  columns: string | null;
  scopedToUser: boolean;
}

class FakeDb {
  tables: Record<string, Row[]> = { memories: [], action_log: [] };
  queries: QueryRecord[] = [];
  /** Runs once, just before the next update (to simulate another request that writes first). */
  beforeNextUpdate: (() => void) | null = null;
  private seq = 0;

  nextTimestamp(): string {
    this.seq += 1;
    return new Date(Date.UTC(2026, 9, 19) + this.seq * 1000).toISOString();
  }

  from(table: string): FakeQuery {
    return new FakeQuery(this, table);
  }

  /** Every insert, update and delete goes through here, so a test can make one fail. */
  async write(_table: string, run: () => FakeResult): Promise<FakeResult> {
    return run();
  }
}

interface FakeResult {
  data: unknown;
  error: { message: string } | null;
  count?: number;
}

class FakeQuery implements PromiseLike<FakeResult> {
  private filters: { column: string; value: unknown }[] = [];
  private op: QueryRecord["op"] = "select";
  private payload: Row = {};
  private columns: string | null = null;
  private ordering: { column: string; ascending: boolean } | null = null;
  private max = Number.POSITIVE_INFINITY;
  private shape: "many" | "single" | "maybe" = "many";
  private wantCount = false;

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
  delete(options?: { count?: string }): this {
    this.op = "delete";
    this.wantCount = options?.count === "exact";
    return this;
  }
  eq(column: string, value: unknown): this {
    this.filters.push({ column, value });
    return this;
  }
  /** Ordering by an ISO timestamp, the only kind the repositories use. */
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
    if (this.op === "update" && this.db.beforeNextUpdate) {
      const hook = this.db.beforeNextUpdate;
      this.db.beforeNextUpdate = null;
      hook();
    }
    const rows = this.db.tables[this.table] ?? [];
    const matches = rows.filter((row) => this.filters.every((f) => row[f.column] === f.value));
    const scopedToUser =
      this.filters.some((f) => f.column === "user_id") || (this.op === "insert" && this.payload.user_id !== undefined);
    this.db.queries.push({
      table: this.table,
      op: this.op,
      filters: this.filters.map((f) => f.column),
      columns: this.columns,
      scopedToUser,
    });

    if (this.op === "insert") {
      const row: Row = {
        id: randomUUID(),
        source_message_id: null,
        embedding: null,
        embedding_model: null,
        created_at: this.db.nextTimestamp(),
        updated_at: this.db.nextTimestamp(),
        ...this.payload,
      };
      rows.push(row);
      return { data: this.columns ? this.shapeOne([this.project(row)]) : null, error: null };
    }

    if (this.op === "update") {
      for (const row of matches) Object.assign(row, this.payload, { updated_at: this.db.nextTimestamp() });
      return { data: this.columns ? this.shapeOne(matches.map((r) => this.project(r))) : null, error: null };
    }

    if (this.op === "delete") {
      for (const row of matches) rows.splice(rows.indexOf(row), 1);
      return { data: null, error: null, count: this.wantCount ? matches.length : undefined };
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
// Test setup.
// ---------------------------------------------------------------------------

let db: FakeDb;
let embed: ReturnType<typeof vi.fn<(texts: string[], signal?: AbortSignal) => Promise<number[][]>>>;
let consoleLines: string[];

function signInAs(userId: string | null) {
  vi.mocked(getAuthContext).mockResolvedValue(
    userId ? ({ userId, email: `${userId}@example.com`, supabase: db as unknown as SupabaseClient } satisfies AuthContext) : null,
  );
}

function jsonRequest(method: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/memories", {
    method,
    headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function plainRequest(method: string, url = "http://localhost/api/memories", headers: Record<string, string> = {}) {
  return new Request(url, { method, headers: { host: "localhost", origin: "http://localhost", ...headers } });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

function seedMemory(userId: string, overrides: Partial<Row> = {}): Row {
  const row: Row = {
    id: randomUUID(),
    user_id: userId,
    mode: "personal",
    content: "Likes tea",
    status: "active",
    source: "user",
    source_message_id: null,
    embedding: OLD_VECTOR,
    embedding_model: EMBEDDING_MODEL,
    created_at: db.nextTimestamp(),
    updated_at: db.nextTimestamp(),
    ...overrides,
  };
  db.tables.memories!.push(row);
  return row;
}

function storedRow(id: string): Row | undefined {
  return db.tables.memories!.find((r) => r.id === id);
}

function actionLog(): Row[] {
  return db.tables.action_log ?? [];
}

beforeEach(() => {
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
  it("requires a session on every route", async () => {
    signInAs(null);
    const row = seedMemory(ALICE);
    expect((await listRoute.GET(plainRequest("GET", "http://localhost/api/memories?mode=personal"))).status).toBe(401);
    expect((await listRoute.POST(jsonRequest("POST", { mode: "personal", content: "x" }))).status).toBe(401);
    expect((await itemRoute.PATCH(jsonRequest("PATCH", { status: "active" }), params(row.id as string))).status).toBe(401);
    expect((await itemRoute.DELETE(plainRequest("DELETE"), params(row.id as string))).status).toBe(401);
    expect(storedRow(row.id as string)).toBeDefined();
  });

  it("rejects cross-origin writes and changes nothing", async () => {
    const row = seedMemory(ALICE);
    signInAs(ALICE);
    const evil = { origin: "https://evil.example" };
    expect((await listRoute.POST(jsonRequest("POST", { mode: "personal", content: "x" }, evil))).status).toBe(403);
    expect((await itemRoute.PATCH(jsonRequest("PATCH", { content: "x" }, evil), params(row.id as string))).status).toBe(403);
    expect((await itemRoute.DELETE(plainRequest("DELETE", undefined, evil), params(row.id as string))).status).toBe(403);
    expect(db.tables.memories).toHaveLength(1);
    expect(storedRow(row.id as string)?.content).toBe("Likes tea");
    expect(embed).not.toHaveBeenCalled();
  });
});

describe("GET /api/memories", () => {
  it("lists one mode, newest first, and filters by status", async () => {
    signInAs(ALICE);
    const older = seedMemory(ALICE, { content: "older", status: "active" });
    const newer = seedMemory(ALICE, { content: "newer", status: "proposed" });
    seedMemory(ALICE, { content: "work one", mode: "work" });
    seedMemory(BOB, { content: "bob's", mode: "personal" });

    const all = await (await listRoute.GET(plainRequest("GET", "http://localhost/api/memories?mode=personal"))).json();
    expect(all.memories.map((m: { content: string }) => m.content)).toEqual(["newer", "older"]);
    expect(all.memories[0]).toMatchObject({ id: newer.id, status: "proposed", source: "user", sourceMessageId: null });

    const proposed = await (
      await listRoute.GET(plainRequest("GET", "http://localhost/api/memories?mode=personal&status=proposed"))
    ).json();
    expect(proposed.memories.map((m: { id: string }) => m.id)).toEqual([newer.id]);

    const active = await (
      await listRoute.GET(plainRequest("GET", "http://localhost/api/memories?mode=personal&status=active"))
    ).json();
    expect(active.memories.map((m: { id: string }) => m.id)).toEqual([older.id]);
  });

  it.each([
    ["no mode", "http://localhost/api/memories"],
    ["an unknown mode", "http://localhost/api/memories?mode=hobby"],
    ["an unknown status", "http://localhost/api/memories?mode=work&status=archived"],
    ["an empty status", "http://localhost/api/memories?mode=work&status="],
  ])("answers 400 for %s", async (_label, url) => {
    signInAs(ALICE);
    expect((await listRoute.GET(plainRequest("GET", url))).status).toBe(400);
  });
});

describe("POST /api/memories", () => {
  it("saves a trimmed memory with an embedding and logs memory_added", async () => {
    signInAs(ALICE);
    const response = await listRoute.POST(
      jsonRequest("POST", { mode: "work", content: "  Prefers short replies  " }),
    );
    expect(response.status).toBe(201);
    const memory = await response.json();
    expect(memory).toMatchObject({ mode: "work", content: "Prefers short replies", status: "active", source: "user", sourceMessageId: null });

    expect(embed).toHaveBeenCalledWith(["Prefers short replies"]);
    expect(storedRow(memory.id)).toMatchObject({ embedding: "[0.1,0.2,0.3]", embedding_model: EMBEDDING_MODEL, user_id: ALICE });

    // The database writes memory_added from a trigger. The app writes no log row.
    expect(actionLog()).toHaveLength(0);
  });

  it("still saves with no embedding when the spend guard refuses", async () => {
    signInAs(ALICE);
    embed.mockRejectedValueOnce(new EmbeddingBudgetError("day"));
    const response = await listRoute.POST(jsonRequest("POST", { mode: "personal", content: "Lives in Leeds" }));
    expect(response.status).toBe(201);
    const memory = await response.json();
    expect(storedRow(memory.id)).toMatchObject({ embedding: null, embedding_model: null, content: "Lives in Leeds" });
    expect(consoleLines.some((l) => l.includes('"event":"memory_embedding_failed"') && l.includes('"errorName":"EmbeddingBudgetError"'))).toBe(true);
  });

  it("still saves with no embedding when the provider fails", async () => {
    signInAs(ALICE);
    embed.mockRejectedValueOnce(new ProviderError("nebius", "unavailable"));
    const response = await listRoute.POST(jsonRequest("POST", { mode: "personal", content: "Lives in Leeds" }));
    expect(response.status).toBe(201);
    const memory = await response.json();
    expect(storedRow(memory.id)).toMatchObject({ embedding: null, embedding_model: null });
    expect(consoleLines.some((l) => l.includes('"event":"memory_embedding_failed"') && l.includes('"errorName":"ProviderError"'))).toBe(true);
  });

  it("answers 503 when the embedding settings are missing", async () => {
    signInAs(ALICE);
    vi.mocked(getAssistantConfig).mockImplementationOnce(() => {
      throw new ConfigError(["NEBIUS_API_KEY"]);
    });
    const response = await listRoute.POST(jsonRequest("POST", { mode: "personal", content: "x" }));
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("not_configured");
    expect(db.tables.memories).toHaveLength(0);
  });

  it.each([
    ["blank content", { mode: "personal", content: "   " }],
    ["content over 1,000 characters", { mode: "personal", content: "x".repeat(1001) }],
    ["an unknown mode", { mode: "family", content: "x" }],
    ["a missing mode", { content: "x" }],
    ["a client-supplied user", { mode: "personal", content: "x", userId: BOB }],
    ["a client-supplied source message", { mode: "personal", content: "x", sourceMessageId: randomUUID() }],
    ["a client-supplied status", { mode: "personal", content: "x", status: "proposed" }],
  ])("answers 400 for %s", async (_label, body) => {
    signInAs(ALICE);
    expect((await listRoute.POST(jsonRequest("POST", body))).status).toBe(400);
    expect(db.tables.memories).toHaveLength(0);
    expect(embed).not.toHaveBeenCalled();
  });

  it("answers 415 for a body that is not JSON", async () => {
    signInAs(ALICE);
    const request = new Request("http://localhost/api/memories", {
      method: "POST",
      headers: { host: "localhost", origin: "http://localhost", "content-type": "text/plain" },
      body: "mode=personal",
    });
    expect((await listRoute.POST(request)).status).toBe(415);
  });
});

describe("PATCH /api/memories/:id", () => {
  it("re-embeds when the text changes", async () => {
    signInAs(ALICE);
    const row = seedMemory(ALICE);
    const response = await itemRoute.PATCH(jsonRequest("PATCH", { content: "Likes green tea" }), params(row.id as string));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: row.id, content: "Likes green tea" });
    expect(embed).toHaveBeenCalledWith(["Likes green tea"]);
    expect(storedRow(row.id as string)).toMatchObject({ embedding: "[0.1,0.2,0.3]", embedding_model: EMBEDDING_MODEL });
  });

  it("clears the old vector when the new text cannot be embedded", async () => {
    signInAs(ALICE);
    const row = seedMemory(ALICE);
    embed.mockRejectedValueOnce(new EmbeddingBudgetError("period"));
    const response = await itemRoute.PATCH(jsonRequest("PATCH", { content: "Likes green tea" }), params(row.id as string));
    expect(response.status).toBe(200);
    // The old vector described the old text, so it must not stay.
    expect(storedRow(row.id as string)).toMatchObject({ content: "Likes green tea", embedding: null, embedding_model: null });
  });

  it("does not embed when only the mode or the status changes", async () => {
    signInAs(ALICE);
    const row = seedMemory(ALICE, { status: "proposed" });
    const approve = await itemRoute.PATCH(jsonRequest("PATCH", { status: "active" }), params(row.id as string));
    expect(await approve.json()).toMatchObject({ status: "active" });
    const move = await itemRoute.PATCH(jsonRequest("PATCH", { mode: "work" }), params(row.id as string));
    expect(await move.json()).toMatchObject({ mode: "work" });

    expect(embed).not.toHaveBeenCalled();
    expect(storedRow(row.id as string)).toMatchObject({ embedding: OLD_VECTOR, status: "active", mode: "work" });
  });

  it("never puts old text next to a newer text's vector when the text is unchanged", async () => {
    signInAs(ALICE);
    const row = seedMemory(ALICE, { content: "Likes tea" });
    // Another edit saves new text with its vector after this request read the row.
    db.beforeNextUpdate = () => Object.assign(row, { content: "Likes coffee", embedding: "[0.9]" });
    const response = await itemRoute.PATCH(jsonRequest("PATCH", { content: "Likes tea", mode: "work" }), params(row.id as string));
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("conflict");
    expect(storedRow(row.id as string)).toMatchObject({ content: "Likes coffee", embedding: "[0.9]", mode: "personal" });
    expect(embed).not.toHaveBeenCalled();
  });

  it("does not write the text when it is unchanged, and answers with the stored row", async () => {
    signInAs(ALICE);
    const row = seedMemory(ALICE, { content: "Likes tea" });
    const before = db.queries.length;
    const response = await itemRoute.PATCH(jsonRequest("PATCH", { content: "Likes tea" }), params(row.id as string));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ content: "Likes tea" });
    expect(db.queries.slice(before).some((q) => q.op === "update")).toBe(false);
    expect(storedRow(row.id as string)).toMatchObject({ embedding: OLD_VECTOR });
  });

  it("answers 409 when the text changed between the read and a new-text update", async () => {
    signInAs(ALICE);
    const row = seedMemory(ALICE, { content: "Likes tea" });
    db.beforeNextUpdate = () => Object.assign(row, { content: "Likes coffee", embedding: "[0.9]" });
    const response = await itemRoute.PATCH(jsonRequest("PATCH", { content: "Likes green tea" }), params(row.id as string));
    expect(response.status).toBe(409);
    expect(storedRow(row.id as string)).toMatchObject({ content: "Likes coffee", embedding: "[0.9]" });
  });

  it("answers 404 for another user's memory and changes nothing", async () => {
    const row = seedMemory(ALICE);
    signInAs(BOB);
    const response = await itemRoute.PATCH(jsonRequest("PATCH", { content: "pwned" }), params(row.id as string));
    expect(response.status).toBe(404);
    expect((await response.json()).error.message).toBe("Memory not found.");
    expect(storedRow(row.id as string)).toMatchObject({ content: "Likes tea", user_id: ALICE });
    expect(actionLog()).toHaveLength(0);
  });

  it("answers 404 for a bad ID", async () => {
    signInAs(ALICE);
    expect((await itemRoute.PATCH(jsonRequest("PATCH", { status: "active" }), params("not-an-id"))).status).toBe(404);
  });

  it("answers 404 for a missing or foreign ID before any embedder work", async () => {
    const row = seedMemory(ALICE);
    signInAs(BOB);
    const foreign = await itemRoute.PATCH(jsonRequest("PATCH", { content: "Likes coffee" }), params(row.id as string));
    expect(foreign.status).toBe(404);
    const missing = await itemRoute.PATCH(jsonRequest("PATCH", { content: "Likes coffee" }), params(randomUUID()));
    expect(missing.status).toBe(404);

    expect(createEmbedderForRequest).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    expect(storedRow(row.id as string)).toMatchObject({ content: "Likes tea", embedding: OLD_VECTOR });
  });

  it("answers 404 for a missing ID even when the embedding settings are missing", async () => {
    signInAs(ALICE);
    vi.mocked(getAssistantConfig).mockImplementation(() => {
      throw new ConfigError(["NEBIUS_API_KEY"]);
    });
    const response = await itemRoute.PATCH(jsonRequest("PATCH", { content: "Likes coffee" }), params(randomUUID()));
    expect(response.status).toBe(404);
  });

  it.each([
    ["the same text", "Likes tea"],
    ["the same text with spaces", "  Likes tea  "],
  ])("keeps the stored vector and does not embed for %s", async (_label, content) => {
    signInAs(ALICE);
    const row = seedMemory(ALICE);
    const response = await itemRoute.PATCH(jsonRequest("PATCH", { content }), params(row.id as string));
    expect(response.status).toBe(200);
    expect(embed).not.toHaveBeenCalled();
    expect(storedRow(row.id as string)).toMatchObject({ content: "Likes tea", embedding: OLD_VECTOR, embedding_model: EMBEDDING_MODEL });
  });

  it.each([
    ["the provider fails", () => new ProviderError("nebius", "unavailable")],
    ["the spend guard refuses", () => new EmbeddingBudgetError("day")],
  ])("keeps the stored vector for the same text when %s", async (_label, makeError) => {
    signInAs(ALICE);
    const row = seedMemory(ALICE);
    embed.mockRejectedValue(makeError());
    const response = await itemRoute.PATCH(
      jsonRequest("PATCH", { content: "  Likes tea  ", status: "active" }),
      params(row.id as string),
    );
    expect(response.status).toBe(200);
    expect(embed).not.toHaveBeenCalled();
    expect(storedRow(row.id as string)).toMatchObject({ content: "Likes tea", embedding: OLD_VECTOR, embedding_model: EMBEDDING_MODEL });
  });

  it.each([
    ["an empty update", {}],
    ["a status other than active", { status: "proposed" }],
    ["an unknown field", { content: "x", userId: BOB }],
    ["blank content", { content: "  " }],
  ])("answers 400 for %s", async (_label, body) => {
    const row = seedMemory(ALICE);
    signInAs(ALICE);
    expect((await itemRoute.PATCH(jsonRequest("PATCH", body), params(row.id as string))).status).toBe(400);
    expect(storedRow(row.id as string)?.content).toBe("Likes tea");
  });
});

describe("DELETE /api/memories/:id", () => {
  it("deletes the user's memory with 204", async () => {
    signInAs(ALICE);
    const row = seedMemory(ALICE, { mode: "work", source: "assistant", status: "proposed" });
    const response = await itemRoute.DELETE(plainRequest("DELETE"), params(row.id as string));
    expect(response.status).toBe(204);
    expect(storedRow(row.id as string)).toBeUndefined();
    expect(actionLog()).toHaveLength(0);
  });

  it("answers 404 for another user's memory and deletes nothing", async () => {
    const row = seedMemory(ALICE);
    signInAs(BOB);
    expect((await itemRoute.DELETE(plainRequest("DELETE"), params(row.id as string))).status).toBe(404);
    expect(storedRow(row.id as string)).toBeDefined();
    expect(actionLog()).toHaveLength(0);
  });
});

describe("memory writes when one write fails", () => {
  const NEW_TEXT = "Prefers tea in the morning";

  /** The real budgeted embedder, with a provider that always answers and a spend guard the test can break. */
  function arm(faults: WriteFaults) {
    db = new FakeDb();
    const spend = new FakeSpend();
    faults.wrap(spend, ["reserve", "settle"]);
    faults.wrap(db, ["write"], {
      label: "db",
      detail: (_method, args) => String(args[0]),
      failWith: (error) => ({ data: null, error: { message: error.message } }),
    });
    vi.mocked(createEmbedderForRequest).mockReturnValue(testEmbedder(spend));
    signInAs(ALICE);
    return spend;
  }

  function checkSpend(spend: FakeSpend, faults: WriteFaults, at: string) {
    const spendHit = faults.fired.some((f) => f.label.startsWith("FakeSpend"));
    const open = spend.reservations.filter((r) => r.settled === null);
    expect(open.length, `${at}: only a failed spend write leaves its full hold counted`).toBeLessThanOrEqual(spendHit ? 1 : 0);
  }

  async function createScenario(faults: WriteFaults, sweepCase: SweepCase, checkDuplicates?: boolean) {
    const at = describeCase(sweepCase);
    const spend = arm(faults);
    const send = () => listRoute.POST(jsonRequest("POST", { mode: "personal", content: NEW_TEXT }));
    const first = await send();
    faults.disarm();
    if (first.status !== 201) {
      expect(first.status, at).toBe(500);
      expect((await send()).status, `${at}: resend`).toBe(201);
    }
    checkSpend(spend, faults, at);
    const saved = db.tables.memories!.filter((r) => r.content === NEW_TEXT);
    expect(saved.length, at).toBeGreaterThan(0);
    for (const row of saved) expect(row.status, at).toBe("active");
    // A lost insert is a lost response on a single create, so the resend saves a second copy (it.fails below).
    if (checkDuplicates ?? !hasFault(sweepCase, "lost", "db.write:memories")) {
      expect(saved, `${at}: one saved memory`).toHaveLength(1);
    }
  }

  it("POST: every write and both faults leave one active memory and no open hold", async () => {
    const cases = await sweepWriteFaults(createScenario);
    expect([...new Set(cases.map((c) => c.at(-1)!.label))].sort()).toEqual(["FakeSpend.reserve", "FakeSpend.settle", "db.write:memories"]);
  });

  // Defect: there is no idempotency key, so a lost response on the insert makes the resend save a second copy.
  it.fails("POST: response lost on the insert, then a resend: saves the memory once", async () => {
    await createScenario(new WriteFaults().fail("lost", 3), [{ step: 3, fault: "lost", label: "db.write:memories" }], true);
  });

  it("PATCH: every write and both faults end with the new text, its vector and no open hold", async () => {
    const cases = await sweepWriteFaults(async (faults, sweepCase) => {
      const at = describeCase(sweepCase);
      const spend = arm(faults);
      const id = seedMemory(ALICE).id as string;
      const send = () => itemRoute.PATCH(jsonRequest("PATCH", { content: NEW_TEXT }), params(id));
      const first = await send();
      faults.disarm();
      if (first.status !== 200) {
        expect(first.status, at).toBe(500);
        expect((await send()).status, `${at}: resend`).toBe(200);
      }
      checkSpend(spend, faults, at);
      expect(db.tables.memories, at).toHaveLength(1);
      expect(storedRow(id), at).toMatchObject({ content: NEW_TEXT, embedding_model: EMBEDDING_MODEL });
      expect(storedRow(id)!.embedding, at).not.toBe(OLD_VECTOR);
    });
    expect([...new Set(cases.map((c) => c.at(-1)!.label))].sort()).toEqual(["FakeSpend.reserve", "FakeSpend.settle", "db.write:memories"]);
  });
});

describe("privacy and scoping", () => {
  it("never returns an embedding in any response", async () => {
    signInAs(ALICE);
    const created = await listRoute.POST(jsonRequest("POST", { mode: "personal", content: "Likes tea" }));
    expect(created.status).toBe(201);
    const memory = await created.clone().json();
    const patched = await itemRoute.PATCH(jsonRequest("PATCH", { content: "Likes green tea" }), params(memory.id));
    const listed = await listRoute.GET(plainRequest("GET", "http://localhost/api/memories?mode=personal"));

    for (const response of [created, patched, listed]) {
      const text = await response.text();
      expect(text).not.toContain("embedding");
      expect(text).not.toContain("0.1,0.2");
    }
  });

  it("never selects the embedding column", async () => {
    signInAs(ALICE);
    seedMemory(ALICE);
    await listRoute.GET(plainRequest("GET", "http://localhost/api/memories?mode=personal"));
    const created = await listRoute.POST(jsonRequest("POST", { mode: "personal", content: "x" }));
    await itemRoute.PATCH(jsonRequest("PATCH", { status: "active" }), params((await created.json()).id));

    const memoryReads = db.queries.filter((q) => q.table === "memories" && q.columns !== null);
    expect(memoryReads.length).toBeGreaterThan(0);
    for (const query of memoryReads) expect(query.columns).not.toContain("embedding");
  });

  it("scopes every memory query to the signed-in user", async () => {
    signInAs(ALICE);
    const row = seedMemory(ALICE);
    await listRoute.GET(plainRequest("GET", "http://localhost/api/memories?mode=personal"));
    await listRoute.POST(jsonRequest("POST", { mode: "personal", content: "x" }));
    await itemRoute.PATCH(jsonRequest("PATCH", { content: "y" }), params(row.id as string));
    await itemRoute.DELETE(plainRequest("DELETE"), params(row.id as string));

    const touched = db.queries.filter((q) => q.table === "memories");
    expect(touched.length).toBeGreaterThanOrEqual(4);
    for (const query of touched) expect(query.scopedToUser).toBe(true);
  });

  it("keeps memory text out of the warning lines and writes no log row", async () => {
    const secret = "Secret plan 42 for the bakery";
    signInAs(ALICE);
    embed.mockRejectedValueOnce(new ProviderError("nebius", "timeout"));
    const created = await listRoute.POST(jsonRequest("POST", { mode: "work", content: secret }));
    const memory = await created.json();
    await itemRoute.PATCH(jsonRequest("PATCH", { content: `${secret} v2` }), params(memory.id));
    await itemRoute.DELETE(plainRequest("DELETE"), params(memory.id));

    expect(consoleLines.length).toBeGreaterThan(0);
    for (const line of consoleLines) expect(line).not.toContain("Secret plan");
    expect(actionLog()).toHaveLength(0);
  });
});
