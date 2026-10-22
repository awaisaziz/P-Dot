import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createActionLogRepository } from "@/server/db/action-log";
import { createActionProposalRepository } from "@/server/db/action-proposals";
import { sqlGateClient } from "../support/sql-gate-client";
import { MEMORY, REMINDER, TASK, decideAs, propose, proposalEvents, type Decision } from "../support/sql-gate-actions";
import {
  anon,
  defaultGrantsOnNewTable,
  errorCode,
  startSqlGate,
  user,
  type DefaultGrants,
  type SqlGate,
} from "../support/sql-gate";

/**
 * Database gate: applies every migration to an in-memory Postgres with
 * Supabase stand-ins, then checks grants and RLS as the anon and
 * authenticated roles. Runs in plain `npm test`; no hosted database.
 *
 * Every check runs twice: with the older Supabase default grants (the most
 * permissive case, as on the hosted project) and with no default grants (a
 * new project), where only explicit grants work.
 */
const MODES: DefaultGrants[] = ["legacy", "none"];

/** Every table in schema public. A new table fails the gate until it is listed here. */
const OWNED_TABLES = [
  "action_log",
  "action_proposals",
  "connector_grants",
  "context_records",
  "conversations",
  "document_chunks",
  "documents",
  "memories",
  "message_results",
  "messages",
  "reminders",
  "spend_reservations",
  "tasks",
  "usage_windows",
] as const;
const SERVER_ONLY_TABLES = ["spend_counters"] as const;
const ALL_TABLES = [...OWNED_TABLES, ...SERVER_ONLY_TABLES].sort();
const PROTECTED_COLUMNS = ["id", "user_id", "created_at"];
const PERMISSION_DENIED = "42501";

type OwnedTable = (typeof OWNED_TABLES)[number];

const EMBEDDING = `[${[1, ...Array<number>(1023).fill(0)].join(",")}]`;

/** The columns the app may read on connector_grants: every column except the two ciphertexts. */
const GRANT_COLUMNS =
  "id, user_id, provider, account_sub, account_email, scopes, access_token_expires_at, key_version, status, last_used_at, created_at, updated_at";
/** A grant row as the connector code writes it, with a stand-in ciphertext of 40 bytes. */
const GRANT_INSERT = `insert into connector_grants (user_id, provider, account_sub, account_email, scopes, refresh_token_ciphertext, key_version)
  values ($1, 'google', 'gate', 'gate@example.com', array['openid'], decode(repeat('ab', 40), 'hex'), 1)`;

interface Owned {
  conversationId: string;
  messageId: string;
  documentId: string;
  proposalId: string;
  memoryId: string;
  chunkId: string;
  grantId: string;
}

/** Seeds one row in every owned table for `userId`, as the migration owner. */
async function seedOwner(gate: SqlGate, userId: string): Promise<Owned> {
  const one = async (sql: string, params: unknown[]) => (await gate.admin<{ id: string }>(sql, params)).rows[0]!.id;
  const conversationId = await one(
    "insert into conversations (user_id, title) values ($1, 'gate') returning id",
    [userId],
  );
  const messageId = await one(
    "insert into messages (conversation_id, user_id, role, content) values ($1, $2, 'assistant', 'gate') returning id",
    [conversationId, userId],
  );
  const documentId = await one(
    `insert into documents (user_id, mode, title, media_type, char_count, status)
     values ($1, 'personal', 'gate', 'text/plain', 4, 'ready') returning id`,
    [userId],
  );
  const chunkId = await one(
    `insert into document_chunks (user_id, document_id, chunk_index, content, embedding)
     values ($1, $2, 0, 'gate', $3) returning id`,
    [userId, documentId, EMBEDDING],
  );
  const memoryId = await one(
    `insert into memories (user_id, mode, content, source, embedding)
     values ($1, 'personal', 'gate', 'user', $2) returning id`,
    [userId, EMBEDDING],
  );
  const proposalId = await one(
    `insert into action_proposals (user_id, conversation_id, kind, payload, summary)
     values ($1, $2, 'create_task', '{"kind":"create_task","mode":"personal","title":"gate"}', 'gate') returning id`,
    [userId, conversationId],
  );
  await gate.admin("insert into action_log (user_id, proposal_id, event) values ($1, $2, 'proposed')", [
    userId,
    proposalId,
  ]);
  await gate.admin(
    "insert into reminders (user_id, mode, title, due_at, proposal_id) values ($1, 'personal', 'gate', now(), $2)",
    [userId, proposalId],
  );
  await gate.admin(
    `insert into context_records (message_id, user_id, model, history_message_count, history_chars, prompt_version)
     values ($1, $2, 'gate', 0, 0, 'v1')`,
    [messageId, userId],
  );
  await gate.admin("insert into tasks (user_id, mode, title) values ($1, 'personal', 'gate')", [userId]);
  await gate.admin("insert into usage_windows (user_id, window_start, request_count) values ($1, now(), 1)", [userId]);
  await gate.admin(
    `insert into spend_reservations (user_id, provider, usage_day, period_kind, period_start, held, charged)
     values ($1, 'tavily', current_date, 'month', current_date, 1, 1)`,
    [userId],
  );
  await gate.admin(
    `insert into message_results (message_id, user_id, kinds, payload)
     values ($1, $2, '{flights}', '{"results":[],"steps":[]}')`,
    [messageId, userId],
  );
  const grantId = await one(`${GRANT_INSERT} returning id`, [userId]);
  return { conversationId, messageId, documentId, proposalId, memoryId, chunkId, grantId };
}

/** An insert of a row owned by `owner`, for each owned table. References point at the owner's rows. */
function insertFor(table: OwnedTable, owner: string, refs: Owned): [string, unknown[]] {
  switch (table) {
    case "conversations":
      return ["insert into conversations (user_id, title) values ($1, 'x')", [owner]];
    case "messages":
      return [
        "insert into messages (conversation_id, user_id, role, content) values ($2, $1, 'user', 'x')",
        [owner, refs.conversationId],
      ];
    case "usage_windows":
      return ["insert into usage_windows (user_id, window_start) values ($1, now() - interval '1 day')", [owner]];
    case "tasks":
      return ["insert into tasks (user_id, mode, title) values ($1, 'personal', 'x')", [owner]];
    case "spend_reservations":
      return [
        `insert into spend_reservations (user_id, provider, usage_day, period_kind, period_start, held, charged)
         values ($1, 'tavily', current_date, 'month', current_date, 1, 1)`,
        [owner],
      ];
    case "memories":
      return ["insert into memories (user_id, mode, content, source) values ($1, 'personal', 'x', 'user')", [owner]];
    case "documents":
      return [
        "insert into documents (user_id, mode, title, media_type, char_count) values ($1, 'personal', 'x', 'text/plain', 1)",
        [owner],
      ];
    case "document_chunks":
      return [
        "insert into document_chunks (user_id, document_id, chunk_index, content) values ($1, $2, 1, 'x')",
        [owner, refs.documentId],
      ];
    case "action_proposals":
      return [
        `insert into action_proposals (user_id, kind, payload, summary)
         values ($1, 'create_task', '{"kind":"create_task","mode":"personal","title":"x"}', 'x')`,
        [owner],
      ];
    case "action_log":
      return ["insert into action_log (user_id, event) values ($1, 'proposed')", [owner]];
    case "reminders":
      return ["insert into reminders (user_id, mode, title, due_at) values ($1, 'personal', 'x', now())", [owner]];
    case "context_records":
      return [
        `insert into context_records (message_id, user_id, model, history_message_count, history_chars, prompt_version)
         values ($2, $1, 'x', 0, 0, 'v1')`,
        [owner, refs.messageId],
      ];
    case "message_results":
      return [
        `insert into message_results (message_id, user_id, kinds, payload)
         values ($2, $1, '{}', '{"results":[],"steps":[]}')`,
        [owner, refs.messageId],
      ];
    case "connector_grants":
      return [GRANT_INSERT, [owner]];
  }
}

