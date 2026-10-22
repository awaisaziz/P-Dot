// Test doubles for the Google connector (decision 0016). Labelled fakes, not
// real Google or Supabase behaviour beyond what each comment states.
import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getConnectorConfig, type ConnectorConfig } from "@/server/connectors/config";
import { createKeyring, encryptToken } from "@/server/connectors/crypto";
import { toByteaHex } from "@/server/db/connector-grants";

export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
export const EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email";
export const ALL_SCOPES = [CALENDAR_SCOPE, DRIVE_SCOPE, "openid", EMAIL_SCOPE];

export const TEST_CLIENT_ID = "test-client.apps.googleusercontent.com";
export const TEST_CLIENT_SECRET = "test-client-secret-value";
export const TEST_SITE = "https://pdot.test";

/** A fixed 32-byte key per version, base64. */
export function testKey(version: number): string {
  return Buffer.alloc(32, version).toString("base64");
}

export function connectorEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: TEST_CLIENT_SECRET,
    CONNECTOR_TOKEN_KEYS: JSON.stringify({ "1": testKey(1) }),
    CONNECTOR_TOKEN_KEY_VERSION: "1",
    CONNECTOR_ALLOWED_USER_IDS: "*",
    SITE_URL: TEST_SITE,
    ...overrides,
  };
}

export function testConnectorConfig(overrides: Record<string, string | undefined> = {}): ConnectorConfig {
  const config = getConnectorConfig(connectorEnv(overrides) as NodeJS.ProcessEnv);
  if (!config) throw new Error("test connector config is off");
  return config;
}

// ---------------------------------------------------------------------------
// A fake Supabase client for connector_grants. It mirrors the migration's
// rules: RLS by user, column SELECT without the ciphertext columns, column
// UPDATE only on the five granted columns, unique (user_id, provider), the
// check constraints, the two SECURITY DEFINER functions and the log trigger.
// ---------------------------------------------------------------------------

export type Row = Record<string, unknown>;

export interface FakeReply {
  data: unknown;
  error: { code?: string; message: string } | null;
  count?: number | null;
}

const SELECTABLE = new Set([
  "id",
  "user_id",
  "provider",
  "account_sub",
  "account_email",
  "scopes",
  "access_token_expires_at",
  "key_version",
  "status",
  "last_used_at",
  "created_at",
  "updated_at",
]);
const UPDATABLE = new Set(["account_email", "scopes", "status", "last_used_at", "access_token_expires_at"]);
const BYTEA = /^\\x(?:[0-9a-f]{2})*$/;

const denied = (): FakeReply => ({ data: null, error: { code: "42501", message: "permission denied for table connector_grants" } });
const violates = (): FakeReply => ({ data: null, error: { code: "23514", message: "new row violates check constraint" } });

function byteaLength(value: unknown): number | null {
  return typeof value === "string" && BYTEA.test(value) ? (value.length - 2) / 2 : null;
}

function checkRow(row: Row): boolean {
  const refresh = byteaLength(row.refresh_token_ciphertext);
  const access = row.access_token_ciphertext === null ? 0 : byteaLength(row.access_token_ciphertext);
  const email = row.account_email;
  const scopes = row.scopes;
  return (
    row.provider === "google" &&
    typeof row.account_sub === "string" &&
    row.account_sub.length >= 1 &&
    typeof email === "string" &&
    email.length >= 3 &&
    email.length <= 320 &&
    Array.isArray(scopes) &&
    scopes.length >= 1 &&
    scopes.length <= 20 &&
    refresh !== null &&
    refresh >= 28 &&
    refresh <= 4096 &&
    access !== null &&
    (row.access_token_ciphertext === null || (access >= 28 && access <= 4096)) &&
    typeof row.key_version === "number" &&
    row.key_version >= 1 &&
    (row.status === "active" || row.status === "needs_reconnect")
  );
}

export interface LoggedEvent {
  user_id: string;
  event: string;
  detail: Record<string, unknown>;
}

