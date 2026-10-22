// 20261022001000_connector_grants.sql on PGlite, after every earlier migration,
// with both default-privilege modes (decision 0016, amendments of 2026-10-21):
// RLS, the column grants, the two token functions and the log trigger.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createConnectorGrantRepository, type NewConnectorGrant } from "@/server/db/connector-grants";
import { anon, errorCode, startSqlGate, user, type SqlGate } from "../support/sql-gate";

const REFRESH = "ab".repeat(40);
const ACCESS = "cd".repeat(40);

for (const defaults of ["legacy", "none"] as const) {
  describe(`connector_grants (${defaults} grants)`, () => {
    let gate: SqlGate;
    let alice: string;
    let bob: string;

    beforeAll(async () => {
      gate = await startSqlGate({ defaults });
      alice = await gate.createUser();
      bob = await gate.createUser();
    });
    afterAll(() => gate.close());

    const insert = (uid: string, extra = "") =>
      gate.as(
        user(uid),
        `insert into public.connector_grants (provider, account_sub, account_email, scopes, refresh_token_ciphertext, access_token_ciphertext, access_token_expires_at, key_version${extra ? ", status" : ""})
         values ('google', 'sub-1', 'a@example.com', array['openid','https://www.googleapis.com/auth/calendar.readonly'], decode($1, 'hex'), decode($2, 'hex'), now() + interval '1 hour', 1${extra ? `, '${extra}'` : ""})
         returning id, user_id, status`,
        [REFRESH, ACCESS],
      );

    it("inserts the caller's row and logs connector_added with ids and counts only", async () => {
      const row = (await insert(alice)).rows[0] as { id: string; user_id: string; status: string };
      expect(row.user_id).toBe(alice);
      expect(row.status).toBe("active");
      const log = await gate.admin<{ event: string; detail: Record<string, unknown>; verified: boolean }>(
        "select event, detail, verified from public.action_log where user_id = $1 order by created_at",
        [alice],
      );
      expect(log.rows).toEqual([
        {
          event: "connector_added",
          detail: { grantId: row.id, provider: "google", scopeCount: 2, status: "active" },
          verified: true,
        },
      ]);
    });

    it("refuses a second grant for the same provider", async () => {
      expect(await errorCode(() => insert(alice))).toBe("23505");
    });

    it("refuses another user's id on insert", async () => {
      const code = await errorCode(() =>
        gate.as(
          user(bob),
          `insert into public.connector_grants (user_id, provider, account_sub, account_email, scopes, refresh_token_ciphertext, key_version)
           values ($1, 'google', 's', 'a@example.com', array['openid'], decode($2, 'hex'), 1)`,
          [alice, REFRESH],
        ),
      );
      expect(code).toBe("42501");
    });

    it("refuses selecting a ciphertext column and allows the others", async () => {
      expect(await errorCode(() => gate.as(user(alice), "select refresh_token_ciphertext from public.connector_grants"))).toBe("42501");
      expect(await errorCode(() => gate.as(user(alice), "select access_token_ciphertext from public.connector_grants"))).toBe("42501");
      expect(await errorCode(() => gate.as(user(alice), "select * from public.connector_grants"))).toBe("42501");
      const ok = await gate.as(
        user(alice),
        "select id, user_id, provider, account_sub, account_email, scopes, access_token_expires_at, key_version, status, last_used_at, created_at, updated_at from public.connector_grants",
      );
      expect(ok.rows).toHaveLength(1);
      const other = await gate.as(user(bob), "select id from public.connector_grants");
      expect(other.rows).toHaveLength(0);
    });

    it("refuses updating ciphertext or account columns directly", async () => {
      for (const column of ["refresh_token_ciphertext", "access_token_ciphertext", "key_version", "account_sub", "user_id", "provider"]) {
        const value = column.endsWith("ciphertext") ? "'\\x00'::bytea" : column === "key_version" ? "2" : column === "user_id" ? `'${bob}'` : "'x'";
        expect(await errorCode(() => gate.as(user(alice), `update public.connector_grants set ${column} = ${value}`)), column).toBe("42501");
      }
      const ok = await gate.as(
        user(alice),
        "update public.connector_grants set account_email = 'b@example.com', last_used_at = now(), access_token_expires_at = now() returning id",
      );
      expect(ok.rows).toHaveLength(1);
    });

    it("logs a status or scope change and not a token write or last-used time", async () => {
      const id = ((await gate.admin("select id from public.connector_grants where user_id = $1", [alice])).rows[0] as { id: string }).id;
      await gate.as(user(alice), "update public.connector_grants set last_used_at = now()");
      await gate.as(user(alice), "update public.connector_grants set status = 'active'");
      await gate.as(user(alice), "select public.store_connector_tokens($1, null, decode($2, 'hex'), now(), 1::smallint)", [id, ACCESS]);
      await gate.as(user(alice), "update public.connector_grants set status = 'needs_reconnect'");
      await gate.as(user(alice), "update public.connector_grants set scopes = array['openid']");
      const log = await gate.admin<{ event: string; detail: Record<string, unknown> }>(
        "select event, detail from public.action_log where user_id = $1 order by created_at",
        [alice],
      );
      expect(log.rows.map((r) => r.event)).toEqual(["connector_added", "connector_changed", "connector_changed"]);
      expect(log.rows[1]!.detail).toEqual({ grantId: id, provider: "google", scopeCount: 2, status: "needs_reconnect" });
      expect(log.rows[2]!.detail).toEqual({ grantId: id, provider: "google", scopeCount: 1, status: "needs_reconnect" });
    });

    it("stores tokens only on the caller's own row and keeps the refresh token on null", async () => {
      const id = ((await gate.admin("select id from public.connector_grants where user_id = $1", [alice])).rows[0] as { id: string }).id;
      const newRefresh = "ef".repeat(40);
      const stored = await gate.as<{ ok: boolean }>(
        user(alice),
        "select public.store_connector_tokens($1, decode($2, 'hex'), null, null, 2::smallint) as ok",
        [id, newRefresh],
      );
      expect(stored.rows[0]!.ok).toBe(true);
      const foreign = await gate.as<{ ok: boolean }>(
        user(bob),
        "select public.store_connector_tokens($1, decode($2, 'hex'), decode($2, 'hex'), now(), 1::smallint) as ok",
        [id, REFRESH],
      );
      expect(foreign.rows[0]!.ok).toBe(false);
      const keep = await gate.as<{ ok: boolean }>(
        user(alice),
        "select public.store_connector_tokens($1, null, decode($2, 'hex'), now(), 2::smallint) as ok",
        [id, ACCESS],
      );
      expect(keep.rows[0]!.ok).toBe(true);
      const row = await gate.admin<{ r: string; a: string; v: number }>(
        "select encode(refresh_token_ciphertext, 'hex') as r, encode(access_token_ciphertext, 'hex') as a, key_version as v from public.connector_grants where id = $1",
        [id],
      );
      expect(row.rows[0]).toEqual({ r: "ef".repeat(40), a: "cd".repeat(40), v: 2 });
      // A too short ciphertext breaks the check.
      expect(
        await errorCode(() => gate.as(user(alice), "select public.store_connector_tokens($1, '\\x00'::bytea, null, null, 1::smallint)", [id])),
      ).toBe("23514");
    });

    it("returns secrets for the caller's own row in any status, as PostgREST JSON", async () => {
      const id = ((await gate.admin("select id from public.connector_grants where user_id = $1", [alice])).rows[0] as { id: string }).id;
      const mine = await gate.as<{ data: unknown }>(
        user(alice),
        "select coalesce(json_agg(t), '[]'::json) as data from public.connector_grant_secrets($1) t",
        [id],
      );
      expect(mine.rows[0]!.data).toEqual([
        { id, key_version: 2, refresh_token_ciphertext: "\\x" + "ef".repeat(40), access_token_ciphertext: "\\x" + "cd".repeat(40) },
      ]);
      const theirs = await gate.as<{ data: unknown }>(
        user(bob),
        "select coalesce(json_agg(t), '[]'::json) as data from public.connector_grant_secrets($1) t",
        [id],
      );
      expect(theirs.rows[0]!.data).toEqual([]);
    });

    it("refuses both functions without a signed-in user, and anon cannot call them", async () => {
      expect(await errorCode(() => gate.as(anon, "select * from public.connector_grant_secrets(gen_random_uuid())"))).toBe("42501");
      expect(
        await errorCode(() => gate.as(anon, "select public.store_connector_tokens(gen_random_uuid(), null, null, null, 1::smallint)")),
      ).toBe("42501");
      expect(await errorCode(() => gate.as(anon, "select id from public.connector_grants"))).toBe("42501");
      // As the owner with no claims, auth.uid() is null.
      expect(await errorCode(() => gate.admin("select * from public.connector_grant_secrets(gen_random_uuid())"))).toBe("42501");
    });

    it("no API role can call the log trigger function", async () => {
      expect(await errorCode(() => gate.as(user(alice), "select public.log_connector_change()"))).toBe("42501");
      const grants = await gate.admin<{ grantee: string }>(
        `select grantee from information_schema.role_routine_grants where routine_name = 'log_connector_change' and grantee in ('anon','authenticated','PUBLIC')`,
      );
      expect(grants.rows).toEqual([]);
    });

    it("deletes the caller's row and logs connector_removed", async () => {
      const del = await gate.as(user(bob), "delete from public.connector_grants returning id");
      expect(del.rows).toHaveLength(0);
      const mine = await gate.as(user(alice), "delete from public.connector_grants returning id");
      expect(mine.rows).toHaveLength(1);
      const log = await gate.admin<{ event: string }>(
        "select event from public.action_log where user_id = $1 order by created_at desc limit 1",
        [alice],
      );
      expect(log.rows[0]!.event).toBe("connector_removed");
    });

    it("cascades on account deletion", async () => {
      await insert(bob);
      await gate.admin("delete from auth.users where id = $1", [bob]);
      const left = await gate.admin("select id from public.connector_grants where user_id = $1", [bob]);
      expect(left.rows).toHaveLength(0);
    });

    it("refuses an unknown provider or status and still accepts old events", async () => {
      expect(
        await errorCode(() =>
          gate.as(
            user(alice),
            `insert into public.connector_grants (provider, account_sub, account_email, scopes, refresh_token_ciphertext, key_version) values ('github', 's', 'a@example.com', array['x'], decode($1, 'hex'), 1)`,
            [REFRESH],
          ),
        ),
      ).toBe("23514");
      expect(await errorCode(() => insert(alice, "revoked"))).toBe("23514");
      expect(
        await errorCode(() =>
          gate.admin("insert into public.action_log (user_id, event, detail) values ($1, 'memory_added', '{}')", [alice]),
        ),
      ).toBeNull();
      expect(
        await errorCode(() => gate.admin("insert into public.action_log (user_id, event, detail) values ($1, 'connector_gone', '{}')", [alice])),
      ).toBe("23514");
    });
  });
}