let gate: SqlGate;
let userA: string;
let userB: string;
let rowsA: Owned;
let rowsB: Owned;

async function countOwnedBy(table: string, userId: string): Promise<number> {
  const result = await gate.admin<{ n: number }>(`select count(*)::int as n from ${table} where user_id = $1`, [userId]);
  return result.rows[0]!.n;
}

async function updatableColumns(table: string): Promise<string[]> {
  const result = await gate.admin<{ column_name: string }>(
    `select column_name from information_schema.column_privileges
      where table_schema = 'public' and table_name = $1 and grantee = 'authenticated' and privilege_type = 'UPDATE'
      order by column_name`,
    [table],
  );
  return result.rows.map((row) => row.column_name);
}

describe.each(MODES)("database gate with %s default grants", (defaults) => {
  beforeAll(async () => {
    gate = await startSqlGate({ defaults });
    userA = await gate.createUser();
    userB = await gate.createUser();
    rowsA = await seedOwner(gate, userA);
    rowsB = await seedOwner(gate, userB);
  });

  afterAll(async () => {
    await gate?.close();
  });

  describe("Supabase stand-in", () => {
    it("gives a new public table the default grants of this mode, so the checks below are not vacuous", async () => {
      const all = ["DELETE", "INSERT", "REFERENCES", "SELECT", "TRIGGER", "TRUNCATE", "UPDATE"];
      expect(await defaultGrantsOnNewTable(gate)).toEqual(
        defaults === "legacy" ? { anon: all, authenticated: all, service_role: all } : {},
      );
    });

    it("applies every migration and finds exactly the classified tables", async () => {
      const result = await gate.admin<{ tablename: string }>(
        "select tablename from pg_tables where schemaname = 'public' order by tablename",
      );
      expect(result.rows.map((row) => row.tablename)).toEqual(ALL_TABLES);
    });

    it("has row-level security on every public table and a user_id column on every owned table", async () => {
      const rls = await gate.admin<{ relname: string; relrowsecurity: boolean }>(
        `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r'`,
      );
      expect(rls.rows.filter((row) => !row.relrowsecurity).map((row) => row.relname)).toEqual([]);
      const withOwner = await gate.admin<{ table_name: string }>(
        `select table_name from information_schema.columns
          where table_schema = 'public' and column_name = 'user_id' order by table_name`,
      );
      expect(withOwner.rows.map((row) => row.table_name)).toEqual([...OWNED_TABLES].sort());
    });
  });

  describe("anon", () => {
    it.each(ALL_TABLES)("has no privilege on %s and cannot read it", async (table) => {
      const privileges = await gate.admin<{ granted: boolean }>(
        `select has_table_privilege('anon', $1, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
             or has_any_column_privilege('anon', $1, 'SELECT, INSERT, UPDATE') as granted`,
        [`public.${table}`],
      );
      expect(privileges.rows[0]!.granted).toBe(false);
      expect(await errorCode(() => gate.as(anon, `select * from ${table}`))).toBe(PERMISSION_DENIED);
      expect(await errorCode(() => gate.as(anon, `delete from ${table}`))).toBe(PERMISSION_DENIED);
    });

    it("cannot execute any function in schema public", async () => {
      const result = await gate.admin<{ proname: string }>(
        `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE')`,
      );
      expect(result.rows.map((row) => row.proname)).toEqual([]);
      expect(
        await errorCode(() => gate.as(anon, "select * from match_memories($1, 'personal', 5)", [EMBEDDING])),
      ).toBe(PERMISSION_DENIED);
    });
  });

  describe("one signed-in user against another user's rows", () => {
    it.each(OWNED_TABLES)("user A cannot read user B's rows in %s", async (table) => {
      const code = await errorCode(async () => {
        const result = await gate.as(user(userA), `select * from ${table} where user_id = $1`, [userB]);
        expect(result.rows).toEqual([]);
      });
      expect([null, PERMISSION_DENIED]).toContain(code);
    });

    it.each(OWNED_TABLES)("user A cannot update user B's rows in %s", async (table) => {
      const [column] = await updatableColumns(table);
      if (!column) {
        expect(
          await errorCode(() => gate.as(user(userA), `update ${table} set user_id = user_id where user_id = $1`, [userB])),
        ).toBe(PERMISSION_DENIED);
        return;
      }
      const result = await gate.as(user(userA), `update ${table} set ${column} = ${column} where user_id = $1`, [userB]);
      expect(result.affectedRows).toBe(0);
    });

    it.each(OWNED_TABLES)("user A cannot delete user B's rows in %s", async (table) => {
      const before = await countOwnedBy(table, userB);
      const code = await errorCode(async () => {
        const result = await gate.as(user(userA), `delete from ${table} where user_id = $1`, [userB]);
        expect(result.affectedRows).toBe(0);
      });
      expect([null, PERMISSION_DENIED]).toContain(code);
      expect(await countOwnedBy(table, userB)).toBe(before);
    });

    it.each(OWNED_TABLES)("user A cannot insert a row owned by user B into %s", async (table) => {
      const [sql, params] = insertFor(table, userB, rowsB);
      expect(await errorCode(() => gate.as(user(userA), sql, params))).toBe(PERMISSION_DENIED);
    });

    it("user A reads none of user B's grant columns and none of B's token ciphertexts", async () => {
      // The granted columns only, as the connector repository reads them: RLS leaves no row.
      const columns = await gate.as(user(userA), `select ${GRANT_COLUMNS} from connector_grants where user_id = $1`, [userB]);
      expect(columns.rows).toEqual([]);
      const byId = await gate.as(user(userA), `select ${GRANT_COLUMNS} from connector_grants where id = $1`, [rowsB.grantId]);
      expect(byId.rows).toEqual([]);
      // The only way to read a ciphertext answers nothing for another user's grant.
      const secrets = await gate.as(user(userA), "select * from public.connector_grant_secrets($1)", [rowsB.grantId]);
      expect(secrets.rows).toEqual([]);
      // A token write to another user's grant changes nothing.
      const stored = await gate.as<{ ok: boolean }>(
        user(userA),
        "select public.store_connector_tokens($1, decode(repeat('cd', 40), 'hex'), null, now(), 1::smallint) as ok",
        [rowsB.grantId],
      );
      expect(stored.rows[0]!.ok).toBe(false);
      const untouched = await gate.admin<{ same: boolean }>(
        "select refresh_token_ciphertext = decode(repeat('ab', 40), 'hex') as same from connector_grants where id = $1",
        [rowsB.grantId],
      );
      expect(untouched.rows).toEqual([{ same: true }]);
    });

    it("a signed-in user cannot select a token ciphertext column, even on an own grant", async () => {
      for (const column of ["refresh_token_ciphertext", "access_token_ciphertext"]) {
        expect(
          await errorCode(() => gate.as(user(userA), `select ${column} from connector_grants where id = $1`, [rowsA.grantId])),
          column,
        ).toBe(PERMISSION_DENIED);
      }
      expect(await errorCode(() => gate.as(user(userA), "select * from connector_grants"))).toBe(PERMISSION_DENIED);
    });

    it("anon cannot execute the connector token functions", async () => {
      expect(await errorCode(() => gate.as(anon, "select * from public.connector_grant_secrets($1)", [rowsA.grantId]))).toBe(
        PERMISSION_DENIED,
      );
      expect(
        await errorCode(() =>
          gate.as(anon, "select public.store_connector_tokens($1, null, decode(repeat('cd', 40), 'hex'), now(), 1::smallint)", [
            rowsA.grantId,
          ]),
        ),
      ).toBe(PERMISSION_DENIED);
    });

    it("user A cannot attach results to user B's reply, also under A's own user ID", async () => {
      // A reply of B's that has no results yet, so only the ownership rules can refuse the insert.
      const reply = await gate.admin<{ id: string }>(
        "insert into messages (conversation_id, user_id, role, content) values ($1, $2, 'assistant', 'b') returning id",
        [rowsB.conversationId, userB],
      );
      const code = await errorCode(() =>
        gate.as(
          user(userA),
          `insert into message_results (message_id, user_id, kinds, payload) values ($1, $2, '{}', '{"results":[],"steps":[]}')`,
          [reply.rows[0]!.id, userA],
        ),
      );
      // The composite foreign key to messages (id, user_id) refuses it.
      expect(["23503", PERMISSION_DENIED]).toContain(code);
      expect(await countOwnedBy("message_results", userA)).toBe(1);
    });

    it("cannot read or write the server-only spend counters", async () => {
      expect(await errorCode(() => gate.as(user(userA), "select * from spend_counters"))).toBe(PERMISSION_DENIED);
      expect(
        await errorCode(() =>
          gate.as(user(userA), "insert into spend_counters (provider, period_kind, period_start) values ('tavily', 'day', current_date)"),
        ),
      ).toBe(PERMISSION_DENIED);
    });
  });

  describe("protected columns", () => {
    it.each(ALL_TABLES)("authenticated has no table-wide UPDATE and cannot update id, user_id or created_at on %s", async (table) => {
      const tableWide = await gate.admin<{ granted: boolean }>(
        "select has_table_privilege('authenticated', $1, 'UPDATE') as granted",
        [`public.${table}`],
      );
      expect(tableWide.rows[0]!.granted).toBe(false);
      const updatable = await updatableColumns(table);
      expect(updatable.filter((column) => PROTECTED_COLUMNS.includes(column))).toEqual([]);
    });

    it.each(OWNED_TABLES)("user A cannot move an own row in %s to user B", async (table) => {
      expect(
        await errorCode(() => gate.as(user(userA), `update ${table} set user_id = $1 where user_id = $2`, [userB, userA])),
      ).toBe(PERMISSION_DENIED);
    });
  });

  describe("similarity search", () => {
    it.each([
      ["match_memories", "memoryId"],
      ["match_document_chunks", "chunkId"],
    ] as const)("%s returns only the caller's rows", async (fn, key) => {
      for (const [caller, own] of [
        [userA, rowsA],
        [userB, rowsB],
      ] as const) {
        const result = await gate.as<{ id: string }>(user(caller), `select id from ${fn}($1, 'personal', 20)`, [
          EMBEDDING,
        ]);
        expect(result.rows.map((row) => row.id)).toEqual([own[key]]);
      }
    });

    it("match_memories with a null mode returns the caller's active memories of both modes and nothing of another user", async () => {
      const owner = await gate.createUser();
      const memory = async (mode: string, status: string) =>
        (
          await gate.admin<{ id: string }>(
            `insert into memories (user_id, mode, content, source, status, embedding)
             values ($1, $2, 'one workspace', 'user', $3, $4) returning id`,
            [owner, mode, status, EMBEDDING],
          )
        ).rows[0]!.id;
      const personal = await memory("personal", "active");
      const work = await memory("work", "active");
      await memory("work", "proposed");

      const own = await gate.as<{ id: string }>(user(owner), "select id from match_memories($1, null, 20)", [EMBEDDING]);
      expect(own.rows.map((row) => row.id).sort()).toEqual([personal, work].sort());
      const other = await gate.as<{ id: string }>(user(userA), "select id from match_memories($1, null, 20)", [EMBEDDING]);
      expect(other.rows.map((row) => row.id)).toEqual([rowsA.memoryId]);
    });
  });

  describe("app parsers read every row the database accepts", () => {
    it("lists flat action log rows, with and without a proposal, exactly as stored", async () => {
      const owner = await gate.createUser();
      const proposal = await gate.admin<{ id: string }>(
        `insert into action_proposals (user_id, kind, payload, summary)
         values ($1, 'create_task', '{"kind":"create_task","mode":"personal","title":"x"}', 'x') returning id`,
        [owner],
      );
      const proposalId = proposal.rows[0]!.id;
      await gate.admin(
        `insert into action_log (user_id, proposal_id, event, detail) values
          ($1, $2, 'proposed', '{"kind":"create_task","count":2,"edited":true,"taskId":null}'),
          ($1, null, 'memory_added', '{}')`,
        [owner, proposalId],
      );
      const entries = await createActionLogRepository(sqlGateClient(gate, owner)).list(owner, 50);
      // The insert trigger on action_proposals adds the third row.
      expect(entries).toHaveLength(3);
      expect(entries.filter((entry) => entry.event === "proposed" && entry.proposalId === proposalId)).toHaveLength(2);
      expect(entries.filter((entry) => entry.proposalId === null)).toHaveLength(1);
      expect(entries.every((entry) => typeof entry.createdAt === "string")).toBe(true);
    });

    it("lists proposals in every stored state, including NULL conversation, result and decided_at", async () => {
      const owner = await gate.createUser();
      const conversation = await gate.admin<{ id: string }>(
        "insert into conversations (user_id, title) values ($1, 'x') returning id",
        [owner],
      );
      await gate.admin(
        `insert into action_proposals (user_id, conversation_id, kind, payload, summary, status, result, decided_at) values
          ($1, null, 'create_task', '{"kind":"create_task","mode":"work","title":"Call Sam"}', 'Add a task', 'proposed', null, null),
          ($1, $2, 'create_reminder', '{"kind":"create_reminder","mode":"personal","title":"Dentist","dueAt":"2026-10-30T17:00:00Z"}',
            'Remind me', 'executed', '{"reminderId":"r1"}', now()),
          ($1, $2, 'save_memory', '{"kind":"save_memory","mode":"personal","content":"Likes tea"}',
            'Remember this', 'failed', '{"error":"execution_failed","code":"23514"}', now()),
          ($1, $2, 'create_task', '{"kind":"create_task","mode":"personal","title":"Old"}', 'Old', 'rejected', null, now())`,
        [owner, conversation.rows[0]!.id],
      );
      const proposals = await createActionProposalRepository(sqlGateClient(gate, owner)).listProposals(
        owner,
        undefined,
        50,
      );
      expect(proposals.map((proposal) => proposal.status).sort()).toEqual(["executed", "failed", "proposed", "rejected"]);
      const pending = proposals.find((proposal) => proposal.status === "proposed")!;
      expect(pending.conversationId).toBeNull();
      expect(pending.result).toBeNull();
      expect(pending.decidedAt).toBeNull();
    });

    it("does not accept an action log detail that the log reader refuses", async () => {
      const owner = await gate.createUser();
      const code = await errorCode(() =>
        gate.admin(`insert into action_log (user_id, event, detail) values ($1, 'executed', '{"taskId":{"nested":"bad"}}')`, [
          owner,
        ]),
      );
      if (code !== null) return;
      await expect(createActionLogRepository(sqlGateClient(gate, owner)).list(owner, 50)).resolves.toHaveLength(
        await countOwnedBy("action_log", owner),
      );
    });
  });

  describe("records the app must be able to trust", () => {
    it("authenticated cannot update action_proposals, so an approved action cannot be reset and run again", async () => {
      const approved = await gate.admin<{ id: string }>(
        `insert into action_proposals (user_id, kind, payload, summary, status, decided_at)
         values ($1, 'create_task', '{"kind":"create_task","mode":"personal","title":"x"}', 'x', 'approved', now())
         returning id`,
        [userA],
      );
      const id = approved.rows[0]!.id;
      await errorCode(() =>
        gate.as(user(userA), "update action_proposals set status = 'proposed', decided_at = null where id = $1", [id]),
      );
      const stored = await gate.admin<{ status: string }>("select status from action_proposals where id = $1", [id]);
      expect(stored.rows[0]!.status).toBe("approved");
    });
  });

  describe("the app's own reads and writes work with only the explicit grants", () => {
    it("covers every table and function the app uses", async () => {
      const owner = await gate.createUser();
      const as = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => gate.as<T>(user(owner), sql, params);
      const id = async (sql: string, params: unknown[]) => (await as<{ id: string }>(sql, params)).rows[0]!.id;

      const conversation = await id("insert into conversations (user_id, title) values ($1, 'Plan') returning id", [owner]);
      await as("update conversations set title = 'Plan v2' where id = $1", [conversation]);
      const message = await id(
        "insert into messages (conversation_id, user_id, role, content) values ($1, $2, 'assistant', 'Hi') returning id",
        [conversation, owner],
      );
      await as(
        `insert into context_records (message_id, user_id, model, history_message_count, history_chars, prompt_version)
         values ($1, $2, 'm', 1, 2, 'v1')`,
        [message, owner],
      );
      const task = await id("insert into tasks (user_id, mode, title) values ($1, 'personal', 'x') returning id", [owner]);
      await as("update tasks set title = 'y', done = true where id = $1", [task]);
      const memory = await id(
        "insert into memories (user_id, mode, content, source, embedding) values ($1, 'personal', 'tea', 'user', $2) returning id",
        [owner, EMBEDDING],
      );
      await as("update memories set content = 'coffee', mode = 'work', status = 'active', embedding = $2, embedding_model = 'm' where id = $1", [
        memory,
        EMBEDDING,
      ]);
      const document = await id(
        "insert into documents (user_id, mode, title, media_type, char_count) values ($1, 'work', 'd', 'text/plain', 1) returning id",
        [owner],
      );
      await as("insert into document_chunks (user_id, document_id, chunk_index, content, embedding) values ($1, $2, 0, 'c', $3)", [
        owner,
        document,
        EMBEDDING,
      ]);
      await as("update documents set status = 'ready' where id = $1", [document]);
      const reminder = await id(
        "insert into reminders (user_id, mode, title, due_at) values ($1, 'personal', 'r', now()) returning id",
        [owner],
      );
      await as("update reminders set title = 'r2', due_at = now(), status = 'done', mode = 'work' where id = $1", [reminder]);
      const proposal = await propose(gate, owner, TASK);
      // Workflow results for a reply (decision 0015): one insert after the reply, read back with the conversation.
      await as(
        `insert into message_results (message_id, user_id, kinds, payload)
         values ($1, $2, '{flights,calendar}', '{"results":[],"steps":[{"id":"flights.search","label":"Searched","status":"done"}]}')`,
        [message, owner],
      );
      const read = await as("select message_id, payload from message_results where user_id = $1 and message_id in ($2)", [owner, message]);
      expect(read.rows).toHaveLength(1);
      // Google grant (decision 0016): insert, the granted column updates, both token functions, then delete.
      const grant = await id(`${GRANT_INSERT} returning id`, [owner]);
      await as(
        "update connector_grants set status = 'needs_reconnect', scopes = array['openid', 'email'], last_used_at = now(), account_email = 'new@example.com' where id = $1",
        [grant],
      );
      await as("update connector_grants set status = 'active', access_token_expires_at = now() where id = $1", [grant]);
      const listed = await as(`select ${GRANT_COLUMNS} from connector_grants where user_id = $1 and provider = 'google'`, [owner]);
      expect(listed.rows).toHaveLength(1);
      const stored = await as<{ ok: boolean }>(
        "select public.store_connector_tokens($1, decode(repeat('cd', 40), 'hex'), null, now(), 1::smallint) as ok",
        [grant],
      );
      expect(stored.rows[0]!.ok).toBe(true);
      const kept = await as<{ ok: boolean }>(
        "select public.store_connector_tokens($1, null, decode(repeat('ef', 40), 'hex'), now() + interval '1 hour', 1::smallint) as ok",
        [grant],
      );
      expect(kept.rows[0]!.ok).toBe(true);
      const secrets = await as<{ id: string; key_version: number; refresh_token_ciphertext: unknown; access_token_ciphertext: unknown }>(
        "select * from public.connector_grant_secrets($1)",
        [grant],
      );
      expect(secrets.rows).toHaveLength(1);
      expect(secrets.rows[0]).toMatchObject({ id: grant, key_version: 1 });
      expect(secrets.rows[0]!.refresh_token_ciphertext).not.toBeNull();
      expect(secrets.rows[0]!.access_token_ciphertext).not.toBeNull();

      for (const table of ["conversations", "messages", "context_records", "tasks", "memories", "documents", "document_chunks", "reminders", "action_proposals", "action_log", "message_results", "connector_grants"]) {
        const rows = await as<{ n: number }>(`select count(*)::int as n from ${table}`);
        expect(rows.rows[0]!.n, table).toBeGreaterThan(0);
      }
      expect((await as("select * from match_memories($1, 'work', 5)", [EMBEDDING])).rows).toHaveLength(1);
      expect((await as("select * from match_document_chunks($1, 'work', 5)", [EMBEDDING])).rows).toHaveLength(1);
      expect((await as<{ allowed: boolean }>("select * from consume_chat_quota(30, 3600)")).rows[0]!.allowed).toBe(true);
      const hold = await as<{ allowed: boolean; reservation_id: string }>(
        "select * from reserve_provider_spend('nebius', 10, 1000000, 1000000, 500000)",
      );
      expect(hold.rows[0]!.allowed).toBe(true);
      expect((await as<{ ok: boolean }>("select settle_provider_spend($1, 5) as ok", [hold.rows[0]!.reservation_id])).rows[0]!.ok).toBe(true);
      expect((await decideAs(gate, owner, proposal, "approve")).outcome).toBe("executed");

      await as("delete from tasks where id = $1", [task]);
      await as("delete from memories where id = $1", [memory]);
      await as("delete from reminders where id = $1", [reminder]);
      await as("delete from documents where id = $1", [document]);
      const removed = await as("delete from connector_grants where id = $1", [grant]);
      expect(removed.affectedRows).toBe(1);
      await as("delete from conversations where id = $1", [conversation]);
      expect(await countOwnedBy("conversations", owner)).toBe(0);
      expect(await countOwnedBy("document_chunks", owner)).toBe(0);
      // Results go with their reply.
      expect(await countOwnedBy("message_results", owner)).toBe(0);
      expect(await countOwnedBy("connector_grants", owner)).toBe(0);
    });
  });

  describe("no API role can empty, reference or add a trigger to a table", () => {
    it.each(ALL_TABLES)("anon and authenticated have no TRUNCATE, REFERENCES or TRIGGER on %s", async (table) => {
      const result = await gate.admin<{ granted: boolean }>(
        `select has_table_privilege('anon', $1, 'TRUNCATE, REFERENCES, TRIGGER')
             or has_table_privilege('authenticated', $1, 'TRUNCATE, REFERENCES, TRIGGER') as granted`,
        [`public.${table}`],
      );
      expect(result.rows[0]!.granted).toBe(false);
    });

    it("user A cannot truncate the action log, and user B's rows stay", async () => {
      const before = await countOwnedBy("action_log", userB);
      expect(await errorCode(() => gate.as(user(userA), "truncate action_log"))).toBe(PERMISSION_DENIED);
      expect(await countOwnedBy("action_log", userB)).toBe(before);
    });
  });

  describe("decide_action_proposal", () => {
    it("approves each kind once, as the caller, and stores only the new row's ID", async () => {
      const owner = await gate.createUser();
      for (const [payload, table, key] of [
        [TASK, "tasks", "taskId"],
        [REMINDER, "reminders", "reminderId"],
        [MEMORY, "memories", "memoryId"],
      ] as const) {
        const id = await propose(gate, owner, payload);
        const answer = await decideAs(gate, owner, id, "approve");
        expect(answer.outcome).toBe("executed");
        expect(answer.proposal).toMatchObject({ id, status: "executed" });
        expect(Object.keys(answer.proposal!.result!)).toEqual([key]);
        const created = await gate.admin<{ user_id: string }>(`select user_id from ${table} where id = $1`, [answer.proposal!.result![key]]);
        expect(created.rows).toEqual([{ user_id: owner }]);
        // A reminder keeps its proposal ID, so its own log row has the proposal ID too.
        expect(await proposalEvents(gate, id)).toEqual(
          payload === REMINDER ? ["proposed", "approved", "reminder_added", "executed"] : ["proposed", "approved", "executed"],
        );
      }
      const memory = await gate.admin("select status, source, embedding from memories where user_id = $1", [owner]);
      expect(memory.rows).toEqual([{ status: "active", source: "assistant", embedding: null }]);
      const reminder = await gate.admin<{ proposal_id: string }>("select proposal_id from reminders where user_id = $1", [owner]);
      expect(reminder.rows[0]!.proposal_id).not.toBeNull();
    });

    it("rejects without running anything", async () => {
      const owner = await gate.createUser();
      const id = await propose(gate, owner, TASK);
      const answer = await decideAs(gate, owner, id, "reject");
      expect(answer).toMatchObject({ outcome: "rejected", proposal: { status: "rejected", result: null } });
      expect(await countOwnedBy("tasks", owner)).toBe(0);
      expect(await proposalEvents(gate, id)).toEqual(["proposed", "rejected"]);
    });

    it("runs once: a second decision gets already_decided with the stored outcome, which recovers a lost response", async () => {
      const owner = await gate.createUser();
      const id = await propose(gate, owner, TASK);
      const first = await decideAs(gate, owner, id, "approve");
      const again = await decideAs(gate, owner, id, "approve");
      expect(again.outcome).toBe("already_decided");
      expect(again.proposal).toMatchObject({ status: "executed", result: first.proposal!.result });
      expect((await decideAs(gate, owner, id, "reject")).outcome).toBe("already_decided");
      expect(await countOwnedBy("tasks", owner)).toBe(1);
      const listed = await createActionProposalRepository(sqlGateClient(gate, owner)).listProposals(owner, undefined, 10);
      expect(listed[0]).toMatchObject({ id, status: "executed", result: first.proposal!.result });
    });

    it("stores an edited payload of the same kind, trimmed, and runs it", async () => {
      const owner = await gate.createUser();
      const id = await propose(gate, owner, TASK);
      const answer = await decideAs(gate, owner, id, "approve", { ...TASK, mode: "work", title: "  Pay it today  " });
      expect(answer.outcome).toBe("executed");
      expect(answer.proposal!.payload).toEqual({ ...TASK, mode: "work", title: "Pay it today" });
      const task = await gate.admin("select mode, title from tasks where user_id = $1", [owner]);
      expect(task.rows).toEqual([{ mode: "work", title: "Pay it today" }]);
    });

    it.each([
      ["a kind change", { ...MEMORY }, "kind_mismatch"],
      ["a title that is too long", { ...TASK, title: "x".repeat(201) }, "invalid"],
      ["an extra key", { ...TASK, note: "x" }, "invalid"],
      ["an unknown mode", { ...TASK, mode: "home" }, "invalid"],
    ])("refuses %s and changes nothing", async (_label, payload, outcome) => {
      const owner = await gate.createUser();
      const id = await propose(gate, owner, TASK);
      const answer = await decideAs(gate, owner, id, "approve", payload);
      expect(answer).toMatchObject({ outcome, proposal: { status: "proposed" } });
      expect(await countOwnedBy("tasks", owner)).toBe(0);
      expect(await proposalEvents(gate, id)).toEqual(["proposed"]);
    });

    it("refuses an invalid due time and an unknown decision", async () => {
      const owner = await gate.createUser();
      const id = await propose(gate, owner, REMINDER);
      for (const dueAt of ["2026-02-30T17:00:00Z", "2026-10-30T17:00Z", "tomorrow"]) {
        expect((await decideAs(gate, owner, id, "approve", { ...REMINDER, dueAt })).outcome).toBe("invalid");
      }
      expect((await decideAs(gate, owner, id, "maybe")).outcome).toBe("invalid");
      expect((await decideAs(gate, owner, id, "reject", REMINDER)).outcome).toBe("invalid");
      expect(await countOwnedBy("reminders", owner)).toBe(0);
    });

    it("records failed with a short code when the insert fails, keeps nothing, and cannot run again", async () => {
      const owner = await gate.createUser();
      const id = await propose(gate, owner, { ...TASK, title: "gate-fail" });
      await gate.admin("alter table public.tasks add constraint gate_fail check (title <> 'gate-fail')");
      try {
        const answer = await decideAs(gate, owner, id, "approve");
        expect(answer).toMatchObject({
          outcome: "failed",
          proposal: { status: "failed", result: { error: "execution_failed", code: "23514" } },
        });
      } finally {
        await gate.admin("alter table public.tasks drop constraint gate_fail");
      }
      expect(await countOwnedBy("tasks", owner)).toBe(0);
      expect(await proposalEvents(gate, id)).toEqual(["proposed", "approved", "failed"]);
      expect((await decideAs(gate, owner, id, "approve")).outcome).toBe("already_decided");
    });

    it("gives another user's proposal the same answer as a missing one, and leaves it alone", async () => {
      const owner = await gate.createUser();
      const other = await gate.createUser();
      const id = await propose(gate, other, TASK);
      const foreign = await decideAs(gate, owner, id, "approve");
      const missing = await decideAs(gate, owner, "00000000-0000-4000-8000-000000000000", "approve");
      expect(foreign).toEqual({ outcome: "not_found", proposal: null });
      expect(missing).toEqual(foreign);
      expect(await decideAs(gate, owner, id, "reject")).toEqual(foreign);
      const stored = await gate.admin("select status from action_proposals where id = $1", [id]);
      expect(stored.rows).toEqual([{ status: "proposed" }]);
    });

    it("refuses a caller with no session, and anon cannot call it", async () => {
      const owner = await gate.createUser();
      const id = await propose(gate, owner, TASK);
      expect(await errorCode(() => gate.as(anon, "select public.decide_action_proposal($1, 'approve', null)", [id]))).toBe(
        PERMISSION_DENIED,
      );
      expect(
        await errorCode(() =>
          gate.transactionAs(user(owner), async (tx) => {
            await tx.query("select set_config('request.jwt.claims', '{}', true)");
            return tx.query("select public.decide_action_proposal($1, 'approve', null)", [id]);
          }),
        ),
      ).toBe(PERMISSION_DENIED);
    });

    it("marks its own decisions as verified, in the row and in the log", async () => {
      const owner = await gate.createUser();
      const approved = await propose(gate, owner, TASK);
      const rejected = await propose(gate, owner, TASK);
      expect((await decideAs(gate, owner, approved, "approve")).proposal!.decided_by_function).toBe(true);
      expect((await decideAs(gate, owner, rejected, "reject")).proposal!.decided_by_function).toBe(true);
      const log = await gate.admin<{ event: string; verified: boolean | null }>(
        `select event, verified from action_log
          where proposal_id in ($1, $2) order by created_at`,
        [approved, rejected],
      );
      expect(log.rows).toEqual([
        { event: "proposed", verified: true },
        { event: "proposed", verified: true },
        { event: "approved", verified: true },
        { event: "executed", verified: true },
        { event: "rejected", verified: true },
      ]);
    });

    it("marks a log row that a trigger wrote as verified, and one the owner role inserted directly as not verified", async () => {
      const owner = await gate.createUser();
      await gate.as(user(owner), "insert into memories (user_id, mode, content, source) values ($1, 'personal', 'x', 'user')", [owner]);
      await gate.admin(`insert into action_log (user_id, event, detail) values ($1, 'executed', '{"verified":true}')`, [owner]);
      const rows = await gate.admin("select event, verified, detail ? 'verified' as has_key from action_log where user_id = $1 order by created_at", [owner]);
      expect(rows.rows).toEqual([
        { event: "memory_added", verified: true, has_key: false },
        { event: "executed", verified: false, has_key: false },
      ]);
    });

    it("lets no caller set the marker: a user has no grant, and any other write sets it false", async () => {
      const owner = await gate.createUser();
      const id = await propose(gate, owner, TASK);
      expect(
        await errorCode(() => gate.as(user(owner), "update action_proposals set decided_by_function = true where id = $1", [id])),
      ).toBe(PERMISSION_DENIED);
      // Even the owner role, without the function, gets false.
      await gate.admin("update action_proposals set status = 'approved', decided_at = now(), decided_by_function = true where id = $1", [id]);
      const row = await gate.admin("select status, decided_by_function from action_proposals where id = $1", [id]);
      expect(row.rows).toEqual([{ status: "approved", decided_by_function: false }]);
    });

    it("writes log rows that hold no task, memory or summary text", async () => {
      const owner = await gate.createUser();
      for (const payload of [TASK, MEMORY]) await decideAs(gate, owner, await propose(gate, owner, payload), "approve");
      const text = await gate.admin<{ t: string }>("select string_agg(detail::text, ' ') as t from action_log where user_id = $1", [owner]);
      expect(text.rows[0]!.t).not.toMatch(/invoice|short replies|Do it/i);
    });
  });

  describe("after the contract step, only the database writes the log and decides a proposal", () => {
    it("authenticated cannot insert into action_log", async () => {
      expect(
        await errorCode(() =>
          gate.as(user(userA), "insert into action_log (user_id, event, detail) values ($1, 'executed', '{}')", [userA]),
        ),
      ).toBe(PERMISSION_DENIED);
      const policies = await gate.admin("select policyname from pg_policies where tablename = 'action_log' and cmd = 'INSERT'");
      expect(policies.rows).toEqual([]);
    });

    it("authenticated has no UPDATE privilege or update policy on action_proposals", async () => {
      expect(await updatableColumns("action_proposals")).toEqual([]);
      const granted = await gate.admin<{ granted: boolean }>(
        "select has_any_column_privilege('authenticated', 'public.action_proposals', 'UPDATE') as granted",
      );
      expect(granted.rows[0]!.granted).toBe(false);
      const policies = await gate.admin("select policyname from pg_policies where tablename = 'action_proposals' and cmd = 'UPDATE'");
      expect(policies.rows).toEqual([]);
    });

    it("refuses the old two-write decision, so only decide_action_proposal can run an action", async () => {
      const owner = await gate.createUser();
      const id = await propose(gate, owner, TASK);
      expect(
        await errorCode(() =>
          gate.as(user(owner), "update action_proposals set status = 'approved', decided_at = now() where id = $1", [id]),
        ),
      ).toBe(PERMISSION_DENIED);
      expect((await decideAs(gate, owner, id, "approve")).outcome).toBe("executed");
    });
  });

  describe("legacy proposals left approved (decision 0009)", () => {
    /** The owner statements, read from the file the decision links to, so the two cannot drift. */
    const statements = new Map(
      readFileSync(resolve(process.cwd(), "docs/decisions/0009-legacy-approved.sql"), "utf8")
        .split(/^-- name: /m)
        .slice(1)
        .map((block) => {
          const [header, ...body] = block.split("\n");
          return [header!.split(" ")[0]!, { header: header!, sql: body.join("\n").trim().replace(/;$/, "") }] as const;
        }),
    );
    const run = <T,>(name: string, params: unknown[]) => gate.admin<T>(statements.get(name)!.sql, params);

    async function legacyApproved(owner: string, title: string): Promise<string> {
      const row = await gate.admin<{ id: string }>(
        `insert into action_proposals (user_id, kind, payload, summary, status, decided_at)
         values ($1, 'create_task', jsonb_build_object('kind', 'create_task', 'mode', 'personal', 'title', $2::text), 'x', 'approved', now())
         returning id`,
        [owner, title],
      );
      return row.rows[0]!.id;
    }

    async function taskFor(owner: string, title: string): Promise<string> {
      const row = await gate.admin<{ id: string }>(
        "insert into tasks (user_id, mode, title) values ($1, 'personal', $2) returning id",
        [owner, title],
      );
      return row.rows[0]!.id;
    }

    const statusOf = async (id: string) =>
      (await gate.admin<{ status: string }>("select status from action_proposals where id = $1", [id])).rows[0]!.status;

    it("each statement says whether it is read-only, and only confirm_executed writes", () => {
      expect([...statements.keys()]).toEqual([
        "find_approved",
        "find_reminder",
        "list_tasks_near_decision",
        "list_memories_near_decision",
        "confirm_executed",
      ]);
      for (const [name, { header, sql }] of statements) {
        const readOnly = header.includes("(read-only)");
        expect(readOnly || header.includes("(writes"), name).toBe(true);
        expect(/^select\b/i.test(sql), name).toBe(readOnly);
        expect(sql, name).toContain("user_id = $1");
      }
    });

    it("the decision function answers already_decided, runs nothing and leaves the row approved", async () => {
      const owner = await gate.createUser();
      const id = await legacyApproved(owner, "Legacy task");
      const answer = await gate.as<{ answer: { outcome: string } }>(
        user(owner),
        "select public.decide_action_proposal($1, 'approve') as answer",
        [id],
      );
      expect(answer.rows[0]!.answer.outcome).toBe("already_decided");
      expect(await statusOf(id)).toBe("approved");
      expect(await countOwnedBy("tasks", owner)).toBe(0);
    });

    it("the read-only statements return only the chosen user's rows", async () => {
      const owner = await gate.createUser();
      const other = await gate.createUser();
      const mine = await legacyApproved(owner, "Mine");
      const theirs = await legacyApproved(other, "Theirs");
      await taskFor(owner, "Mine");
      await taskFor(other, "Theirs");

      const found = await run<{ id: string }>("find_approved", [owner]);
      expect(found.rows.map((r) => r.id)).toEqual([mine]);
      const tasks = await run<{ title: string }>("list_tasks_near_decision", [owner, mine]);
      expect(tasks.rows.map((r) => r.title)).toEqual(["Mine"]);
      expect((await run("list_tasks_near_decision", [owner, theirs])).rows).toEqual([]);
      expect((await run("list_memories_near_decision", [owner, mine])).rows).toEqual([]);
      expect((await run("find_reminder", [owner, theirs])).rows).toEqual([]);
    });

    it("an edited task still shows in the list, and the row is set executed only for the row the user confirms", async () => {
      const owner = await gate.createUser();
      const other = await gate.createUser();
      const id = await legacyApproved(owner, "Pay the invoice");
      const task = await taskFor(owner, "Pay the invoice");
      await gate.admin("update tasks set title = 'Paid, edited later' where id = $1", [task]);
      const othersTask = await taskFor(other, "Pay the invoice");

      const listed = await run<{ id: string }>("list_tasks_near_decision", [owner, id]);
      expect(listed.rows.map((r) => r.id)).toEqual([task]);

      // Another user's row, or another user's proposal, changes nothing.
      expect((await run("confirm_executed", [owner, id, othersTask])).rows).toEqual([]);
      expect((await run("confirm_executed", [other, id, task])).rows).toEqual([]);
      expect(await statusOf(id)).toBe("approved");

      expect((await run<{ id: string }>("confirm_executed", [owner, id, task])).rows.map((r) => r.id)).toEqual([id]);
      const proposals = await createActionProposalRepository(sqlGateClient(gate, owner)).listProposals(owner, undefined, 50);
      // A person confirmed it, not the decision function: it stays not verified, so the screens say "Marked done".
      expect(proposals.find((p) => p.id === id)).toMatchObject({ status: "executed", result: { taskId: task }, verified: false });
      const log = await gate.admin<{ event: string; verified: boolean }>(
        "select event, verified from action_log where user_id = $1 and proposal_id = $2 and event = 'executed'",
        [owner, id],
      );
      expect(log.rows).toEqual([{ event: "executed", verified: false }]);
      expect((await run("confirm_executed", [owner, id, task])).rows).toEqual([]);
    });

    it("refuses a row that another proposal already names as its result", async () => {
      const owner = await gate.createUser();
      const first = await legacyApproved(owner, "Call Sam");
      const second = await legacyApproved(owner, "Call Sam");
      const task = await taskFor(owner, "Call Sam");
      expect((await run<{ id: string }>("list_tasks_near_decision", [owner, second])).rows.map((r) => r.id)).toEqual([task]);

      expect((await run<{ id: string }>("confirm_executed", [owner, first, task])).rows.map((r) => r.id)).toEqual([first]);
      expect((await run("confirm_executed", [owner, second, task])).rows).toEqual([]);
      expect(await statusOf(second)).toBe("approved");
      const log = await gate.admin("select 1 from action_log where user_id = $1 and event = 'executed'", [owner]);
      expect(log.rows).toHaveLength(1);
    });

    it("refuses a reminder linked to another proposal, and accepts one linked to this proposal", async () => {
      const owner = await gate.createUser();
      const legacyReminder = async () =>
        (
          await gate.admin<{ id: string }>(
            `insert into action_proposals (user_id, kind, payload, summary, status, decided_at)
             values ($1, 'create_reminder', '{"kind":"create_reminder","mode":"work","title":"Dentist","dueAt":"2026-10-30T17:00:00Z"}', 'x', 'approved', now())
             returning id`,
            [owner],
          )
        ).rows[0]!.id;
      const id = await legacyReminder();
      const other = await legacyReminder();
      const reminderFor = async (proposalId: string) =>
        (
          await gate.admin<{ id: string }>(
            "insert into reminders (user_id, mode, title, due_at, proposal_id) values ($1, 'work', 'Dentist', now(), $2) returning id",
            [owner, proposalId],
          )
        ).rows[0]!.id;
      const linkedElsewhere = await reminderFor(other);
      const linkedHere = await reminderFor(id);

      expect((await run("confirm_executed", [owner, id, linkedElsewhere])).rows).toEqual([]);
      expect(await statusOf(id)).toBe("approved");
      expect((await run<{ id: string }>("find_reminder", [owner, id])).rows.map((r) => r.id)).toEqual([linkedHere]);
      expect((await run<{ id: string }>("confirm_executed", [owner, id, linkedHere])).rows.map((r) => r.id)).toEqual([id]);
    });

    it("a row with an unknown outcome stays approved and an approval cannot make a second task", async () => {
      const owner = await gate.createUser();
      const id = await legacyApproved(owner, "Call Sam");
      const task = await taskFor(owner, "Call Sam");
      await gate.admin("delete from tasks where id = $1", [task]);
      expect((await run("list_tasks_near_decision", [owner, id])).rows).toEqual([]);

      const answer = await gate.as<{ answer: { outcome: string } }>(
        user(owner),
        "select public.decide_action_proposal($1, 'approve') as answer",
        [id],
      );
      expect(answer.rows[0]!.answer.outcome).toBe("already_decided");
      expect(await statusOf(id)).toBe("approved");
      expect(await countOwnedBy("tasks", owner)).toBe(0);
    });
  });
});

