import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { ConnectorGrantStatus, ConnectorProvider } from "@/types/connectors";
import { RepositoryError } from "./conversations";

/**
 * Connector grants (decision 0016). Every query runs as the signed-in user, so
 * RLS also limits it to their own row. The API roles cannot select or update a
 * ciphertext column: tokens are read through connector_grant_secrets and
 * written through store_connector_tokens. No method returns database error
 * text, and nothing here logs.
 */
export interface ConnectorGrantRow {
  id: string;
  provider: ConnectorProvider;
  accountSub: string;
  accountEmail: string;
  scopes: string[];
  accessExpiresAt: string | null;
  keyVersion: number;
  status: ConnectorGrantStatus;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorGrantSecrets {
  id: string;
  keyVersion: number;
  refreshCiphertext: Uint8Array;
  accessCiphertext: Uint8Array | null;
}

export interface NewConnectorGrant {
  provider: ConnectorProvider;
  accountSub: string;
  accountEmail: string;
  scopes: string[];
  keyVersion: number;
  refreshCiphertext: Uint8Array;
  accessCiphertext: Uint8Array | null;
  accessExpiresAt: string | null;
}

export interface StoredTokens {
  /** Null keeps the stored refresh token. */
  refreshCiphertext: Uint8Array | null;
  accessCiphertext: Uint8Array | null;
  accessExpiresAt: string | null;
  keyVersion: number;
}

export interface ReplacedGrant {
  grant: ConnectorGrantRow;
  /** The row that was there before, or null for a first connection. */
  previous: ConnectorGrantRow | null;
}

export interface ConnectorGrantRepository {
  /** Null when there is no grant, or when the table does not exist yet (migration not applied). */
  getGrant(userId: string, provider: ConnectorProvider): Promise<ConnectorGrantRow | null>;
  /**
   * Inserts the grant, or replaces the existing one for this provider. The
   * same Google account keeps its row; another account's row is deleted
   * first, because the account ID is not updatable. When that replacement
   * fails part way, the old row is put back as it was (best effort).
   */
  createOrReplaceGrant(userId: string, grant: NewConnectorGrant): Promise<ReplacedGrant>;
  /** Both ciphertexts of the caller's own row in any status, or null. */
  readSecrets(userId: string, grantId: string): Promise<ConnectorGrantSecrets | null>;
  /** Returns false when the row is gone. */
  storeTokens(userId: string, grantId: string, tokens: StoredTokens): Promise<boolean>;
  setStatus(userId: string, grantId: string, status: ConnectorGrantStatus): Promise<boolean>;
  touchLastUsed(userId: string, grantId: string, at: string): Promise<void>;
  deleteGrant(userId: string, grantId: string): Promise<boolean>;
}

/** Every selectable column. Never a ciphertext column. */
export const GRANT_COLUMNS =
  "id, provider, account_sub, account_email, scopes, access_token_expires_at, key_version, status, last_used_at, created_at, updated_at";

const grantRow = z.object({
  id: z.string(),
  provider: z.literal("google"),
  account_sub: z.string(),
  account_email: z.string(),
  scopes: z.array(z.string()),
  access_token_expires_at: z.string().nullable(),
  key_version: z.number().int(),
  status: z.enum(["active", "needs_reconnect"]),
  last_used_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const BYTEA_HEX = /^\\x((?:[0-9a-fA-F]{2})*)$/;

const secretsRow = z.object({
  id: z.string(),
  key_version: z.number().int(),
  refresh_token_ciphertext: z.string().regex(BYTEA_HEX),
  access_token_ciphertext: z.string().regex(BYTEA_HEX).nullable(),
});

/** PostgREST sends and returns bytea as `\x` followed by hex. */
export function toByteaHex(bytes: Uint8Array): string {
  let hex = "\\x";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export function fromByteaHex(value: string): Uint8Array | null {
  const match = BYTEA_HEX.exec(value);
  if (!match) return null;
  const hex = match[1] ?? "";
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

const MISSING_TABLE = new Map<string, RegExp>([
  ["42P01", /^relation "(?:public\.)?connector_grants" does not exist$/],
  ["PGRST205", /^Could not find the table '(?:public\.)?connector_grants' in the schema cache$/],
]);

/** True only for "table connector_grants does not exist" (the migration is not applied yet). */
export function isMissingGrantsTable(error: { code?: string; message?: string } | null): boolean {
  const pattern = error?.code ? MISSING_TABLE.get(error.code) : undefined;
  return pattern !== undefined && pattern.test((error?.message ?? "").trim());
}

function toGrant(row: unknown, operation: string): ConnectorGrantRow {
  const parsed = grantRow.safeParse(row);
  if (!parsed.success) throw new RepositoryError(operation);
  const r = parsed.data;
  return {
    id: r.id,
    provider: r.provider,
    accountSub: r.account_sub,
    accountEmail: r.account_email,
    scopes: r.scopes,
    accessExpiresAt: r.access_token_expires_at,
    keyVersion: r.key_version,
    status: r.status,
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function createConnectorGrantRepository(supabase: SupabaseClient): ConnectorGrantRepository {
  const table = () => supabase.from("connector_grants");

  async function getGrant(userId: string, provider: ConnectorProvider): Promise<ConnectorGrantRow | null> {
    const { data, error } = await table()
      .select(GRANT_COLUMNS)
      .eq("user_id", userId)
      .eq("provider", provider)
      .maybeSingle();
    if (error) {
      if (isMissingGrantsTable(error)) return null;
      throw new RepositoryError("getConnectorGrant");
    }
    return data ? toGrant(data, "getConnectorGrant") : null;
  }

  async function storeTokens(userId: string, grantId: string, tokens: StoredTokens): Promise<boolean> {
    // The function limits the write to auth.uid(), the signed-in user that userId names, so it is not sent.
    void userId;
    const { data, error } = await supabase.rpc("store_connector_tokens", {
      p_id: grantId,
      p_refresh: tokens.refreshCiphertext ? toByteaHex(tokens.refreshCiphertext) : null,
      p_access: tokens.accessCiphertext ? toByteaHex(tokens.accessCiphertext) : null,
      p_expires: tokens.accessExpiresAt,
      p_key_version: tokens.keyVersion,
    });
    if (error || typeof data !== "boolean") throw new RepositoryError("storeConnectorTokens");
    return data;
  }

  async function insertGrant(userId: string, grant: NewConnectorGrant): Promise<ConnectorGrantRow | "exists"> {
    const { data, error } = await table()
      .insert({
        user_id: userId,
        provider: grant.provider,
        account_sub: grant.accountSub,
        account_email: grant.accountEmail,
        scopes: grant.scopes,
        refresh_token_ciphertext: toByteaHex(grant.refreshCiphertext),
        access_token_ciphertext: grant.accessCiphertext ? toByteaHex(grant.accessCiphertext) : null,
        access_token_expires_at: grant.accessExpiresAt,
        key_version: grant.keyVersion,
        status: "active",
      })
      .select(GRANT_COLUMNS)
      .single();
    // Another request inserted the row first.
    if (error?.code === "23505") return "exists";
    if (error || !data) throw new RepositoryError("insertConnectorGrant");
    return toGrant(data, "insertConnectorGrant");
  }

  async function deleteGrant(userId: string, grantId: string): Promise<boolean> {
    const { count, error } = await table().delete({ count: "exact" }).eq("id", grantId).eq("user_id", userId);
    if (error) throw new RepositoryError("deleteConnectorGrant");
    return (count ?? 0) > 0;
  }

  async function readSecrets(userId: string, grantId: string): Promise<ConnectorGrantSecrets | null> {
    // As in storeTokens: the function reads only auth.uid()'s row.
    void userId;
    const { data, error } = await supabase.rpc("connector_grant_secrets", { p_id: grantId });
    if (error || !Array.isArray(data)) throw new RepositoryError("readConnectorSecrets");
    if (data.length === 0) return null;
    const parsed = secretsRow.safeParse(data[0]);
    if (!parsed.success) throw new RepositoryError("readConnectorSecrets");
    const refresh = fromByteaHex(parsed.data.refresh_token_ciphertext);
    const access =
      parsed.data.access_token_ciphertext === null ? null : fromByteaHex(parsed.data.access_token_ciphertext);
    if (!refresh || (parsed.data.access_token_ciphertext !== null && !access)) {
      throw new RepositoryError("readConnectorSecrets");
    }
    return { id: parsed.data.id, keyVersion: parsed.data.key_version, refreshCiphertext: refresh, accessCiphertext: access };
  }

  /** Puts a deleted row back as it was, unless a row has taken its place. Best effort: never throws. */
  async function restoreGrant(userId: string, old: ConnectorGrantRow, secrets: ConnectorGrantSecrets): Promise<void> {
    try {
      if (await getGrant(userId, old.provider)) return;
      // The ciphertexts are bound to the user, provider, account and key version, not the row, so they still decrypt.
      await table().insert({
        id: old.id,
        user_id: userId,
        provider: old.provider,
        account_sub: old.accountSub,
        account_email: old.accountEmail,
        scopes: old.scopes,
        refresh_token_ciphertext: toByteaHex(secrets.refreshCiphertext),
        access_token_ciphertext: secrets.accessCiphertext ? toByteaHex(secrets.accessCiphertext) : null,
        access_token_expires_at: old.accessExpiresAt,
        key_version: secrets.keyVersion,
        status: old.status,
        last_used_at: old.lastUsedAt,
        created_at: old.createdAt,
      });
    } catch {
      // The caller reports the first failure.
    }
  }

  /**
   * Another account replaces `old`: (user_id, provider) is unique and the
   * account ID is not updatable, so the old row is deleted, then the new one
   * inserted. PostgREST cannot run both in one transaction, so when either
   * write fails the old row is put back, and one failed write does not end
   * a grant that worked.
   */
  async function replaceAccount(
    userId: string,
    old: ConnectorGrantRow,
    grant: NewConnectorGrant,
  ): Promise<ConnectorGrantRow | "exists"> {
    let kept: ConnectorGrantSecrets | null = null;
    try {
      kept = await readSecrets(userId, old.id);
    } catch {
      // Without them the old row cannot be put back; the replacement still goes ahead.
    }
    try {
      await deleteGrant(userId, old.id);
      return await insertGrant(userId, grant);
    } catch (error) {
      if (kept) await restoreGrant(userId, old, kept);
      throw error;
    }
  }

  return {
    getGrant,

    async createOrReplaceGrant(userId, grant) {
      let previous = await getGrant(userId, grant.provider);
      if (!previous || previous.accountSub !== grant.accountSub) {
        const inserted = previous ? await replaceAccount(userId, previous, grant) : await insertGrant(userId, grant);
        if (inserted !== "exists") return { grant: inserted, previous };
        // Another request inserted the row first.
        const current = await getGrant(userId, grant.provider);
        if (!current || current.accountSub !== grant.accountSub) throw new RepositoryError("insertConnectorGrant");
        previous = current;
      }

      // The same account: the tokens first, then the visible columns with
      // status active. So the row says active with new scopes only once the
      // tokens are stored; a row that was needs_reconnect never claims to
      // work with its old, dead token.
      const stored = await storeTokens(userId, previous.id, {
        refreshCiphertext: grant.refreshCiphertext,
        accessCiphertext: grant.accessCiphertext,
        accessExpiresAt: grant.accessExpiresAt,
        keyVersion: grant.keyVersion,
      });
      if (!stored) throw new RepositoryError("storeConnectorTokens");
      const { data, error } = await table()
        .update({ account_email: grant.accountEmail, scopes: grant.scopes, status: "active" })
        .eq("id", previous.id)
        .eq("user_id", userId)
        .select(GRANT_COLUMNS)
        .maybeSingle();
      if (error || !data) throw new RepositoryError("updateConnectorGrant");
      return { grant: toGrant(data, "updateConnectorGrant"), previous };
    },

    readSecrets,

    storeTokens,

    async setStatus(userId, grantId, status) {
      const { data, error } = await table()
        .update({ status })
        .eq("id", grantId)
        .eq("user_id", userId)
        .select("id")
        .maybeSingle();
      if (error) throw new RepositoryError("setConnectorStatus");
      return data !== null;
    },

    async touchLastUsed(userId, grantId, at) {
      const { error } = await table().update({ last_used_at: at }).eq("id", grantId).eq("user_id", userId);
      if (error) throw new RepositoryError("touchConnectorGrant");
    },

    deleteGrant,
  };
}
