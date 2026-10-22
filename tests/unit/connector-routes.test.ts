import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/server/auth/session";
import { createKeyring, decryptToken, randomState, createPkceVerifier, signState } from "@/server/connectors/crypto";
import { fromByteaHex } from "@/server/db/connector-grants";
import {
  ALICE_GOOGLE,
  ALICE_WORK_GOOGLE,
  CALENDAR_SCOPE,
  connectorEnv,
  DRIVE_SCOPE,
  FakeConnectorDb,
  FakeGoogle,
  seedGrant,
  TEST_SITE,
  testConnectorConfig,
  testKey,
  type FakeAccount,
  type Row,
} from "../support/connector-fakes";
import { describeCase, hasFault, sweepWriteFaults, type SweepCase, type WriteFaults } from "../support/write-faults";

vi.mock("@/server/auth/session", () => ({ getAuthContext: vi.fn() }));

const { getAuthContext } = await import("@/server/auth/session");
const listRoute = await import("@/app/api/connectors/route");
const googleRoute = await import("@/app/api/connectors/google/route");
const startRoute = await import("@/app/api/connectors/google/start/route");
const callbackRoute = await import("@/app/api/connectors/google/callback/route");
const upcomingRoute = await import("@/app/api/connectors/google/upcoming/route");
const healthRoute = await import("@/app/api/health/route");

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HOST = "pdot.test";
const CONNECTED = `${TEST_SITE}/connectors?connected=google`;
const failedAt = (code: string) => `${TEST_SITE}/connectors?error=${code}`;
/** A write-fault sweep runs its route once per fault case (see the callback sweep below). */
const SWEEP_TIMEOUT_MS = 60_000;

let db: FakeConnectorDb;
let google: FakeGoogle;

function useEnv(overrides: Record<string, string | undefined> = {}) {
  for (const [name, value] of Object.entries(connectorEnv(overrides))) vi.stubEnv(name, value ?? "");
}

function fresh() {
  db = new FakeConnectorDb();
  google = new FakeGoogle();
  vi.stubGlobal("fetch", google.fetch);
}