// ---------------------------------------------------------------------------
// The real repository against the real schema, through a small stand-in for
// PostgREST: rows go in through json_populate_record and come back through
// json_agg, so bytea travels as hex text both ways, as in production. It
// supports only the calls the repository makes.
// ---------------------------------------------------------------------------

const IDENT = /^[a-z_][a-z0-9_]*$/;
const ident = (name: string) => {
  if (!IDENT.test(name)) throw new Error(`unsupported identifier ${name}`);
  return name;
};

type Reply = { data: unknown; error: { code: string; message: string } | null; count?: number | null };

function postgrest(gate: SqlGate, uid: string): SupabaseClient {
  const run = async (sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] } | Reply> => {
    try {
      return await gate.as(user(uid), sql, params);
    } catch (error) {
      return { data: null, error: { code: String((error as { code?: string }).code ?? ""), message: (error as Error).message } };
    }
  };
  const failed = (value: unknown): value is Reply => typeof value === "object" && value !== null && "error" in value;

  const from = (table: string) => {
    const t = `public.${ident(table)}`;
    let op: "select" | "insert" | "update" | "delete" = "select";
    let columns: string[] | null = null;
    let payload: Record<string, unknown> = {};
    const filters: [string, unknown][] = [];
    let shape: "many" | "single" | "maybe" = "many";
    let wantCount = false;

    const execute = async (): Promise<Reply> => {
      // Only inserts and updates send the row as $1.
      const offset = op === "insert" || op === "update" ? 2 : 1;
      const where = filters.length ? `where ${filters.map(([c], i) => `${t}.${ident(c)}::text = $${i + offset}`).join(" and ")}` : "";
      const params = [...(offset === 2 ? [JSON.stringify(payload)] : []), ...filters.map(([, v]) => String(v))];
      const returning = columns ? columns.map((c) => `${t}.${ident(c)}`).join(", ") : "1 as one";
      const keys = Object.keys(payload).map(ident);
      const agg = `select coalesce(json_agg(x), '[]'::json) as data, count(*)::int as count from x`;
      let sql: string;
      if (op === "select") {
        sql = `with x as (select ${columns!.join(", ")} from ${t} ${where}) ${agg}`;
      } else if (op === "insert") {
        sql = `with x as (insert into ${t} (${keys.join(", ")}) select ${keys.join(", ")} from json_populate_record(null::${t}, $1::json) returning ${returning}) ${agg}`;
      } else if (op === "update") {
        const set = keys.map((k) => `${k} = r.${k}`).join(", ");
        sql = `with x as (update ${t} set ${set} from json_populate_record(null::${t}, $1::json) r ${where} returning ${returning}) ${agg}`;
      } else {
        sql = `with x as (delete from ${t} ${where} returning 1) ${agg}`;
      }
      const result = await run(sql, params);
      if (failed(result)) return result;
      const row = result.rows[0] as { data: unknown[]; count: number };
      if (op === "delete") return { data: null, error: null, count: wantCount ? row.count : null };
      if (!columns) return { data: null, error: null };
      if (shape === "many") return { data: row.data, error: null };
      if (row.data.length > 1 || (shape === "single" && row.data.length === 0)) {
        return { data: null, error: { code: "PGRST116", message: "not one row" } };
      }
      return { data: row.data[0] ?? null, error: null };
    };

    const builder = {
      select(list: string) {
        columns = list.split(",").map((c) => ident(c.trim()));
        return builder;
      },
      insert(row: Record<string, unknown>) {
        op = "insert";
        payload = row;
        return builder;
      },
      update(row: Record<string, unknown>) {
        op = "update";
        payload = row;
        return builder;
      },
      delete(options?: { count?: string }) {
        op = "delete";
        wantCount = options?.count === "exact";
        return builder;
      },
      eq(column: string, value: unknown) {
        filters.push([column, value]);
        return builder;
      },
      single() {
        shape = "single";
        return builder;
      },
      maybeSingle() {
        shape = "maybe";
        return builder;
      },
      then<R1, R2>(
        onFulfilled?: ((value: Reply) => R1 | PromiseLike<R1>) | null,
        onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
      ) {
        return execute().then(onFulfilled, onRejected);
      },
    };
    return builder;
  };

  const rpc = async (name: string, args: Record<string, unknown>): Promise<Reply> => {
    const arg = (key: string, type: string) => `(($1::json) ->> '${ident(key)}')::${type}`;
    const sql =
      name === "store_connector_tokens"
        ? `select public.store_connector_tokens(${arg("p_id", "uuid")}, ${arg("p_refresh", "bytea")}, ${arg("p_access", "bytea")}, ${arg("p_expires", "timestamptz")}, ${arg("p_key_version", "smallint")}) as data`
        : `select coalesce(json_agg(x), '[]'::json) as data from public.${ident(name)}(${arg("p_id", "uuid")}) x`;
    const result = await run(sql, [JSON.stringify(args)]);
    if (failed(result)) return result;
    return { data: result.rows[0]!.data, error: null };
  };

  return { from, rpc } as unknown as SupabaseClient;
}