export class FakeConnectorDb {
  grants: Row[] = [];
  actionLog: LoggedEvent[] = [];
  /** Every query, for checks on columns and filters. */
  queries: { op: string; columns: string | null; filters: string[] }[] = [];
  /** Answer every query as if the migration was not applied yet. */
  missingTable = false;
  private seq = 0;

  now(): string {
    this.seq += 1;
    return new Date(Date.UTC(2026, 9, 21, 12, 0, 0) + this.seq * 1000).toISOString();
  }

  /** Every insert, update, delete and token write goes through here, so a test can make one fail. */
  async write(_label: string, run: () => FakeReply): Promise<FakeReply> {
    return run();
  }

  /** A client acting as `uid` (auth.uid()), or with no session for null. */
  client(uid: string | null): SupabaseClient {
    const client = {
      from: (table: string) => new FakeGrantQuery(this, uid, table),
      rpc: (name: string, args: Record<string, unknown>) => new FakeRpc(this, uid, name, args),
    };
    return client as unknown as SupabaseClient;
  }

  log(row: Row, event: string): void {
    // write_action_log skips the log for a deleted account; tests never delete accounts.
    this.actionLog.push({
      user_id: String(row.user_id),
      event,
      detail: {
        grantId: row.id,
        provider: row.provider,
        scopeCount: Array.isArray(row.scopes) ? row.scopes.length : 0,
        status: row.status,
      },
    });
  }

  rowsFor(userId: string): Row[] {
    return this.grants.filter((row) => row.user_id === userId);
  }
}

class FakeGrantQuery implements PromiseLike<FakeReply> {
  private op: "select" | "insert" | "update" | "delete" = "select";
  private columns: string | null = null;
  private filters: { column: string; value: unknown }[] = [];
  private payload: Row = {};
  private shape: "many" | "single" | "maybe" = "many";
  private wantCount = false;

  constructor(
    private readonly db: FakeConnectorDb,
    private readonly uid: string | null,
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
  single(): this {
    this.shape = "single";
    return this;
  }
  maybeSingle(): this {
    this.shape = "maybe";
    return this;
  }

  then<T1 = FakeReply, T2 = never>(
    onFulfilled?: ((value: FakeReply) => T1 | PromiseLike<T1>) | null,
    onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): Promise<T1 | T2> {
    this.db.queries.push({ op: this.op, columns: this.columns, filters: this.filters.map((f) => f.column) });
    const reply =
      this.op === "select" ? Promise.resolve(this.execute()) : this.db.write(this.op, () => this.execute());
    return reply.then(onFulfilled, onRejected);
  }

  private visible(): Row[] {
    return this.db.grants.filter(
      (row) => row.user_id === this.uid && this.filters.every((f) => row[f.column] === f.value),
    );
  }

  private projection(): string[] | "denied" {
    const columns = (this.columns ?? "").split(",").map((c) => c.trim()).filter(Boolean);
    if (columns.some((c) => !SELECTABLE.has(c))) return "denied";
    return columns;
  }

  private shaped(rows: Row[], count?: number): FakeReply {
    const columns = this.projection();
    if (columns === "denied") return denied();
    const projected = rows.map((row) => Object.fromEntries(columns.map((c) => [c, row[c]])));
    if (this.shape === "many") return { data: this.columns === null ? null : projected, error: null, count };
    if (projected.length > 1) return { data: null, error: { code: "PGRST116", message: "more than one row" } };
    if (projected.length === 0 && this.shape === "single") {
      return { data: null, error: { code: "PGRST116", message: "no rows" } };
    }
    return { data: projected[0] ?? null, error: null, count };
  }

  private execute(): FakeReply {
    if (this.table !== "connector_grants") return { data: null, error: { code: "PGRST205", message: "unknown table" } };
    if (this.db.missingTable) {
      return {
        data: null,
        error: { code: "PGRST205", message: "Could not find the table 'public.connector_grants' in the schema cache" },
      };
    }
    if (this.uid === null) return denied();
    if (this.columns !== null && this.projection() === "denied") return denied();

    if (this.op === "select") return this.shaped(this.visible());

    if (this.op === "insert") {
      const at = this.db.now();
      const row: Row = {
        id: randomUUID(),
        user_id: this.uid,
        status: "active",
        access_token_ciphertext: null,
        access_token_expires_at: null,
        last_used_at: null,
        created_at: at,
        ...this.payload,
        updated_at: at,
      };
      if (row.user_id !== this.uid) {
        return { data: null, error: { code: "42501", message: "new row violates row-level security policy" } };
      }
      if (!checkRow(row)) return violates();
      if (this.db.grants.some((g) => g.user_id === row.user_id && g.provider === row.provider)) {
        return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
      }
      this.db.grants.push(row);
      this.db.log(row, "connector_added");
      return this.shaped([row]);
    }

    if (this.op === "update") {
      if (Object.keys(this.payload).some((c) => !UPDATABLE.has(c))) return denied();
      const rows = this.visible();
      for (const row of rows) {
        const next = { ...row, ...this.payload };
        if (!checkRow(next)) return violates();
      }
      for (const row of rows) {
        const before = { status: row.status, scopes: JSON.stringify(row.scopes) };
        Object.assign(row, this.payload, { updated_at: this.db.now() });
        if (before.status !== row.status || before.scopes !== JSON.stringify(row.scopes)) {
          this.db.log(row, "connector_changed");
        }
      }
      return this.shaped(rows);
    }

    const rows = this.visible();
    this.db.grants = this.db.grants.filter((row) => !rows.includes(row));
    for (const row of rows) this.db.log(row, "connector_removed");
    return this.columns === null ? { data: null, error: null, count: this.wantCount ? rows.length : null } : this.shaped(rows);
  }
}

class FakeRpc implements PromiseLike<FakeReply> {
  constructor(
    private readonly db: FakeConnectorDb,
    private readonly uid: string | null,
    private readonly name: string,
    private readonly args: Record<string, unknown>,
  ) {}