beforeEach(() => {
  useEnv();
  fresh();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function signInAs(userId: string) {
  const auth: AuthContext = { userId, email: `${userId.slice(0, 4)}@example.com`, supabase: db.client(userId) };
  vi.mocked(getAuthContext).mockResolvedValue(auth);
}

function signOut() {
  vi.mocked(getAuthContext).mockResolvedValue(null);
}

function request(method: string, path: string, init: { headers?: Record<string, string>; body?: string } = {}) {
  return new Request(`${TEST_SITE}${path}`, {
    method,
    headers: { host: HOST, origin: TEST_SITE, ...init.headers },
    body: init.body,
  });
}

const cookieFrom = (response: Response) => /__Host-pdot_oauth=([^;]*)/.exec(response.headers.get("set-cookie") ?? "")?.[1] ?? "";

async function startConnect(userId = ALICE) {
  signInAs(userId);
  const response = await startRoute.POST(request("POST", "/api/connectors/google/start"));
  expect(response.status).toBe(200);
  const { url } = (await response.json()) as { url: string };
  return { cookie: cookieFrom(response), url };
}

function callback(params: Record<string, string> | [string, string][], cookie: string | null) {
  return callbackRoute.GET(
    new Request(`${TEST_SITE}/api/connectors/google/callback?${new URLSearchParams(params)}`, {
      headers: { host: HOST, ...(cookie === null ? {} : { cookie: `other=1; __Host-pdot_oauth=${cookie}` }) },
    }),
  );
}

async function connect(userId = ALICE) {
  const started = await startConnect(userId);
  const { code, state } = google.approve(started.url);
  return callback({ code, state, scope: "ignored" }, started.cookie);
}

async function storedToken(row: Row, purpose: "refresh" | "access" = "refresh") {
  const column = purpose === "refresh" ? "refresh_token_ciphertext" : "access_token_ciphertext";
  return decryptToken(createKeyring(testConnectorConfig()), fromByteaHex(String(row[column]))!, {
    userId: String(row.user_id),
    provider: "google",
    accountSub: String(row.account_sub),
    purpose,
  });
}

async function seed(options: { account?: FakeAccount; status?: "active" | "needs_reconnect"; accessExpiresAt?: string | null } = {}) {
  const account = options.account ?? ALICE_GOOGLE;
  const tokens = google.issue(account);
  const row = await seedGrant(db, testConnectorConfig(), {
    userId: ALICE,
    account,
    refreshToken: tokens.refresh,
    accessToken: tokens.access,
    accessExpiresAt: options.accessExpiresAt === undefined ? new Date(Date.now() + 3_000_000).toISOString() : options.accessExpiresAt,
    status: options.status,
  });
  return { tokens, row };
}

function captureLogs(): string[] {
  const lines: string[] = [];
  for (const method of ["info", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
  }
  return lines;
}

function callbackLog(lines: string[]): Record<string, unknown> | undefined {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((entry) => entry.event === "connector_callback");
}

function expectRedirect(response: Response, location: string) {
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe(location);
  expect(response.headers.get("set-cookie")).toBe("__Host-pdot_oauth=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0");
}

// ---------------------------------------------------------------------------

describe("GET /api/health", () => {
  it("reports whether Google connectors are configured, as a boolean only", async () => {
    const on = await healthRoute.GET().json();
    expect(on.configured.connectors).toEqual({ google: true });
    useEnv({ GOOGLE_CLIENT_SECRET: "" });
    expect((await healthRoute.GET().json()).configured.connectors).toEqual({ google: false });
    useEnv({ CONNECTOR_TOKEN_KEYS: "{bad" });
    const text = await healthRoute.GET().text();
    expect(JSON.parse(text).configured.connectors).toEqual({ google: false });
    expect(text).not.toContain("bad");
    expect(text).not.toContain("test-client-secret");
  });
});

describe("GET /api/connectors", () => {
  it("answers 401 without a session", async () => {
    signOut();
    expect((await listRoute.GET(request("GET", "/api/connectors"))).status).toBe(401);
  });

  it("answers 503 for a malformed setting", async () => {
    useEnv({ CONNECTOR_TOKEN_KEYS: "{bad" });
    signInAs(ALICE);
    const response = await listRoute.GET(request("GET", "/api/connectors"));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("{bad");
  });

  it("returns no grant, and whether Google is available and allowed", async () => {
    signInAs(ALICE);
    expect(await (await listRoute.GET(request("GET", "/api/connectors"))).json()).toEqual({ google: null, available: true, allowed: true });
    useEnv({ CONNECTOR_ALLOWED_USER_IDS: BOB });
    expect(await (await listRoute.GET(request("GET", "/api/connectors"))).json()).toEqual({ google: null, available: true, allowed: false });
    useEnv({ GOOGLE_CLIENT_SECRET: "" });
    expect(await (await listRoute.GET(request("GET", "/api/connectors"))).json()).toEqual({ google: null, available: false, allowed: false });
  });

  it("returns the grant without any token, the account ID or the row ID", async () => {
    const { tokens, row } = await seed();
    signInAs(ALICE);
    const response = await listRoute.GET(request("GET", "/api/connectors"));
    const text = await response.text();
    expect(JSON.parse(text).google).toEqual({
      provider: "google",
      accountEmail: "alice@example.com",
      scopes: row.scopes,
      products: { calendar: true, drive: true },
      status: "active",
      lastUsedAt: null,
      connectedAt: row.created_at,
      updatedAt: row.updated_at,
    });
    for (const secret of [tokens.refresh, tokens.access, ALICE_GOOGLE.sub, String(row.id), String(row.refresh_token_ciphertext)]) {
      expect(text).not.toContain(secret);
    }
    expect(db.queries.every((q) => !(q.columns ?? "").includes("ciphertext"))).toBe(true);
  });

  it("shows no other user's grant and treats a missing table as no grant", async () => {
    await seed();
    signInAs(BOB);
    expect((await (await listRoute.GET(request("GET", "/api/connectors"))).json()).google).toBeNull();
    db.missingTable = true;
    signInAs(ALICE);
    const response = await listRoute.GET(request("GET", "/api/connectors"));
    expect(response.status).toBe(200);
    expect((await response.json()).google).toBeNull();
  });
});

describe("POST /api/connectors/google/start", () => {
  it("answers 401 without a session and 403 for another origin", async () => {
    signOut();
    expect((await startRoute.POST(request("POST", "/api/connectors/google/start"))).status).toBe(401);
    signInAs(ALICE);
    const cross = await startRoute.POST(request("POST", "/api/connectors/google/start", { headers: { origin: "https://evil.example" } }));
    expect(cross.status).toBe(403);
    expect(cross.headers.get("set-cookie")).toBeNull();
  });

  it("answers 503 when not configured and 403 for a user who is not allowed", async () => {
    signInAs(ALICE);
    useEnv({ CONNECTOR_TOKEN_KEYS: "" });
    expect((await startRoute.POST(request("POST", "/api/connectors/google/start"))).status).toBe(503);
    useEnv({ CONNECTOR_ALLOWED_USER_IDS: "" });
    const blocked = await startRoute.POST(request("POST", "/api/connectors/google/start"));
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).error.message).toBe("Google is not open to your account yet.");
    expect(blocked.headers.get("set-cookie")).toBeNull();
  });

  it("refuses a host that is not the SITE_URL host, such as a preview", async () => {
    signInAs(ALICE);
    const preview = "https://pdot-preview.workers.dev";
    const response = await startRoute.POST(
      new Request(`${preview}/api/connectors/google/start`, { method: "POST", headers: { host: "pdot-preview.workers.dev", origin: preview } }),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("answers 400 for a body that is not an empty object", async () => {
    signInAs(ALICE);
    const response = await startRoute.POST(
      request("POST", "/api/connectors/google/start", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scopes: ["https://www.googleapis.com/auth/gmail.send"] }),
      }),
    );
    expect(response.status).toBe(400);
    const empty = await startRoute.POST(
      request("POST", "/api/connectors/google/start", { headers: { "content-type": "application/json" }, body: "{}" }),
    );
    expect(empty.status).toBe(200);
  });

  it("sets the signed state cookie and returns Google's URL with the matching state and PKCE challenge", async () => {
    signInAs(ALICE);
    const response = await startRoute.POST(request("POST", "/api/connectors/google/start"));
    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^__Host-pdot_oauth=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/);
    const { url } = (await response.json()) as { url: string };
    const params = new URL(url).searchParams;
    expect(params.get("redirect_uri")).toBe(`${TEST_SITE}/api/connectors/google/callback`);
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("scope")).toBe(`${CALENDAR_SCOPE} ${DRIVE_SCOPE} openid email`);

    const payload = JSON.parse(Buffer.from(cookieFrom(response).split(".")[0]!, "base64url").toString());
    expect(payload).toMatchObject({ v: 1, uid: ALICE, state: params.get("state") });
    expect(Math.abs(payload.iat - Date.now() / 1000)).toBeLessThan(5);
    const { createHash } = await import("node:crypto");
    expect(createHash("sha256").update(payload.verifier).digest("base64url")).toBe(params.get("code_challenge"));
    expect(Object.keys(payload).sort()).toEqual(["iat", "state", "uid", "v", "verifier"]);
    expect(url).not.toContain(payload.verifier);
  });
});

