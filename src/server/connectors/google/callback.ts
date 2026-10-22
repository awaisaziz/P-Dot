import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { createConnectorGrantRepository, type ConnectorGrantRow } from "@/server/db/connector-grants";
import { logEvent } from "@/server/log";
import type { ConnectorErrorCode } from "@/types/connectors";
import { isConnectorUserAllowed, type ConnectorConfig } from "../config";
import {
  createKeyring,
  decryptToken,
  encryptToken,
  timingSafeEqual,
  verifyState,
  type Keyring,
  type TokenBinding,
} from "../crypto";
import { exchangeCode, revokeToken, type ExchangedGrant, type GoogleAccount } from "./oauth";
import { hasToolScope } from "./scopes";

// The end of the Google OAuth flow (decision 0016, amendments of 2026-10-21):
// check the state cookie, exchange the code, store the encrypted tokens.
// Every failure ends in one code from the closed set; Google's own error text
// is never passed on or logged. A token that cannot be stored is revoked.
//
// Revoking any token ends the account's whole grant for this client, so a
// revoke can also end the grant stored for the same account. That row is
// marked needs_reconnect before the revoke, so it never claims to work.

export type CallbackResult =
  | {
      ok: true;
      /** Set when another account's grant was replaced: false when its token could not be revoked, so it may still be live at Google. */
      oldAccountRevoked?: boolean;
    }
  | { ok: false; code: ConnectorErrorCode };

const callbackParams = z.object({
  code: z
    .string()
    .min(1)
    .max(2048)
    .regex(/^[\x21-\x7e]+$/)
    .optional(),
  state: z.string().min(1).max(256).optional(),
  error: z.string().max(256).optional(),
});

/** Google's `error` values that have their own code. Anything else is exchange_failed. */
const GOOGLE_ERRORS = new Map<string, ConnectorErrorCode>([
  ["access_denied", "denied"],
  ["admin_policy_enforced", "admin_blocked"],
  ["org_internal", "not_a_tester"],
]);