  then<T1 = FakeReply, T2 = never>(
    onFulfilled?: ((value: FakeReply) => T1 | PromiseLike<T1>) | null,
    onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): Promise<T1 | T2> {
    this.db.queries.push({ op: `rpc:${this.name}`, columns: null, filters: [] });
    const reply =
      this.name === "store_connector_tokens"
        ? this.db.write(`rpc.${this.name}`, () => this.execute())
        : Promise.resolve(this.execute());
    return reply.then(onFulfilled, onRejected);
  }

  private execute(): FakeReply {
    if (this.db.missingTable) {
      return { data: null, error: { code: "PGRST202", message: "Could not find the function in the schema cache" } };
    }
    if (this.uid === null) return { data: null, error: { code: "42501", message: "not signed in" } };
    const row = this.db.grants.find((g) => g.id === this.args.p_id && g.user_id === this.uid);
    if (this.name === "connector_grant_secrets") {
      return {
        data: row
          ? [
              {
                id: row.id,
                key_version: row.key_version,
                refresh_token_ciphertext: row.refresh_token_ciphertext,
                access_token_ciphertext: row.access_token_ciphertext,
              },
            ]
          : [],
        error: null,
      };
    }
    if (this.name === "store_connector_tokens") {
      if (!row) return { data: false, error: null };
      const next = {
        ...row,
        refresh_token_ciphertext: this.args.p_refresh ?? row.refresh_token_ciphertext,
        access_token_ciphertext: this.args.p_access ?? null,
        access_token_expires_at: this.args.p_expires ?? null,
        key_version: this.args.p_key_version,
      };
      if (!checkRow(next)) return violates();
      Object.assign(row, next, { updated_at: this.db.now() });
      return { data: true, error: null };
    }
    return { data: null, error: { code: "PGRST202", message: "unknown function" } };
  }
}

// ---------------------------------------------------------------------------
// A fake Google: the OAuth token and revoke endpoints and the Calendar and
// Drive GET endpoints the connector uses. Revoking any token of an account
// ends every token issued to that account so far, as Google's revoke ends
// the whole grant for the user and client.
// ---------------------------------------------------------------------------

export interface FakeAccount {
  sub: string;
  email: string;
}

export const ALICE_GOOGLE: FakeAccount = { sub: "google-sub-alice", email: "alice@example.com" };
export const ALICE_WORK_GOOGLE: FakeAccount = { sub: "google-sub-alice-work", email: "alice@work.example" };

interface IssuedToken {
  account: FakeAccount;
  kind: "refresh" | "access";
  issuedAt: number;
  expiresAt: number;
}

export interface RecordedRequest {
  method: string;
  url: URL;
  body: string | null;
  authorization: string | null;
}

export interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  webViewLink?: string;
  /** Text served by export or alt=media. */
  content?: string;
  /** Raw bytes instead of `content`. */
  bytes?: Uint8Array;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function base64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

export function fakeIdToken(payload: Record<string, unknown>): string {
  return `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify(payload))}.c2lnbmF0dXJl`;
}

export class FakeGoogle {
  requests: RecordedRequest[] = [];
  /** The account that approves on the consent screen. */
  account: FakeAccount = ALICE_GOOGLE;
  /** What the consent screen grants (granular consent can be a subset). */
  grantedScopes: string[] = ALL_SCOPES;
  issueRefreshToken = true;
  /** The code exchange's ID token: a valid one, none, or one for another client. */
  idToken: "valid" | "missing" | "other_audience" = "valid";
  /** Set to answer the next refresh with this OAuth error. */
  refreshError: { status: number; error: string } | null = null;
  /** Set to answer the code exchange with this OAuth error. */
  exchangeError: { status: number; error: string } | null = null;
  /** Answer Calendar and Drive GETs with this status. */
  apiStatus: number | null = null;
  /** Answer the revoke endpoint with this status. */
  revokeStatus: number | null = null;
  accessLifetimeSeconds = 3600;
  clock: () => number = () => Date.now();