describe("GET /api/connectors/google/callback", () => {
  it("sends a visitor without a session to the login page and clears the cookie", async () => {
    const started = await startConnect();
    signOut();
    const response = await callback({ code: "c", state: "s" }, started.cookie);
    expectRedirect(response, `${TEST_SITE}/login?next=/connectors`);
    expect(google.tokenRequests()).toHaveLength(0);
  });

  it("connects: exchanges the code, stores encrypted tokens and logs connector_added", async () => {
    const response = await connect();
    expectRedirect(response, CONNECTED);
    const rows = db.rowsFor(ALICE);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      provider: "google",
      account_sub: ALICE_GOOGLE.sub,
      account_email: ALICE_GOOGLE.email,
      status: "active",
      key_version: 1,
    });
    expect(row.scopes).toEqual(expect.arrayContaining([CALENDAR_SCOPE, DRIVE_SCOPE]));
    const refresh = await storedToken(row);
    expect(google.isLive(refresh)).toBe(true);
    expect(String(row.refresh_token_ciphertext)).not.toContain(Buffer.from(refresh).toString("hex"));
    expect(google.isLive(await storedToken(row, "access"))).toBe(true);
    expect(db.actionLog).toEqual([
      { user_id: ALICE, event: "connector_added", detail: { grantId: row.id, provider: "google", scopeCount: 4, status: "active" } },
    ]);
    expect(google.revokeRequests()).toHaveLength(0);
  });

  it.each([
    ["a different state", (s: { code: string; state: string }) => ({ code: s.code, state: randomState() })],
    ["no state", (s: { code: string; state: string }) => ({ code: s.code })],
    ["two states", (s: { code: string; state: string }): [string, string][] => [["code", s.code], ["state", s.state], ["state", s.state]]],
  ])("refuses %s with state_mismatch and exchanges nothing", async (_label, params) => {
    const started = await startConnect();
    const approved = google.approve(started.url);
    const response = await callback(params(approved), started.cookie);
    expectRedirect(response, failedAt("state_mismatch"));
    expect(google.tokenRequests()).toHaveLength(0);
    expect(db.grants).toHaveLength(0);
  });

  it("refuses a missing or tampered cookie", async () => {
    const started = await startConnect();
    const approved = google.approve(started.url);
    expectRedirect(await callback(approved, null), failedAt("state_mismatch"));
    const [body, signature] = started.cookie.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), uid: BOB })).toString("base64url");
    expectRedirect(await callback(approved, `${forged}.${signature}`), failedAt("state_mismatch"));
    expect(google.tokenRequests()).toHaveLength(0);
  });

  it("refuses a cookie made for another user", async () => {
    const started = await startConnect(BOB);
    const approved = google.approve(started.url);
    signInAs(ALICE);
    expectRedirect(await callback(approved, started.cookie), failedAt("state_mismatch"));
    expect(google.tokenRequests()).toHaveLength(0);
    expect(db.grants).toHaveLength(0);
  });

  it("refuses an expired cookie", async () => {
    const state = randomState();
    const cookie = await signState(createKeyring(testConnectorConfig()), {
      v: 1,
      uid: ALICE,
      state,
      verifier: createPkceVerifier(),
      iat: Math.floor(Date.now() / 1000) - 601,
    });
    signInAs(ALICE);
    expectRedirect(await callback({ code: "code-1", state }, cookie), failedAt("state_mismatch"));
    expect(google.tokenRequests()).toHaveLength(0);
  });

  it.each([
    ["access_denied", "denied"],
    ["admin_policy_enforced", "admin_blocked"],
    ["org_internal", "not_a_tester"],
    ["<script>alert(1)</script>", "exchange_failed"],
  ])("maps Google's error %s to %s and never passes Google's text on", async (error, code) => {
    const started = await startConnect();
    const { state } = google.approve(started.url);
    const response = await callback({ error, error_description: "Something <b>bad</b>", state }, started.cookie);
    expectRedirect(response, failedAt(code));
    expect(response.headers.get("location")).not.toContain("bad");
    expect(google.tokenRequests()).toHaveLength(0);
  });

  it("answers exchange_failed when the exchange fails or connectors are off", async () => {
    google.exchangeError = { status: 400, error: "invalid_grant" };
    expectRedirect(await connect(), failedAt("exchange_failed"));
    expect(db.grants).toHaveLength(0);

    google.exchangeError = null;
    const started = await startConnect();
    const approved = google.approve(started.url);
    useEnv({ GOOGLE_CLIENT_SECRET: "" });
    expectRedirect(await callback(approved, started.cookie), failedAt("exchange_failed"));
    useEnv({ CONNECTOR_TOKEN_KEYS: "{bad" });
    expectRedirect(await callback(approved, started.cookie), failedAt("exchange_failed"));
  });

  it("answers exchange_failed and revokes the access token when Google gives no refresh token", async () => {
    google.issueRefreshToken = false;
    expectRedirect(await connect(), failedAt("exchange_failed"));
    expect(google.revokeRequests()).toHaveLength(1);
    expect(db.grants).toHaveLength(0);
  });

  it("revokes and answers scopes_missing when no tool scope was granted", async () => {
    google.grantedScopes = ["openid", "https://www.googleapis.com/auth/userinfo.email"];
    expectRedirect(await connect(), failedAt("scopes_missing"));
    const revoked = google.revokeRequests();
    expect(revoked).toHaveLength(1);
    const token = new URLSearchParams(revoked[0]!.body ?? "").get("token")!;
    expect(token).toMatch(/^1\/\/refresh/);
    expect(google.isLive(token)).toBe(false);
    expect(db.grants).toHaveLength(0);
  });

  it("marks the stored grant of the same account when a revoke ended it", async () => {
    const { tokens } = await seed();
    google.grantedScopes = ["openid"];
    expectRedirect(await connect(), failedAt("scopes_missing"));
    // Google ends the account's whole grant on a revoke, so the stored token stopped working too.
    expect(google.isLive(tokens.refresh)).toBe(false);
    expect(db.grants).toHaveLength(1);
    expect(db.grants[0]!.status).toBe("needs_reconnect");
  });

  it("leaves another account's stored grant alone when the new account's token is revoked", async () => {
    const { tokens } = await seed({ account: ALICE_WORK_GOOGLE });
    google.grantedScopes = ["openid"];
    expectRedirect(await connect(), failedAt("scopes_missing"));
    expect(google.isLive(tokens.refresh)).toBe(true);
    expect(db.grants[0]).toMatchObject({ account_sub: ALICE_WORK_GOOGLE.sub, status: "active" });
  });

  it("stores a subset of scopes from granular consent", async () => {
    google.grantedScopes = [CALENDAR_SCOPE, "openid"];
    expectRedirect(await connect(), CONNECTED);
    expect(db.grants[0]!.scopes).toEqual([CALENDAR_SCOPE, "openid"]);
  });

  it("revokes the new token and answers storage_failed when the grant cannot be stored", async () => {
    db.write = async () => ({ data: null, error: { message: "boom" } });
    expectRedirect(await connect(), failedAt("storage_failed"));
    expect(db.grants).toHaveLength(0);
    const revoked = google.revokeRequests();
    expect(revoked).toHaveLength(1);
    expect(google.isLive(new URLSearchParams(revoked[0]!.body ?? "").get("token")!)).toBe(false);
  });

  it("reconnects the same account in place and does not revoke, which would end the new grant", async () => {
    const { tokens, row } = await seed({ status: "needs_reconnect" });
    expectRedirect(await connect(), CONNECTED);
    const rows = db.rowsFor(ALICE);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(row.id);
    expect(rows[0]!.status).toBe("active");
    const refresh = await storedToken(rows[0]!);
    expect(refresh).not.toBe(tokens.refresh);
    expect(google.isLive(refresh)).toBe(true);
    expect(google.revokeRequests()).toHaveLength(0);
    expect(db.actionLog.map((e) => e.event)).toEqual(["connector_changed"]);
  });

  it("replaces another account's grant and revokes its token", async () => {
    const old = await seed({ account: ALICE_WORK_GOOGLE });
    const lines = captureLogs();
    expectRedirect(await connect(), CONNECTED);
    const rows = db.rowsFor(ALICE);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.account_sub).toBe(ALICE_GOOGLE.sub);
    expect(google.isLive(old.tokens.refresh)).toBe(false);
    expect(google.isLive(await storedToken(rows[0]!))).toBe(true);
    expect(db.actionLog.map((e) => e.event)).toEqual(["connector_removed", "connector_added"]);
    expect(callbackLog(lines)).toMatchObject({ level: "info", outcome: "connected", oldAccountRevoked: true });
  });

  it("keeps the other account's grant when the new one cannot be inserted", async () => {
    const old = await seed({ account: ALICE_WORK_GOOGLE });
    const write = db.write.bind(db);
    let inserts = 0;
    db.write = async (label, run) => {
      inserts += label === "insert" ? 1 : 0;
      return label === "insert" && inserts === 1 ? { data: null, error: { message: "boom" } } : write(label, run);
    };
    expectRedirect(await connect(), failedAt("storage_failed"));
    const rows = db.rowsFor(ALICE);
    expect(rows).toHaveLength(1);
    // The old row is back as it was: same ID, connection time and ciphertexts.
    expect(rows[0]).toMatchObject({
      id: old.row.id,
      account_sub: ALICE_WORK_GOOGLE.sub,
      status: "active",
      created_at: old.row.created_at,
      refresh_token_ciphertext: old.row.refresh_token_ciphertext,
      access_token_ciphertext: old.row.access_token_ciphertext,
    });
    expect(await storedToken(rows[0]!)).toBe(old.tokens.refresh);
    expect(google.isLive(old.tokens.refresh)).toBe(true);
    // Only the new account's token was revoked.
    const revoked = google.revokeRequests().map((r) => new URLSearchParams(r.body ?? "").get("token"));
    expect(revoked).toHaveLength(1);
    expect(revoked[0]).toMatch(new RegExp(`^1//refresh-${ALICE_GOOGLE.sub}-\\d+$`));
    expect(db.actionLog.map((e) => e.event)).toEqual(["connector_removed", "connector_added"]);
  });

  it("replaces an account whose token cannot be read, and logs that it was not revoked", async () => {
    const old = await seed({ account: ALICE_WORK_GOOGLE });
    // The old row is under key version 1, which this server no longer has.
    useEnv({ CONNECTOR_TOKEN_KEYS: JSON.stringify({ "2": testKey(2) }), CONNECTOR_TOKEN_KEY_VERSION: "2" });
    const lines = captureLogs();
    expectRedirect(await connect(), CONNECTED);
    const rows = db.rowsFor(ALICE);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ account_sub: ALICE_GOOGLE.sub, key_version: 2, status: "active" });
    expect(google.revokeRequests()).toHaveLength(0);
    // Nothing here can read the old token, so it stays live at Google; the log says so, without the token.
    expect(google.isLive(old.tokens.refresh)).toBe(true);
    expect(callbackLog(lines)).toMatchObject({ level: "warn", outcome: "connected", oldAccountRevoked: false });
    expect(lines.join("\n")).not.toContain(old.tokens.refresh);
  });

  it.each([["missing"], ["other_audience"]] as const)(
    "revokes the tokens and answers exchange_failed when the ID token is %s",
    async (idToken) => {
      google.idToken = idToken;
      expectRedirect(await connect(), failedAt("exchange_failed"));
      expect(db.grants).toHaveLength(0);
      const revoked = google.revokeRequests().map((r) => new URLSearchParams(r.body ?? "").get("token"));
      expect(revoked).toHaveLength(1);
      expect(revoked[0]).toMatch(/^1\/\/refresh/);
      expect([...google.tokens.keys()].filter((token) => google.isLive(token))).toEqual([]);
    },
  );

  it("logs no token, code, email or Google text", async () => {
    const lines: string[] = [];
    for (const method of ["info", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((line: unknown) => {
        lines.push(String(line));
      });
    }
    await connect();
    google.exchangeError = { status: 400, error: "invalid_grant" };
    await connect();
    const text = lines.join("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const token of google.tokens.keys()) expect(text).not.toContain(token);
    expect(text).not.toContain("alice@example.com");
    expect(text).not.toContain("code-");
    expect(text).not.toContain("Bad Request");
  });
});