export interface CallbackInput {
  userId: string;
  supabase: SupabaseClient;
  config: ConnectorConfig;
  params: URLSearchParams;
  cookie: string | null;
  requestId: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** The value of a parameter sent once; "" when it was sent more than once. */
function single(params: URLSearchParams, name: string): string | undefined {
  const values = params.getAll(name);
  return values.length === 1 ? values[0] : values.length === 0 ? undefined : "";
}

export async function completeGoogleConnection(input: CallbackInput): Promise<CallbackResult> {
  const { userId, config } = input;
  const now = input.now ?? Date.now;
  const google = { fetchImpl: input.fetchImpl };
  const repo = createConnectorGrantRepository(input.supabase);
  const keyring = createKeyring(config);

  // Set when a token this request got was left unrevoked, because revoking it would end a stored grant still marked active.
  let newTokenKept = false;
  const result = await run();
  const oldAccountRevoked = result.ok ? result.oldAccountRevoked : undefined;
  logEvent(result.ok && oldAccountRevoked !== false ? "info" : "warn", "connector_callback", {
    requestId: input.requestId,
    provider: "google",
    outcome: result.ok ? "connected" : result.code,
    ...(oldAccountRevoked === undefined ? {} : { oldAccountRevoked }),
    ...(newTokenKept ? { newTokenKept } : {}),
  });
  return result;

  /**
   * Revokes a token this request got. The revoke ends the account's whole
   * grant, so a stored active row of the same account is marked
   * needs_reconnect first. If that write is refused the token is kept: the
   * stored grant still works, and a row must never claim a grant that ended.
   */
  async function revokeNew(token: string, sub: string): Promise<void> {
    let current: ConnectorGrantRow | null = null;
    try {
      current = await repo.getGrant(userId, "google");
    } catch {
      // Unknown: revoke anyway. A same-account grant left active fails on its first use and is marked then.
    }
    if (current && current.accountSub === sub && current.status === "active" && !(await markNeedsReconnect(current))) {
      newTokenKept = true;
      return;
    }
    await revokeToken(token, google);
  }

  /** True once the row no longer says active (or is gone). */
  async function markNeedsReconnect(row: ConnectorGrantRow): Promise<boolean> {
    try {
      await repo.setStatus(userId, row.id, "needs_reconnect");
      return true;
    } catch {
      // The write may have landed and only the answer was lost: read it back.
      try {
        const after = await repo.getGrant(userId, "google");
        return !after || after.id !== row.id || after.status !== "active";
      } catch {
        return false;
      }
    }
  }

  async function run(): Promise<CallbackResult> {
    const payload = await verifyState(keyring, input.cookie, now());
    const parsed = callbackParams.safeParse({
      code: single(input.params, "code"),
      state: single(input.params, "state"),
      error: single(input.params, "error"),
    });
    if (!payload || payload.uid !== userId || !parsed.success || !parsed.data.state) {
      return { ok: false, code: "state_mismatch" };
    }
    if (!timingSafeEqual(parsed.data.state, payload.state)) return { ok: false, code: "state_mismatch" };
    if (parsed.data.error !== undefined) {
      return { ok: false, code: GOOGLE_ERRORS.get(parsed.data.error) ?? "exchange_failed" };
    }
    if (!isConnectorUserAllowed(config, userId)) return { ok: false, code: "denied" };
    if (!parsed.data.code) return { ok: false, code: "exchange_failed" };

    let exchanged: ExchangedGrant;
    try {
      exchanged = await exchangeCode(config.google, { code: parsed.data.code, verifier: payload.verifier }, google);
    } catch {
      return { ok: false, code: "exchange_failed" };
    }
    const account = exchanged.account;
    if (!account) {
      // Google issued tokens but the ID token is missing or unreadable, so they cannot be stored. The account
      // is unknown, so a stored grant of the same account cannot be marked; it fails on its first use and is marked then.
      await revokeToken(exchanged.refreshToken ?? exchanged.accessToken, google);
      return { ok: false, code: "exchange_failed" };
    }
    if (!exchanged.refreshToken) {
      // access_type=offline with prompt=consent always returns one; without it nothing can be stored.
      await revokeNew(exchanged.accessToken, account.sub);
      return { ok: false, code: "exchange_failed" };
    }
    if (!hasToolScope(exchanged.scopes)) {
      await revokeNew(exchanged.refreshToken, account.sub);
      return { ok: false, code: "scopes_missing" };
    }
    return store(exchanged, account, exchanged.refreshToken);
  }

  async function store(exchanged: ExchangedGrant, account: GoogleAccount, refreshToken: string): Promise<CallbackResult> {
    const sub = account.sub;
    const binding = (accountSub: string, purpose: TokenBinding["purpose"]): TokenBinding => ({
      userId,
      provider: "google",
      accountSub,
      purpose,
    });

    let existing: ConnectorGrantRow | null = null;
    let replacing = false;
    let previousRefresh: string | null = null;
    try {
      existing = await repo.getGrant(userId, "google");
      replacing = existing !== null && existing.accountSub !== sub;
      if (existing && replacing) {
        // Another Google account replaces this one. Read its token now, to revoke it once the new grant is stored.
        // Null when it cannot be read or decrypted; the result then says the old account was not revoked.
        previousRefresh = await readRefresh(keyring, existing);
      }
      const [refreshCiphertext, accessCiphertext] = await Promise.all([
        encryptToken(keyring, refreshToken, binding(sub, "refresh")),
        encryptToken(keyring, exchanged.accessToken, binding(sub, "access")),
      ]);
      await repo.createOrReplaceGrant(userId, {
        provider: "google",
        accountSub: sub,
        accountEmail: account.email,
        scopes: exchanged.scopes,
        keyVersion: keyring.currentVersion,
        refreshCiphertext,
        accessCiphertext,
        accessExpiresAt: new Date(now() + exchanged.expiresInSeconds * 1000).toISOString(),
      });
    } catch {
      if (!(await landed(account, exchanged.scopes, refreshToken))) {
        await revokeNew(refreshToken, sub);
        if (previousRefresh) await revokeIfOrphaned(previousRefresh, existing);
        return { ok: false, code: "storage_failed" };
      }
    }
    // The same account keeps its grant at Google: revoking its old token would end the new one too.
    if (!replacing) return { ok: true };
    return { ok: true, oldAccountRevoked: previousRefresh ? await revokeToken(previousRefresh, google) : false };
  }

  async function readRefresh(ring: Keyring, row: ConnectorGrantRow): Promise<string | null> {
    try {
      const secrets = await repo.readSecrets(userId, row.id);
      if (!secrets) return null;
      return await decryptToken(ring, secrets.refreshCiphertext, {
        userId,
        provider: "google",
        accountSub: row.accountSub,
        purpose: "refresh",
      });
    } catch {
      return null;
    }
  }

  /** After an error: did every part of the new grant get stored anyway (only the answer was lost)? */
  async function landed(account: GoogleAccount, scopes: string[], refreshToken: string): Promise<boolean> {
    try {
      const row = await repo.getGrant(userId, "google");
      if (!row || row.accountSub !== account.sub || row.status !== "active" || row.accountEmail !== account.email) return false;
      if (row.scopes.length !== scopes.length || row.scopes.some((scope, i) => scope !== scopes[i])) return false;
      return (await readRefresh(keyring, row)) === refreshToken;
    } catch {
      return false;
    }
  }

  /** The replaced account's row is gone, so nothing holds its token any more: revoke it. */
  async function revokeIfOrphaned(token: string, previous: ConnectorGrantRow | null): Promise<void> {
    try {
      const current = await repo.getGrant(userId, "google");
      if (current && current.accountSub === previous?.accountSub) return;
    } catch {
      return;
    }
    await revokeToken(token, google);
  }
}