  tokens = new Map<string, IssuedToken>();
  /** sub → when the grant was last revoked; tokens issued before it are dead. */
  revokedAt = new Map<string, number>();
  revokedTokens: string[] = [];

  calendars: { id: string; summary?: string; summaryOverride?: string; selected?: boolean; primary?: boolean; hidden?: boolean }[] = [
    { id: "primary-id@example.com", summary: "Alice", selected: true, primary: true },
  ];
  /** Raw event items by calendar ID. */
  events: Record<string, unknown[]> = {};
  /** Calendar IDs whose events request fails with 500. */
  failingCalendars = new Set<string>();
  files: FakeFile[] = [];

  private codes = new Map<string, { challenge: string; account: FakeAccount; scopes: string[]; redirectUri: string }>();
  private seq = 0;

  constructor(readonly clientId = TEST_CLIENT_ID, readonly clientSecret = TEST_CLIENT_SECRET) {}

  /** The token endpoint issuing tokens. The write sweep wraps it. */
  async tokenWrite(run: () => Response): Promise<Response> {
    return run();
  }

  /** The revoke endpoint. The write sweep wraps it. */
  async revokeWrite(run: () => Response): Promise<Response> {
    return run();
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : null;
    const headers = new Headers(init?.headers);
    this.requests.push({ method, url, body, authorization: headers.get("authorization") });
    return this.handle(method, url, body, headers);
  };

  /** Issues a refresh and an access token for an account, as if it had connected before. */
  issue(account: FakeAccount = this.account): { refresh: string; access: string } {
    return { refresh: this.newToken(account, "refresh"), access: this.newToken(account, "access") };
  }

  /** Simulates the user approving on Google's consent screen; returns the code for the callback. */
  approve(authorizationUrl: string): { code: string; state: string } {
    const url = new URL(authorizationUrl);
    const p = url.searchParams;
    if (url.origin + url.pathname !== "https://accounts.google.com/o/oauth2/v2/auth") throw new Error("not Google");
    if (p.get("client_id") !== this.clientId || p.get("code_challenge_method") !== "S256") throw new Error("bad request");
    const code = `code-${(this.seq += 1)}`;
    this.codes.set(code, {
      challenge: p.get("code_challenge") ?? "",
      account: this.account,
      scopes: this.grantedScopes,
      redirectUri: p.get("redirect_uri") ?? "",
    });
    return { code, state: p.get("state") ?? "" };
  }