describe("DELETE /api/connectors/google", () => {
  it("answers 401 without a session and 403 for another origin", async () => {
    await seed();
    signOut();
    expect((await googleRoute.DELETE(request("DELETE", "/api/connectors/google"))).status).toBe(401);
    signInAs(ALICE);
    const cross = await googleRoute.DELETE(request("DELETE", "/api/connectors/google", { headers: { origin: "https://evil.example" } }));
    expect(cross.status).toBe(403);
    expect(db.grants).toHaveLength(1);
  });

  it("answers 503 for a malformed setting and deletes nothing", async () => {
    await seed();
    useEnv({ CONNECTOR_ALLOWED_USER_IDS: "not-a-uuid" });
    signInAs(ALICE);
    expect((await googleRoute.DELETE(request("DELETE", "/api/connectors/google"))).status).toBe(503);
    expect(db.grants).toHaveLength(1);
  });

  it("revokes in a form body, then deletes, and answers 204", async () => {
    const { tokens } = await seed();
    signInAs(ALICE);
    const response = await googleRoute.DELETE(request("DELETE", "/api/connectors/google"));
    expect(response.status).toBe(204);
    expect(db.grants).toHaveLength(0);
    expect(google.isLive(tokens.refresh)).toBe(false);
    const revoke = google.revokeRequests()[0]!;
    expect(revoke.url.search).toBe("");
    expect(revoke.body).toBe(new URLSearchParams({ token: tokens.refresh }).toString());
    expect(db.actionLog.map((e) => e.event)).toEqual(["connector_removed"]);
  });

  it("revokes a grant that needs reconnecting too", async () => {
    const { tokens } = await seed({ status: "needs_reconnect" });
    signInAs(ALICE);
    expect((await googleRoute.DELETE(request("DELETE", "/api/connectors/google"))).status).toBe(204);
    expect(google.isLive(tokens.refresh)).toBe(false);
  });

  it("still deletes when Google does not confirm, and says so", async () => {
    const { tokens } = await seed();
    google.revokeStatus = 503;
    signInAs(ALICE);
    const response = await googleRoute.DELETE(request("DELETE", "/api/connectors/google"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revoked: false });
    expect(db.grants).toHaveLength(0);
    expect(google.isLive(tokens.refresh)).toBe(true);
  });

  it("deletes without revoking when connectors are off, and answers 204 without a grant", async () => {
    await seed();
    useEnv({ CONNECTOR_TOKEN_KEYS: "" });
    signInAs(ALICE);
    const response = await googleRoute.DELETE(request("DELETE", "/api/connectors/google"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revoked: false });
    expect(google.revokeRequests()).toHaveLength(0);
    expect((await googleRoute.DELETE(request("DELETE", "/api/connectors/google"))).status).toBe(204);
  });

  it("does not touch another user's grant", async () => {
    const { tokens } = await seed();
    signInAs(BOB);
    expect((await googleRoute.DELETE(request("DELETE", "/api/connectors/google"))).status).toBe(204);
    expect(db.grants).toHaveLength(1);
    expect(google.isLive(tokens.refresh)).toBe(true);
  });
});