describe("upgrade of a database that has rows the older schema allowed", () => {
  const OWNER = "11111111-1111-4111-8111-111111111111";
  const CONVERSATION = "11111111-1111-4111-8111-000000000001";
  const BAD_KIND = "11111111-1111-4111-8111-000000000002";
  const BAD_KIND_LINKED = "11111111-1111-4111-8111-000000000003";
  const RESET = "11111111-1111-4111-8111-000000000004";
  const NESTED_LOG = "11111111-1111-4111-8111-000000000005";
  let old: SqlGate;

  beforeAll(async () => {
    old = await startSqlGate({
      defaults: "legacy",
      beforeMigration: {
        file: "20261021000000_memory_hardening.sql",
        sql: `
          insert into auth.users (id) values ('${OWNER}');
          insert into conversations (id, user_id, title) values ('${CONVERSATION}', '${OWNER}', 'old');
          insert into action_proposals (id, user_id, conversation_id, kind, payload, summary) values
            ('${BAD_KIND}', '${OWNER}', null, 'create_task', '{"kind":"save_memory","mode":"personal","content":"x"}', 'bad'),
            ('${BAD_KIND_LINKED}', '${OWNER}', '${CONVERSATION}', 'create_task', '{"kind":"save_memory"}', 'bad'),
            ('${RESET}', '${OWNER}', null, 'create_task', '{"kind":"create_task","mode":"personal","title":"Reset"}', 'reset');
          update action_proposals set decided_at = now() where id = '${RESET}';
          insert into action_log (id, user_id, event, detail) values
            ('${NESTED_LOG}', '${OWNER}', 'executed', '{"taskId":{"nested":"bad"}}'),
            (gen_random_uuid(), '${OWNER}', 'memory_added', '{"memoryId":"m","note":"${"x".repeat(100)}"}');
        `,
      },
    });
  });

  afterAll(async () => {
    await old?.close();
  });

  const decideOld = async (id: string, decision: string) =>
    (await old.as<{ r: Decision }>(user(OWNER), "select public.decide_action_proposal($1, $2, null) as r", [id, decision]))
      .rows[0]!.r;

  it("does not run a proposal whose payload names another kind, and lets the user reject it", async () => {
    expect((await decideOld(BAD_KIND, "approve")).outcome).toBe("invalid");
    expect(await decideOld(BAD_KIND, "reject")).toMatchObject({ outcome: "rejected", proposal: { status: "rejected" } });
  });

  it("still deletes a conversation linked to such a proposal", async () => {
    await old.as(user(OWNER), "delete from conversations where id = $1", [CONVERSATION]);
    const row = await old.admin("select conversation_id, status from action_proposals where id = $1", [BAD_KIND_LINKED]);
    expect(row.rows).toEqual([{ conversation_id: null, status: "proposed" }]);
  });

  it("runs a waiting proposal that has a stale decision time once", async () => {
    expect((await decideOld(RESET, "approve")).outcome).toBe("executed");
    expect((await decideOld(RESET, "approve")).outcome).toBe("already_decided");
    expect((await old.admin<{ n: number }>("select count(*)::int as n from tasks where user_id = $1", [OWNER])).rows[0]!.n).toBe(1);
  });
});

