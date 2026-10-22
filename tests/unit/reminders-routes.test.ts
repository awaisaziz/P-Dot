import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthContext } from "@/server/auth/session";
import type { NewReminder, ReminderChanges, ReminderRepository } from "@/server/db/reminders";
import type { Mode, ReminderDTO } from "@/types/api";

vi.mock("@/server/auth/session", () => ({ getAuthContext: vi.fn() }));
vi.mock("@/server/db/reminders", () => ({ createReminderRepository: vi.fn() }));
vi.mock("@/server/db/action-log", () => ({ createActionLogRepository: vi.fn() }));

const { getAuthContext } = await import("@/server/auth/session");
const { createReminderRepository } = await import("@/server/db/reminders");
const { createActionLogRepository } = await import("@/server/db/action-log");
const listRoute = await import("@/app/api/reminders/route");
const itemRoute = await import("@/app/api/reminders/[id]/route");

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MISSING_ID = "99999999-9999-4999-8999-999999999999";
const DUE = "2026-10-30T17:00:00Z";
/** A distinct title, so a test can find it if it ever reaches a log. */
const SECRET_TITLE = "Pay the Acme invoice";

function signInAs(userId: string | null) {
  vi.mocked(getAuthContext).mockResolvedValue(
    userId ? ({ userId, email: `${userId}@example.com`, supabase: {} as SupabaseClient } satisfies AuthContext) : null,
  );
}