describe("GET /api/connectors/google/upcoming", () => {
  const upcoming = (tz: string | null) =>
    upcomingRoute.GET(request("GET", `/api/connectors/google/upcoming${tz === null ? "" : `?tz=${encodeURIComponent(tz)}`}`));

  it("answers 401 without a session", async () => {
    signOut();
    expect((await upcoming("UTC")).status).toBe(401);
  });

  it.each([[null], [""], ["Not/A_Zone"], ["../etc"], ["x".repeat(65)]])("answers 400 for tz %s", async (tz) => {
    signInAs(ALICE);
    expect((await upcoming(tz)).status).toBe(400);
  });

  it("answers 503 for a malformed setting and not_connected when connectors are off", async () => {
    signInAs(ALICE);
    useEnv({ CONNECTOR_TOKEN_KEY_VERSION: "7" });
    expect((await upcoming("UTC")).status).toBe(503);
    useEnv({ GOOGLE_CLIENT_ID: "" });
    expect(await (await upcoming("UTC")).json()).toEqual({ state: "not_connected" });
  });

  it("lists the next events, and reports needs_reconnect", async () => {
    await seed();
    google.events["primary-id@example.com"] = [
      { summary: "Lunch", start: { dateTime: "2026-10-21T12:00:00Z" }, end: { dateTime: "2026-10-21T13:00:00Z" } },
    ];
    signInAs(ALICE);
    const response = await upcoming("America/New_York");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      state: "ok",
      events: [{ title: "Lunch", start: "2026-10-21T12:00:00Z", end: "2026-10-21T13:00:00Z", allDay: false, calendar: "Alice", fromOthers: false }],
    });
    db.grants[0]!.status = "needs_reconnect";
    expect(await (await upcoming("UTC")).json()).toEqual({ state: "needs_reconnect" });
  });
});