describe("contract step over the expand window", () => {
  const OWNER = "33333333-3333-4333-8333-333333333333";
  const FORGED = "33333333-3333-4333-8333-000000000001";
  const IN_FLIGHT = "33333333-3333-4333-8333-000000000002";
  const FAKE_TASK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const FORGED_LOG = "33333333-3333-4333-8333-000000000003";
  let db: SqlGate;

  beforeAll(async () => {
    db = await startSqlGate({
      defaults: "legacy",
      beforeMigration: {
        file: "20261021010000_memory_hardening_contract.sql",
        // As the signed-in owner, with the older grants of the expand window.
        sql: `
          insert into auth.users (id) values ('${OWNER}');
          set role authenticated;
          select set_config('request.jwt.claims', '{"sub":"${OWNER}","role":"authenticated"}', false);
          insert into action_proposals (id, user_id, kind, payload, summary) values
            ('${FORGED}', '${OWNER}', 'create_task', '{"kind":"create_task","mode":"personal","title":"Forged"}', 'x'),
            ('${IN_FLIGHT}', '${OWNER}', 'create_task', '{"kind":"create_task","mode":"personal","title":"Old"}', 'x');
          update action_proposals set status = 'approved', decided_at = now() where id = '${FORGED}';
          update action_proposals set status = 'executed', result = '{"taskId":"${FAKE_TASK}"}' where id = '${FORGED}';
          -- The reviewer's case: a direct log insert that claims verification.
          insert into action_log (id, user_id, event, detail) values
            ('${FORGED_LOG}', '${OWNER}', 'executed', '{"kind":"create_task","verified":true,"taskId":"${FAKE_TASK}"}');
          -- An older request claimed this one and has not stored its result yet.
          update action_proposals set status = 'approved', decided_at = now() where id = '${IN_FLIGHT}';
          reset role;
          select set_config('request.jwt.claims', '', false);
        `,
      },
    });
  });

  afterAll(async () => {
    await db?.close();
  });

  it("keeps an outcome a caller wrote before the contract as not verified, in the row, the list and the log", async () => {
    const row = await db.admin("select status, decided_by_function from action_proposals where id = $1", [FORGED]);
    expect(row.rows).toEqual([{ status: "executed", decided_by_function: false }]);
    const listed = await createActionProposalRepository(sqlGateClient(db, OWNER)).listProposals(OWNER, undefined, 10);
    expect(listed.find((proposal) => proposal.id === FORGED)).toMatchObject({ status: "executed", verified: false });
    const log = await db.admin<{ event: string; verified: boolean }>(
      `select event, verified from action_log
        where proposal_id = $1 and event in ('approved', 'executed') order by created_at`,
      [FORGED],
    );
    expect(log.rows).toEqual([
      { event: "approved", verified: false },
      { event: "executed", verified: false },
    ]);
    expect((await db.admin<{ n: number }>("select count(*)::int as n from tasks where user_id = $1", [OWNER])).rows[0]!.n).toBe(0);
  });

  it("keeps a log row a caller inserted before the contract as not verified, with no verified key", async () => {
    const row = await db.admin("select verified, detail ? 'verified' as has_key from action_log where id = $1", [FORGED_LOG]);
    expect(row.rows).toEqual([{ verified: false, has_key: false }]);
    const entries = await createActionLogRepository(sqlGateClient(db, OWNER)).list(OWNER, 50);
    expect(entries.find((entry) => entry.id === FORGED_LOG)).toMatchObject({ event: "executed", verified: false });
  });

  it("leaves an older request's claim approved and not verified when the contract removes its result write, and never runs it again", async () => {
    expect(
      await errorCode(() =>
        db.as(user(OWNER), `update action_proposals set status = 'executed', result = '{"taskId":"${FAKE_TASK}"}' where id = $1`, [
          IN_FLIGHT,
        ]),
      ),
    ).toBe(PERMISSION_DENIED);
    const row = await db.admin("select status, result, decided_by_function from action_proposals where id = $1", [IN_FLIGHT]);
    expect(row.rows).toEqual([{ status: "approved", result: null, decided_by_function: false }]);
    expect((await decideAs(db, OWNER, IN_FLIGHT, "approve")).outcome).toBe("already_decided");
    expect((await db.admin<{ n: number }>("select count(*)::int as n from tasks where user_id = $1", [OWNER])).rows[0]!.n).toBe(0);
  });
});