function jsonRequest(method: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/reminders", {
    method,
    headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function plainRequest(method: string, url = "http://localhost/api/reminders", headers: Record<string, string> = {}) {
  return new Request(url, { method, headers: { host: "localhost", origin: "http://localhost", ...headers } });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** In-memory reminder store. Each row keeps its owner, as the database does. */
class MemoryReminders implements ReminderRepository {
  rows: { userId: string; reminder: ReminderDTO }[] = [];
  private counter = 0;

  async listReminders(userId: string, limit: number, mode?: Mode) {
    return this.rows
      .filter((row) => row.userId === userId && (!mode || row.reminder.mode === mode))
      .map((row) => ({ ...row.reminder }))
      .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
      .slice(0, limit);
  }

  async getReminder(userId: string, reminderId: string) {
    const row = this.rows.find((r) => r.userId === userId && r.reminder.id === reminderId);
    return row ? { ...row.reminder } : null;
  }

  async createReminder(userId: string, input: NewReminder) {
    this.counter += 1;
    const reminder: ReminderDTO = {
      id: `30000000-0000-4000-8000-${String(this.counter).padStart(12, "0")}`,
      mode: input.mode,
      title: input.title,
      dueAt: input.dueAt,
      status: "scheduled",
      proposalId: input.proposalId ?? null,
      createdAt: "2026-10-19T09:00:00.000Z",
      updatedAt: "2026-10-19T09:00:00.000Z",
    };
    this.rows.push({ userId, reminder });
    return { ...reminder };
  }

  async updateReminder(userId: string, reminderId: string, changes: ReminderChanges) {
    const row = this.rows.find((r) => r.userId === userId && r.reminder.id === reminderId);
    if (!row) return null;
    if (changes.title !== undefined) row.reminder.title = changes.title;
    if (changes.dueAt !== undefined) row.reminder.dueAt = changes.dueAt;
    if (changes.status !== undefined) row.reminder.status = changes.status;
    row.reminder.updatedAt = "2026-10-19T10:00:00.000Z";
    return { ...row.reminder };
  }

  async deleteReminder(userId: string, reminderId: string) {
    const index = this.rows.findIndex((r) => r.userId === userId && r.reminder.id === reminderId);
    if (index === -1) return false;
    this.rows.splice(index, 1);
    return true;
  }
}

let reminders: MemoryReminders;

/** Adds a reminder for a user straight to the store, without going through the route. */
async function seed(userId: string, mode: Mode, title: string, dueAt = DUE) {
  return reminders.createReminder(userId, { mode, title, dueAt });
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  reminders = new MemoryReminders();
  vi.mocked(createReminderRepository).mockReturnValue(reminders);
  vi.mocked(createActionLogRepository).mockClear();
});

describe("/api/reminders requires a session", () => {
  it("returns 401 for every method", async () => {
    signInAs(null);
    expect((await listRoute.GET(plainRequest("GET", "http://localhost/api/reminders"))).status).toBe(401);
    expect((await listRoute.POST(jsonRequest("POST", { title: "x", dueAt: DUE }))).status).toBe(401);
    expect((await itemRoute.PATCH(jsonRequest("PATCH", { title: "x" }), params(ALICE))).status).toBe(401);
    expect((await itemRoute.DELETE(plainRequest("DELETE"), params(ALICE))).status).toBe(401);
  });
});

describe("GET /api/reminders", () => {
  it("lists every reminder whatever its mode, soonest first", async () => {
    await seed(ALICE, "work", "Late", "2026-11-02T09:00:00Z");
    await seed(ALICE, "work", "Early", "2026-10-21T09:00:00Z");
    await seed(ALICE, "personal", "Home");
    signInAs(ALICE);

    const response = await listRoute.GET(plainRequest("GET", "http://localhost/api/reminders"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.reminders.map((r: ReminderDTO) => r.title)).toEqual(["Early", "Home", "Late"]);
    expect(body.reminders[0]).toEqual(
      expect.objectContaining({ mode: "work", dueAt: "2026-10-21T09:00:00Z", status: "scheduled", proposalId: null }),
    );
  });

  it("accepts a missing mode, and ignores any ?mode= from an older tab", async () => {
    await seed(ALICE, "work", "Standup");
    await seed(ALICE, "personal", "Dentist");
    signInAs(ALICE);
    for (const url of ["http://localhost/api/reminders", "http://localhost/api/reminders?mode=personal", "http://localhost/api/reminders?mode=family"]) {
      const response = await listRoute.GET(plainRequest("GET", url));
      expect(response.status).toBe(200);
      expect((await response.json()).reminders).toHaveLength(2);
    }
  });

  it("does not show another user's reminders", async () => {
    await seed(ALICE, "work", "Secret plan");
    signInAs(BOB);
    const body = await (await listRoute.GET(plainRequest("GET", "http://localhost/api/reminders"))).json();
    expect(body.reminders).toEqual([]);
  });
});

describe("POST /api/reminders", () => {
  it("creates a reminder, trims the title and ignores a mode from an older tab", async () => {
    signInAs(ALICE);
    const response = await listRoute.POST(
      jsonRequest("POST", { mode: "work", title: `  ${SECRET_TITLE}  `, dueAt: DUE }),
    );
    expect(response.status).toBe(201);
    expect(reminders.rows[0]!.reminder.mode).toBe("personal");
    expect(await response.json()).toMatchObject({
      mode: "personal",
      title: SECRET_TITLE,
      dueAt: DUE,
      status: "scheduled",
      proposalId: null,
    });

  });

  it("accepts a missing mode and stores WORKSPACE_MODE (decision 0014)", async () => {
    signInAs(ALICE);
    const response = await listRoute.POST(jsonRequest("POST", { title: "Call the dentist", dueAt: DUE }));
    expect(response.status).toBe(201);
    expect((await response.json()).mode).toBe("personal");
    expect(reminders.rows[0]!.reminder.mode).toBe("personal");
  });

  it("accepts a title of exactly 200 characters", async () => {
    signInAs(ALICE);
    const response = await listRoute.POST(jsonRequest("POST", { mode: "personal", title: "x".repeat(200), dueAt: DUE }));
    expect(response.status).toBe(201);
  });

  it.each([
    ["empty title", { mode: "work", title: " ", dueAt: DUE }],
    ["title over 200 characters", { mode: "work", title: "x".repeat(201), dueAt: DUE }],
    ["missing title", { mode: "work", dueAt: DUE }],
    ["bad mode", { mode: "family", title: "x", dueAt: DUE }],
    ["due time without a time zone", { mode: "work", title: "x", dueAt: "2026-10-30T17:00:00" }],
    ["due date with no time", { mode: "work", title: "x", dueAt: "2026-10-30" }],
    ["due time in words", { mode: "work", title: "x", dueAt: "tomorrow at 5pm" }],
    ["missing due time", { mode: "work", title: "x" }],
    ["unknown field", { mode: "work", title: "x", dueAt: DUE, userId: BOB }],
    ["client-chosen status", { mode: "work", title: "x", dueAt: DUE, status: "done" }],
  ])("rejects %s with 400 and writes nothing", async (_label, body) => {
    signInAs(ALICE);
    const response = await listRoute.POST(jsonRequest("POST", body));
    expect(response.status).toBe(400);
    expect(reminders.rows).toEqual([]);
  });

  it("rejects a cross-origin create", async () => {
    signInAs(ALICE);
    const response = await listRoute.POST(
      jsonRequest("POST", { mode: "work", title: "x", dueAt: DUE }, { origin: "https://evil.example" }),
    );
    expect(response.status).toBe(403);
    expect(reminders.rows).toEqual([]);
  });
});

describe("PATCH /api/reminders/:id", () => {
  it("changes the title, due time and status", async () => {
    const own = await seed(ALICE, "work", "Old title");
    signInAs(ALICE);

    const response = await itemRoute.PATCH(
      jsonRequest("PATCH", { title: "New title", dueAt: "2026-11-01T08:30:00+01:00", status: "done" }),
      params(own.id),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: own.id,
      title: "New title",
      dueAt: "2026-11-01T08:30:00+01:00",
      status: "done",
    });

  });

  it("can cancel a reminder", async () => {
    const own = await seed(ALICE, "personal", "Call mum");
    signInAs(ALICE);
    const response = await itemRoute.PATCH(jsonRequest("PATCH", { status: "cancelled" }), params(own.id));
    expect(await response.json()).toMatchObject({ status: "cancelled" });
  });

  it.each([
    ["empty body", {}],
    ["unknown status", { status: "archived" }],
    ["empty title", { title: "   " }],
    ["bad due time", { dueAt: "2026-10-30T17:00:00" }],
    ["mode change", { mode: "personal" }],
    ["unknown field", { status: "done", userId: BOB }],
  ])("rejects %s with 400 and changes nothing", async (_label, body) => {
    const own = await seed(ALICE, "work", "Keep me");
    signInAs(ALICE);
    expect((await itemRoute.PATCH(jsonRequest("PATCH", body), params(own.id))).status).toBe(400);
    expect(reminders.rows[0]!.reminder).toMatchObject({ title: "Keep me", status: "scheduled", mode: "work" });
  });

  it("cannot change another user's reminder", async () => {
    const theirs = await seed(ALICE, "work", "Alice private");
    signInAs(BOB);
    const response = await itemRoute.PATCH(jsonRequest("PATCH", { status: "done" }), params(theirs.id));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found", message: "Reminder not found." } });
    expect(reminders.rows[0]!.reminder).toMatchObject({ status: "scheduled" });
  });

  it("returns 404 for an ID that is not a UUID", async () => {
    signInAs(ALICE);
    expect((await itemRoute.PATCH(jsonRequest("PATCH", { status: "done" }), params("not-a-uuid"))).status).toBe(404);
  });

  it("rejects a cross-origin change", async () => {
    const own = await seed(ALICE, "work", "x");
    signInAs(ALICE);
    const response = await itemRoute.PATCH(
      jsonRequest("PATCH", { status: "done" }, { origin: "https://evil.example" }),
      params(own.id),
    );
    expect(response.status).toBe(403);
    expect(reminders.rows[0]!.reminder.status).toBe("scheduled");
  });
});

describe("DELETE /api/reminders/:id", () => {
  it("removes the reminder", async () => {
    const own = await seed(ALICE, "personal", SECRET_TITLE);
    signInAs(ALICE);

    const response = await itemRoute.DELETE(plainRequest("DELETE"), params(own.id));
    expect(response.status).toBe(204);
    expect(reminders.rows).toEqual([]);

  });

  it("cannot delete another user's reminder", async () => {
    const theirs = await seed(ALICE, "work", "Alice private");
    signInAs(BOB);
    const response = await itemRoute.DELETE(plainRequest("DELETE"), params(theirs.id));
    expect(response.status).toBe(404);
    expect(reminders.rows).toHaveLength(1);
  });

  it("returns 404 for an unknown reminder", async () => {
    signInAs(ALICE);
    const response = await itemRoute.DELETE(plainRequest("DELETE"), params(MISSING_ID));
    expect(response.status).toBe(404);
  });

  it("rejects a cross-origin delete", async () => {
    const own = await seed(ALICE, "work", "x");
    signInAs(ALICE);
    const response = await itemRoute.DELETE(plainRequest("DELETE", undefined, { origin: "https://evil.example" }), params(own.id));
    expect(response.status).toBe(403);
    expect(reminders.rows).toHaveLength(1);
  });
});

describe("action log", () => {
  it("is never written by the routes: the database writes it from triggers", async () => {
    signInAs(ALICE);
    const created = await (
      await listRoute.POST(jsonRequest("POST", { mode: "work", title: SECRET_TITLE, dueAt: DUE }))
    ).json();
    await itemRoute.PATCH(jsonRequest("PATCH", { title: "Renamed secret" }), params(created.id));
    await itemRoute.DELETE(plainRequest("DELETE"), params(created.id));

    expect(reminders.rows).toHaveLength(0);
    expect(createActionLogRepository).not.toHaveBeenCalled();
  });
});