// ---------------------------------------------------------------------------
// Write faults (AGENTS.md): every write the callback, DELETE and upcoming
// make, refused or lost, up to two faults.
// ---------------------------------------------------------------------------

function arm(faults: WriteFaults) {
  faults.wrap(db, ["write"], {
    label: "db",
    detail: (_method, args) => String(args[0]),
    failWith: (error) => ({ data: null, error: { message: error.message } }),
  });
  faults.wrap(google, ["tokenWrite", "revokeWrite"], {
    label: "google",
    failWith: () => new Response(JSON.stringify({ error: "backend_error" }), { status: 503 }),
  });
}

async function liveRows() {
  const rows = db.rowsFor(ALICE);
  return Promise.all(rows.map(async (row) => ({ row, live: google.isLive(await storedToken(row)) })));
}

describe("callback when writes fail", () => {
  async function scenario(variant: "first" | "same" | "other", faults: WriteFaults, sweepCase: SweepCase) {
    const at = `${variant}: ${describeCase(sweepCase)}`;
    fresh();
    const old = variant === "first" ? null : await seed({ account: variant === "same" ? ALICE_GOOGLE : ALICE_WORK_GOOGLE });
    const started = await startConnect();
    const approved = google.approve(started.url);
    const before = new Set(google.tokens.keys());
    arm(faults);
    const response = await callback(approved, started.cookie);
    faults.disarm();

    expect(response.status, at).toBe(303);
    expect(response.headers.get("set-cookie"), at).toContain("Max-Age=0");
    const location = response.headers.get("location");
    expect([CONNECTED, failedAt("storage_failed"), failedAt("exchange_failed")], at).toContain(location);
    const rows = await liveRows();
    expect(rows.length, at).toBeLessThanOrEqual(1);
    for (const { row, live } of rows) {
      expect(["active", "needs_reconnect"], at).toContain(row.status);
      // No row claims a grant that ended: an active row always holds a live refresh token.
      if (row.status === "active") expect(live, at).toBe(true);
    }
    const dbFaults = sweepCase.filter((f) => f.label.startsWith("db.")).length;
    const issued = [...google.tokens.keys()].filter((t) => !before.has(t) && t.startsWith("1//"));
    if (location === CONNECTED) {
      expect(rows, at).toHaveLength(1);
      expect(rows[0]!.row, at).toMatchObject({ account_sub: ALICE_GOOGLE.sub, status: "active" });
      expect(rows[0]!.live, at).toBe(true);
      if (variant === "other" && !hasFault(sweepCase, "refused", "google.revokeWrite")) {
        expect(google.isLive(old!.tokens.refresh), at).toBe(false);
      }
    } else if (old && (variant === "other" || location === failedAt("exchange_failed")) && dbFaults <= 1) {
      // A failed connection with at most one failed database write keeps the stored grant as it was.
      expect(rows.map(({ row, live }) => ({ id: row.id, sub: row.account_sub, status: row.status, live })), at).toEqual([
        { id: old.row.id, sub: old.row.account_sub, status: "active", live: true },
      ]);
    }
    if (location === failedAt("storage_failed") && !sweepCase.some((f) => f.label === "google.revokeWrite")) {
      // The token this exchange made is revoked unless a row holds it. The one exception: revoking it
      // would end the same account's working grant, and the write marking that grant failed as well.
      const held = new Set(await Promise.all(rows.map(({ row }) => storedToken(row))));
      for (const token of issued.filter((t) => google.isLive(t) && !held.has(t))) {
        expect(dbFaults, `${at}: ${token} kept`).toBe(2);
        expect(rows.some(({ row, live }) => row.status === "active" && row.account_sub === ALICE_GOOGLE.sub && live), at).toBe(true);
      }
    }

    // The user tries again with nothing failing: one active grant for the new account.
    const again = await connect();
    expect(again.headers.get("location"), `${at}: retry`).toBe(CONNECTED);
    const after = await liveRows();
    expect(after, `${at}: retry`).toHaveLength(1);
    expect(after[0]!.row, `${at}: retry`).toMatchObject({ account_sub: ALICE_GOOGLE.sub, status: "active" });
    expect(after[0]!.live, `${at}: retry`).toBe(true);
    for (const entry of db.actionLog) expect(Object.keys(entry.detail).sort(), at).toEqual(["grantId", "provider", "scopeCount", "status"]);
  }

  it.each([["first"], ["same"], ["other"]] as const)(
    "%s connection: every write and both faults keep one consistent grant",
    async (variant) => {
      const cases = await sweepWriteFaults((faults, sweepCase) => scenario(variant, faults, sweepCase));
      const labels = new Set(cases.map((c) => c.at(-1)!.label));
      expect(labels.has("google.tokenWrite")).toBe(true);
      expect(labels.has(variant === "same" ? "db.write:update" : "db.write:insert")).toBe(true);
    },
    // Each sweep runs the whole connect flow, with its key derivation and encryption, for every
    // fault case. Alone it takes well under a second; with every test file running at once on a
    // busy machine it can pass 5 s, and a test cut off by its timeout keeps running and changes
    // the shared fakes under the next test.
    SWEEP_TIMEOUT_MS,
  );
});