  isLive(token: string): boolean {
    const issued = this.tokens.get(token);
    if (!issued) return false;
    const revoked = this.revokedAt.get(issued.account.sub);
    if (revoked !== undefined && issued.issuedAt <= revoked) return false;
    return issued.kind === "refresh" || issued.expiresAt > this.clock();
  }

  apiRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.url.host === "www.googleapis.com");
  }

  tokenRequests(grantType?: string): RecordedRequest[] {
    return this.requests.filter(
      (r) =>
        r.url.toString() === "https://oauth2.googleapis.com/token" &&
        (grantType === undefined || new URLSearchParams(r.body ?? "").get("grant_type") === grantType),
    );
  }

  revokeRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.url.toString() === "https://oauth2.googleapis.com/revoke");
  }

  private newToken(account: FakeAccount, kind: "refresh" | "access"): string {
    this.seq += 1;
    const token = `${kind === "refresh" ? "1//refresh" : "ya29.access"}-${account.sub}-${this.seq}`;
    // A strictly increasing issue time keeps "issued before the revoke" exact.
    this.tokens.set(token, { account, kind, issuedAt: this.seq, expiresAt: this.clock() + this.accessLifetimeSeconds * 1000 });
    return token;
  }

  private revokeAccount(sub: string): void {
    this.revokedAt.set(sub, this.seq);
    this.seq += 1;
  }

  private async handle(method: string, url: URL, body: string | null, headers: Headers): Promise<Response> {
    if (url.host === "oauth2.googleapis.com") {
      if (method !== "POST" || headers.get("content-type") !== "application/x-www-form-urlencoded" || url.search !== "") {
        return json({ error: "invalid_request" }, 400);
      }
      const form = new URLSearchParams(body ?? "");
      if (url.pathname === "/revoke") return this.revokeWrite(() => this.revoke(form));
      if (url.pathname === "/token") return this.token(form);
      return json({ error: "not_found" }, 404);
    }
    if (url.host !== "www.googleapis.com" || method !== "GET") return json({ error: "unexpected" }, 400);
    const token = (headers.get("authorization") ?? "").replace(/^Bearer /, "");
    const issued = this.tokens.get(token);
    if (!issued || issued.kind !== "access" || !this.isLive(token)) return json({ error: { code: 401 } }, 401);
    if (this.apiStatus !== null) return json({ error: { code: this.apiStatus } }, this.apiStatus);
    return this.api(url);
  }

  private revoke(form: URLSearchParams): Response {
    if (this.revokeStatus !== null) return json({ error: "backend_error" }, this.revokeStatus);
    const token = form.get("token") ?? "";
    const issued = this.tokens.get(token);
    if (!issued || !this.isLive(token)) return json({ error: "invalid_token" }, 400);
    this.revokedTokens.push(token);
    this.revokeAccount(issued.account.sub);
    return new Response(null, { status: 200 });
  }

  private token(form: URLSearchParams): Promise<Response> | Response {
    if (form.get("client_id") !== this.clientId || form.get("client_secret") !== this.clientSecret) {
      return json({ error: "invalid_client" }, 401);
    }
    if (form.get("grant_type") === "authorization_code") {
      if (this.exchangeError) return json({ error: this.exchangeError.error, error_description: "Bad Request" }, this.exchangeError.status);
      const code = this.codes.get(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (!code || code.challenge !== challenge || code.redirectUri !== form.get("redirect_uri")) {
        return json({ error: "invalid_grant", error_description: "Bad Request" }, 400);
      }
      this.codes.delete(form.get("code") ?? "");
      return this.tokenWrite(() => {
        const refresh = this.issueRefreshToken ? this.newToken(code.account, "refresh") : undefined;
        const access = this.newToken(code.account, "access");
        return json({
          access_token: access,
          expires_in: this.accessLifetimeSeconds,
          refresh_token: refresh,
          scope: code.scopes.join(" "),
          token_type: "Bearer",
          id_token:
            this.idToken === "missing"
              ? undefined
              : fakeIdToken({
                  iss: "https://accounts.google.com",
                  aud: this.idToken === "other_audience" ? "another-client.apps.googleusercontent.com" : this.clientId,
                  sub: code.account.sub,
                  email: code.account.email,
                  email_verified: true,
                }),
        });
      });
    }
    if (form.get("grant_type") === "refresh_token") {
      if (this.refreshError) return json({ error: this.refreshError.error, error_description: "Token has been expired or revoked." }, this.refreshError.status);
      const token = form.get("refresh_token") ?? "";
      const issued = this.tokens.get(token);
      if (!issued || issued.kind !== "refresh" || !this.isLive(token)) {
        return json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400);
      }
      return this.tokenWrite(() =>
        json({
          access_token: this.newToken(issued.account, "access"),
          expires_in: this.accessLifetimeSeconds,
          scope: ALL_SCOPES.join(" "),
          token_type: "Bearer",
        }),
      );
    }
    return json({ error: "unsupported_grant_type" }, 400);
  }

  private api(url: URL): Response {
    const path = url.pathname;
    if (path === "/calendar/v3/users/me/calendarList") return json({ items: this.calendars });
    const events = /^\/calendar\/v3\/calendars\/([^/]+)\/events$/.exec(path);
    if (events) {
      const id = decodeURIComponent(events[1]!);
      if (this.failingCalendars.has(id)) return json({ error: { code: 500 } }, 500);
      if (!this.calendars.some((c) => c.id === id)) return json({ error: { code: 404 } }, 404);
      // One page of maxResults items (Google's default is 250); nextPageToken when more follow.
      const items = this.events[id] ?? [];
      const pageSize = Number(url.searchParams.get("maxResults") ?? 250);
      const page = items.slice(0, pageSize);
      return json(items.length > pageSize ? { items: page, nextPageToken: "page-2" } : { items: page });
    }
    if (path === "/drive/v3/files") {
      return json({
        files: this.files.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, webViewLink: f.webViewLink })),
      });
    }
    const exported = /^\/drive\/v3\/files\/([^/]+)\/export$/.exec(path);
    const file = /^\/drive\/v3\/files\/([^/]+)$/.exec(path);
    const id = decodeURIComponent((exported ?? file)?.[1] ?? "");
    const found = this.files.find((f) => f.id === id);
    if (!found) return json({ error: { code: 404 } }, 404);
    if (exported || url.searchParams.get("alt") === "media") {
      const payload = new Uint8Array(found.bytes ?? new TextEncoder().encode(found.content ?? ""));
      return new Response(payload, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    return json({ id: found.id, name: found.name, mimeType: found.mimeType, modifiedTime: found.modifiedTime, webViewLink: found.webViewLink });
  }
}