describe("connector grant repository on the real schema", () => {
  let gate: SqlGate;
  let alice: string;
  let bob: string;

  beforeAll(async () => {
    gate = await startSqlGate({ defaults: "none" });
    alice = await gate.createUser();
    bob = await gate.createUser();
  });
  afterAll(() => gate.close());

  const bytes = (fill: number, length = 60) => new Uint8Array(length).fill(fill);
  const grant = (overrides: Partial<NewConnectorGrant> = {}): NewConnectorGrant => ({
    provider: "google",
    accountSub: "sub-a",
    accountEmail: "a@example.com",
    scopes: ["https://www.googleapis.com/auth/calendar.readonly", "openid"],
    keyVersion: 1,
    refreshCiphertext: bytes(1),
    accessCiphertext: bytes(2),
    accessExpiresAt: "2026-10-21T13:00:00.000Z",
    ...overrides,
  });

  it("creates, reads, stores tokens, replaces and deletes through PostgREST-shaped calls", async () => {
    const repo = createConnectorGrantRepository(postgrest(gate, alice));
    expect(await repo.getGrant(alice, "google")).toBeNull();

    const first = await repo.createOrReplaceGrant(alice, grant());
    expect(first.previous).toBeNull();
    expect(first.grant).toMatchObject({ provider: "google", accountSub: "sub-a", status: "active", keyVersion: 1 });
    expect(await repo.getGrant(alice, "google")).toEqual(first.grant);
    expect(await repo.readSecrets(alice, first.grant.id)).toEqual({
      id: first.grant.id,
      keyVersion: 1,
      refreshCiphertext: bytes(1),
      accessCiphertext: bytes(2),
    });

    const kept = { refreshCiphertext: null, accessCiphertext: bytes(3), accessExpiresAt: null, keyVersion: 2 };
    expect(await repo.storeTokens(alice, first.grant.id, kept)).toBe(true);
    expect(await repo.readSecrets(alice, first.grant.id)).toMatchObject({
      keyVersion: 2,
      refreshCiphertext: bytes(1),
      accessCiphertext: bytes(3),
    });

    expect(await repo.setStatus(alice, first.grant.id, "needs_reconnect")).toBe(true);
    await repo.touchLastUsed(alice, first.grant.id, "2026-10-21T12:30:00.000Z");
    expect((await repo.getGrant(alice, "google"))!.lastUsedAt).not.toBeNull();
    const same = await repo.createOrReplaceGrant(alice, grant({ accountEmail: "new@example.com", refreshCiphertext: bytes(4) }));
    expect(same.grant).toMatchObject({ id: first.grant.id, accountEmail: "new@example.com", status: "active", keyVersion: 1 });
    expect((await repo.readSecrets(alice, first.grant.id))!.refreshCiphertext).toEqual(bytes(4));

    const other = await repo.createOrReplaceGrant(
      alice,
      grant({ accountSub: "sub-b", refreshCiphertext: bytes(5), accessCiphertext: null }),
    );
    expect(other.previous?.accountSub).toBe("sub-a");
    expect(other.grant.id).not.toBe(first.grant.id);
    const rows = await gate.admin("select account_sub from public.connector_grants where user_id = $1", [alice]);
    expect(rows.rows).toEqual([{ account_sub: "sub-b" }]);

    const log = await gate.admin<{ event: string }>(
      "select event from public.action_log where user_id = $1 order by created_at",
      [alice],
    );
    expect(log.rows.map((r) => r.event)).toEqual([
      "connector_added",
      "connector_changed",
      "connector_changed",
      "connector_removed",
      "connector_added",
    ]);

    const bobs = createConnectorGrantRepository(postgrest(gate, bob));
    expect(await bobs.getGrant(bob, "google")).toBeNull();
    expect(await bobs.readSecrets(bob, other.grant.id)).toBeNull();
    const foreign = { refreshCiphertext: bytes(9), accessCiphertext: null, accessExpiresAt: null, keyVersion: 1 };
    expect(await bobs.storeTokens(bob, other.grant.id, foreign)).toBe(false);
    expect(await bobs.deleteGrant(bob, other.grant.id)).toBe(false);
    expect(await bobs.setStatus(bob, other.grant.id, "needs_reconnect")).toBe(false);

    expect(await repo.deleteGrant(alice, other.grant.id)).toBe(true);
    expect(await repo.getGrant(alice, "google")).toBeNull();
  });

  it("puts the old account's row back when its replacement cannot be inserted", async () => {
    const carol = await gate.createUser();
    const repo = createConnectorGrantRepository(postgrest(gate, carol));
    const first = await repo.createOrReplaceGrant(carol, grant());
    await repo.touchLastUsed(carol, first.grant.id, "2026-10-21T12:30:00.000Z");
    const before = await repo.getGrant(carol, "google");
    const secrets = await repo.readSecrets(carol, first.grant.id);

    // A check constraint refuses the new account's row (a one-character email), after the old row was deleted.
    await expect(repo.createOrReplaceGrant(carol, grant({ accountSub: "sub-b", accountEmail: "x" }))).rejects.toThrow();
    expect(await repo.getGrant(carol, "google")).toEqual({ ...before, updatedAt: expect.any(String) });
    expect(await repo.readSecrets(carol, first.grant.id)).toEqual(secrets);
    const log = await gate.admin<{ event: string }>(
      "select event from public.action_log where user_id = $1 order by created_at",
      [carol],
    );
    expect(log.rows.map((r) => r.event)).toEqual(["connector_added", "connector_removed", "connector_added"]);
  });

  it("reads a missing table as no grant", async () => {
    await gate.admin("drop table public.connector_grants cascade");
    const repo = createConnectorGrantRepository(postgrest(gate, alice));
    expect(await repo.getGrant(alice, "google")).toBeNull();
  });
});