describe("DELETE when writes fail", () => {
  async function scenario(status: "active" | "needs_reconnect", faults: WriteFaults, sweepCase: SweepCase) {
    const at = `${status}: ${describeCase(sweepCase)}`;
    fresh();
    const { tokens } = await seed({ status });
    signInAs(ALICE);
    arm(faults);
    const first = await googleRoute.DELETE(request("DELETE", "/api/connectors/google"));
    faults.disarm();

    expect([204, 200, 500], at).toContain(first.status);
    if (first.status === 204) expect(google.isLive(tokens.refresh), at).toBe(false);
    if (first.status === 200) expect(await first.json(), at).toEqual({ revoked: false });
    if (first.status !== 500) expect(db.grants, at).toHaveLength(0);
    if (first.status === 500) {
      const retry = await googleRoute.DELETE(request("DELETE", "/api/connectors/google"));
      expect([204, 200], `${at}: retry`).toContain(retry.status);
    }
    expect(db.grants, at).toHaveLength(0);
    expect((await googleRoute.DELETE(request("DELETE", "/api/connectors/google"))).status, `${at}: again`).toBe(204);
    expect(db.actionLog.filter((e) => e.event === "connector_removed"), at).toHaveLength(1);
  }

  it.each([["active"], ["needs_reconnect"]] as const)(
    "%s grant: every write and both faults end with no grant",
    async (status) => {
      const cases = await sweepWriteFaults((faults, sweepCase) => scenario(status, faults, sweepCase));
      expect([...new Set(cases.map((c) => c.at(-1)!.label))].sort()).toEqual(["db.write:delete", "google.revokeWrite"]);
    },
    SWEEP_TIMEOUT_MS,
  );
});

