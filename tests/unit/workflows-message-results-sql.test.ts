import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jsonbTextBytes } from "@/server/db/message-results";
import { anon, errorCode, startSqlGate, user, type DefaultGrants, type SqlGate } from "../support/sql-gate";
import { SAMPLE_RESULTS_PAYLOAD as PAYLOAD } from "../support/workflow-fakes";

// The message_results migration (20261022000500) on an in-memory Postgres with
// every migration applied: RLS, grants, checks and the cascade. The integrator
// adds the table to tests/integration/sql-gate.test.ts as well.

const PERMISSION_DENIED = "42501";
const CHECK_VIOLATION = "23514";
const FOREIGN_KEY = "23503";

describe.each(["legacy", "none"] satisfies DefaultGrants[])("message_results in the database (%s default grants)", (defaults) => {
  let gate: SqlGate;
  let alice: string;
  let bob: string;
  let aliceMessage: string;
  let bobMessage: string;

  async function message(owner: string): Promise<string> {
    const conversation = await gate.admin<{ id: string }>("insert into public.conversations (user_id, title) values ($1, 't') returning id", [owner]);
    const row = await gate.admin<{ id: string }>(
      "insert into public.messages (conversation_id, user_id, role, content) values ($1, $2, 'assistant', 'reply') returning id",
      [conversation.rows[0]!.id, owner],
    );
    return row.rows[0]!.id;
  }

  const insert = (actor: string, messageId: string, kinds: unknown, payload: unknown) =>
    gate.as(user(actor), "insert into public.message_results (message_id, kinds, payload) values ($1, $2, $3)", [messageId, kinds, payload]);

  beforeAll(async () => {
    gate = await startSqlGate({ defaults });
    alice = await gate.createUser();
    bob = await gate.createUser();
    aliceMessage = await message(alice);
    bobMessage = await message(bob);
  });

  afterAll(async () => {
    await gate.close();
  });

  it("lets the owner insert and read a row, with user_id taken from the session", async () => {
    await insert(alice, aliceMessage, ["flights", "research"], JSON.stringify(PAYLOAD));
    const rows = await gate.as<{ user_id: string; kinds: string[] }>(user(alice), "select user_id, kinds from public.message_results");
    expect(rows.rows).toEqual([{ user_id: alice, kinds: ["flights", "research"] }]);
    // Bob sees nothing of Alice's.
    expect((await gate.as(user(bob), "select * from public.message_results")).rows).toEqual([]);
  });

  it("measures the payload the way the size check does", async () => {
    const size = await gate.admin<{ bytes: number }>("select octet_length(payload::text) as bytes from public.message_results where message_id = $1", [aliceMessage]);
    expect(size.rows[0]!.bytes).toBe(jsonbTextBytes(PAYLOAD));
  });

  it("refuses rows for another user's message or with another user_id", async () => {
    expect(await errorCode(() => insert(alice, bobMessage, ["flights"], "{}"))).toBe(FOREIGN_KEY);
    expect(
      await errorCode(() =>
        gate.as(user(alice), "insert into public.message_results (message_id, user_id, kinds, payload) values ($1, $2, '{}', '{}')", [bobMessage, bob]),
      ),
    ).toBe(PERMISSION_DENIED);
  });

  it("checks kinds and payload", async () => {
    const fresh = await message(alice);
    expect(await errorCode(() => insert(alice, fresh, ["email"], "{}"))).toBe(CHECK_VIOLATION);
    expect(await errorCode(() => insert(alice, fresh, [null], "{}"))).toBe(CHECK_VIOLATION);
    expect(await errorCode(() => insert(alice, fresh, ["flights", "flights", "drive", "calendar", "research"], "{}"))).toBe(CHECK_VIOLATION);
    expect(await errorCode(() => insert(alice, fresh, ["flights"], "[]"))).toBe(CHECK_VIOLATION);
    expect(await errorCode(() => insert(alice, fresh, ["flights"], JSON.stringify({ text: "x".repeat(32_768) })))).toBe(CHECK_VIOLATION);
    expect(await errorCode(() => insert(alice, fresh, [], "{}"))).toBeNull();
  });

  it("has no update or delete grant and nothing for anon", async () => {
    expect(await errorCode(() => gate.as(user(alice), "update public.message_results set kinds = '{}'"))).toBe(PERMISSION_DENIED);
    expect(await errorCode(() => gate.as(user(alice), "delete from public.message_results"))).toBe(PERMISSION_DENIED);
    expect(await errorCode(() => gate.as(anon, "select * from public.message_results"))).toBe(PERMISSION_DENIED);
    expect(await errorCode(() => gate.as(anon, "insert into public.message_results (message_id, kinds, payload) values ($1, '{}', '{}')", [aliceMessage]))).toBe(
      PERMISSION_DENIED,
    );
  });

  it("goes with its message", async () => {
    await gate.admin("delete from public.messages where id = $1", [aliceMessage]);
    const left = await gate.admin("select * from public.message_results where message_id = $1", [aliceMessage]);
    expect(left.rows).toEqual([]);
  });
});
