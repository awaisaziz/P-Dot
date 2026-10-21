import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthContext } from "@/server/auth/session";
import { readChatStream } from "@/features/chat/stream";
import { MemoryRepository, MemoryTasks, TEST_SPEND_CAPS, fakeDeps, testRouting } from "../support/fakes";
import { collect } from "../support/streams";

vi.mock("@/server/auth/session", () => ({ getAuthContext: vi.fn() }));
vi.mock("@/server/config", () => ({ getAssistantConfig: vi.fn(), getSiteUrl: () => "http://localhost:3000" }));
vi.mock("@/server/assistant/deps", () => ({ createAssistantDeps: vi.fn() }));
vi.mock("@/server/db/tasks", () => ({ createTaskRepository: vi.fn() }));
vi.mock("@/server/db/conversations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/db/conversations")>()),
  createConversationRepository: vi.fn(),
}));

const { getAuthContext } = await import("@/server/auth/session");
const { getAssistantConfig } = await import("@/server/config");
const { createAssistantDeps } = await import("@/server/assistant/deps");
const { createConversationRepository } = await import("@/server/db/conversations");
const { createTaskRepository } = await import("@/server/db/tasks");
const chatRoute = await import("@/app/api/chat/route");
const listRoute = await import("@/app/api/conversations/route");
const itemRoute = await import("@/app/api/conversations/[id]/route");
const tasksRoute = await import("@/app/api/tasks/route");
const taskItemRoute = await import("@/app/api/tasks/[id]/route");

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function signInAs(userId: string | null) {
  vi.mocked(getAuthContext).mockResolvedValue(
    userId ? ({ userId, email: `${userId}@example.com`, supabase: {} as SupabaseClient } satisfies AuthContext) : null,
  );
}

function jsonRequest(method: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/x", {
    method,
    headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function plainRequest(method: string, url = "http://localhost/api/x", headers: Record<string, string> = {}) {
  return new Request(url, { method, headers: { host: "localhost", origin: "http://localhost", ...headers } });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

let repo: MemoryRepository;
let tasks: MemoryTasks;

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  repo = new MemoryRepository();
  tasks = new MemoryTasks();
  vi.mocked(createConversationRepository).mockReturnValue(repo);
  vi.mocked(createTaskRepository).mockReturnValue(tasks);
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

describe("PATCH /api/conversations/:id (rename)", () => {
  it("requires a session", async () => {
    signInAs(null);
    expect((await itemRoute.PATCH(jsonRequest("PATCH", { title: "x" }), params(ALICE))).status).toBe(401);
  });

  it("renames the owner's conversation and trims the name", async () => {
    const own = await repo.createConversation(ALICE, "Old", "personal");
    signInAs(ALICE);
    const response = await itemRoute.PATCH(jsonRequest("PATCH", { title: "  New name  " }), params(own.id));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: own.id, title: "New name" });
    expect(repo.conversations[0]!.title).toBe("New name");
  });

  it("cannot rename another user's conversation", async () => {
    const theirs = await repo.createConversation(ALICE, "Alice private", "personal");
    signInAs(BOB);
    const response = await itemRoute.PATCH(jsonRequest("PATCH", { title: "pwned" }), params(theirs.id));
    expect(response.status).toBe(404);
    expect(repo.conversations[0]!.title).toBe("Alice private");
  });

  it.each([
    ["empty name", { title: "   " }],
    ["too long", { title: "x".repeat(121) }],
    ["extra fields", { title: "ok", userId: BOB }],
    ["wrong type", { title: 5 }],
  ])("rejects %s", async (_label, body) => {
    const own = await repo.createConversation(ALICE, "Old", "personal");
    signInAs(ALICE);
    expect((await itemRoute.PATCH(jsonRequest("PATCH", body), params(own.id))).status).toBe(400);
    expect(repo.conversations[0]!.title).toBe("Old");
  });

  it("rejects cross-origin renames", async () => {
    const own = await repo.createConversation(ALICE, "Old", "personal");
    signInAs(ALICE);
    const response = await itemRoute.PATCH(
      jsonRequest("PATCH", { title: "x" }, { origin: "https://evil.example" }),
      params(own.id),
    );
    expect(response.status).toBe(403);
  });
});