/** Puts a grant straight into the fake database, with tokens encrypted by the real code. */
export async function seedGrant(
  db: FakeConnectorDb,
  config: ConnectorConfig,
  input: {
    userId: string;
    account?: FakeAccount;
    refreshToken: string;
    accessToken?: string | null;
    accessExpiresAt?: string | null;
    scopes?: string[];
    status?: "active" | "needs_reconnect";
  },
): Promise<Row> {
  const account = input.account ?? ALICE_GOOGLE;
  const keyring = createKeyring(config);
  const binding = (purpose: "refresh" | "access") => ({
    userId: input.userId,
    provider: "google" as const,
    accountSub: account.sub,
    purpose,
  });
  const refresh = await encryptToken(keyring, input.refreshToken, binding("refresh"));
  const access = input.accessToken ? await encryptToken(keyring, input.accessToken, binding("access")) : null;
  const at = db.now();
  const row: Row = {
    id: randomUUID(),
    user_id: input.userId,
    provider: "google",
    account_sub: account.sub,
    account_email: account.email,
    scopes: input.scopes ?? ALL_SCOPES,
    refresh_token_ciphertext: toByteaHex(refresh),
    access_token_ciphertext: access ? toByteaHex(access) : null,
    access_token_expires_at: input.accessExpiresAt ?? null,
    key_version: config.keyVersion,
    status: input.status ?? "active",
    last_used_at: null,
    created_at: at,
    updated_at: at,
  };
  db.grants.push(row);
  return row;
}