describe("upcoming when writes fail", () => {
  async function scenario(revoked: boolean, faults: WriteFaults, sweepCase: SweepCase) {
    const at = `${revoked ? "revoked" : "expired"}: ${describeCase(sweepCase)}`;
    fresh();
    await seed({ accessExpiresAt: new Date(Date.now() + 10_000).toISOString() });
    if (revoked) google.refreshError = { status: 400, error: "invalid_grant" };
    signInAs(ALICE);
    arm(faults);
    const first = await upcomingRoute.GET(request("GET", "/api/connectors/google/upcoming?tz=UTC"));
    faults.disarm();

    expect(first.status, at).toBe(200);
    const body = (await first.json()) as { state: string };
    expect(revoked ? ["needs_reconnect"] : ["ok", "error"], at).toContain(body.state);
    const second = await upcomingRoute.GET(request("GET", "/api/connectors/google/upcoming?tz=UTC"));
    expect((await second.json()).state, `${at}: retry`).toBe(revoked ? "needs_reconnect" : "ok");
    expect(db.grants, at).toHaveLength(1);
    expect(db.grants[0]!.status, at).toBe(revoked ? "needs_reconnect" : "active");
  }

  it(
    "expired access token: every write and both faults answer a state and keep the grant usable",
    async () => {
      const cases = await sweepWriteFaults((faults, sweepCase) => scenario(false, faults, sweepCase));
      expect([...new Set(cases.map((c) => c.at(-1)!.label))].sort()).toEqual([
        "db.write:rpc.store_connector_tokens",
        "db.write:update",
        "google.tokenWrite",
      ]);
    },
    SWEEP_TIMEOUT_MS,
  );

  it(
    "revoked refresh token: every write and both faults end in needs_reconnect",
    async () => {
      const cases = await sweepWriteFaults((faults, sweepCase) => scenario(true, faults, sweepCase));
      expect([...new Set(cases.map((c) => c.at(-1)!.label))]).toEqual(["db.write:update"]);
    },
    SWEEP_TIMEOUT_MS,
  );
});