describe("GET /api/conversations?mode=", () => {
  it("lists only the requested mode and rejects unknown modes", async () => {
    await repo.createConversation(ALICE, "Home stuff", "personal");
    await repo.createConversation(ALICE, "Sprint plan", "work");
    signInAs(ALICE);
    const work = await (await listRoute.GET(plainRequest("GET", "http://localhost/api/conversations?mode=work"))).json();
    expect(work.conversations.map((c: { title: string }) => c.title)).toEqual(["Sprint plan"]);
    const all = await (await listRoute.GET(plainRequest("GET", "http://localhost/api/conversations"))).json();
    expect(all.conversations).toHaveLength(2);
    expect((await listRoute.GET(plainRequest("GET", "http://localhost/api/conversations?mode=other"))).status).toBe(400);
  });
});

describe("POST /api/chat mode", () => {
  it("creates new conversations in the requested mode", async () => {
    signInAs(ALICE);
    const response = await chatRoute.POST(jsonRequest("POST", { action: "send", mode: "work", message: "hi", webSearch: false }));
    expect(response.status).toBe(200);
    await collect(readChatStream(response.body!));
    expect(repo.conversations[0]).toMatchObject({ mode: "work", userId: ALICE });
  });

  it("rejects an unknown mode", async () => {
    signInAs(ALICE);
    const response = await chatRoute.POST(jsonRequest("POST", { action: "send", mode: "hobby", message: "hi", webSearch: false }));
    expect(response.status).toBe(400);
  });
});

describe("/api/tasks", () => {
  it("requires a session", async () => {
    signInAs(null);
    expect((await tasksRoute.GET(plainRequest("GET", "http://localhost/api/tasks?mode=work"))).status).toBe(401);
    expect((await tasksRoute.POST(jsonRequest("POST", { mode: "work", title: "x" }))).status).toBe(401);
    expect((await taskItemRoute.PATCH(jsonRequest("PATCH", { done: true }), params(ALICE))).status).toBe(401);
    expect((await taskItemRoute.DELETE(plainRequest("DELETE"), params(ALICE))).status).toBe(401);
  });

  it("creates, lists per mode, updates and deletes the owner's tasks", async () => {
    signInAs(ALICE);
    const created = await tasksRoute.POST(jsonRequest("POST", { mode: "work", title: "  Review PR  " }));
    expect(created.status).toBe(201);
    const task = await created.json();
    expect(task).toMatchObject({ title: "Review PR", mode: "work", done: false });
    await tasksRoute.POST(jsonRequest("POST", { mode: "personal", title: "Call mum" }));

    const work = await (await tasksRoute.GET(plainRequest("GET", "http://localhost/api/tasks?mode=work"))).json();
    expect(work.tasks.map((t: { title: string }) => t.title)).toEqual(["Review PR"]);

    const updated = await taskItemRoute.PATCH(jsonRequest("PATCH", { done: true }), params(task.id));
    expect(await updated.json()).toMatchObject({ done: true });

    expect((await taskItemRoute.DELETE(plainRequest("DELETE"), params(task.id))).status).toBe(204);
    expect(tasks.tasks.map((t) => t.title)).toEqual(["Call mum"]);
  });

  it("does not let one user read or change another user's tasks", async () => {
    const theirs = await tasks.createTask(ALICE, "work", "Secret plan");
    signInAs(BOB);
    const list = await (await tasksRoute.GET(plainRequest("GET", "http://localhost/api/tasks?mode=work"))).json();
    expect(list.tasks).toEqual([]);
    expect((await taskItemRoute.PATCH(jsonRequest("PATCH", { done: true }), params(theirs.id))).status).toBe(404);
    expect((await taskItemRoute.DELETE(plainRequest("DELETE"), params(theirs.id))).status).toBe(404);
    expect(tasks.tasks[0]).toMatchObject({ done: false });
  });

  it.each([
    ["empty title", { mode: "work", title: " " }],
    ["long title", { mode: "work", title: "x".repeat(201) }],
    ["bad mode", { mode: "family", title: "x" }],
    ["client-supplied user", { mode: "work", title: "x", userId: BOB }],
  ])("rejects %s", async (_label, body) => {
    signInAs(ALICE);
    expect((await tasksRoute.POST(jsonRequest("POST", body))).status).toBe(400);
  });

  it("rejects an empty update, a bad mode filter, and cross-origin writes", async () => {
    const task = await tasks.createTask(ALICE, "work", "x");
    signInAs(ALICE);
    expect((await taskItemRoute.PATCH(jsonRequest("PATCH", {}), params(task.id))).status).toBe(400);
    expect((await tasksRoute.GET(plainRequest("GET", "http://localhost/api/tasks?mode=nope"))).status).toBe(400);
    const cross = await tasksRoute.POST(jsonRequest("POST", { mode: "work", title: "x" }, { origin: "https://evil.example" }));
    expect(cross.status).toBe(403);
  });
});
