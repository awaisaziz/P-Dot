import "server-only";
import { ConfigError } from "@/lib/supabase-config";
import { getSiteUrl } from "@/server/config";
import { base64Decode } from "./crypto";

// Connector settings (decision 0016, amendments of 2026-10-21). Read per call,
// like src/server/config.ts. A missing client ID, client secret or key set
// turns connectors off (null); a malformed value is an operator error and
// throws a ConfigError that names the variable, never its value.
//
// GOOGLE_CLIENT_ID, CONNECTOR_TOKEN_KEY_VERSION and CONNECTOR_ALLOWED_USER_IDS
// are plain variables. GOOGLE_CLIENT_SECRET and CONNECTOR_TOKEN_KEYS are
// Worker secrets and are never set for previews, which share the database.

export interface ConnectorConfig {
  google: {
    clientId: string;
    clientSecret: string;
    /** `${SITE_URL}/api/connectors/google/callback` */
    redirectUri: string;
  };
  /** Raw 32-byte key material by version. Only crypto.ts reads it. */
  keys: ReadonlyMap<number, Uint8Array>;
  /** The version new tokens and state cookies use. Always a key in `keys`. */
  keyVersion: number;
  /** "*" allows every signed-in user; an empty set allows nobody. */
  allowedUserIds: "*" | ReadonlySet<string>;
  /** SITE_URL without a trailing slash. */
  siteUrl: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLIENT_ID = /^[A-Za-z0-9._-]{1,256}$/;
const MAX_KEY_VERSION = 32767; // smallint

function blank(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

function parseKeys(raw: string): Map<number, Uint8Array> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(["CONNECTOR_TOKEN_KEYS"]);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ConfigError(["CONNECTOR_TOKEN_KEYS"]);
  const keys = new Map<number, Uint8Array>();
  for (const [name, value] of Object.entries(parsed)) {
    const version = /^[1-9][0-9]{0,4}$/.test(name) ? Number(name) : Number.NaN;
    const bytes = typeof value === "string" ? base64Decode(value) : null;
    if (!Number.isInteger(version) || version > MAX_KEY_VERSION || !bytes || bytes.length !== 32) {
      throw new ConfigError(["CONNECTOR_TOKEN_KEYS"]);
    }
    keys.set(version, bytes);
  }
  if (keys.size === 0) throw new ConfigError(["CONNECTOR_TOKEN_KEYS"]);
  return keys;
}

function parseAllowList(raw: string | undefined): "*" | ReadonlySet<string> {
  if (raw === undefined) return new Set();
  if (raw === "*") return "*";
  const ids = raw
    .split(",")
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean);
  if (!ids.every((id) => UUID.test(id))) throw new ConfigError(["CONNECTOR_ALLOWED_USER_IDS"]);
  return new Set(ids);
}

/** The connector settings, or null when connectors are off. Throws ConfigError for a malformed value. */
export function getConnectorConfig(env: NodeJS.ProcessEnv = process.env): ConnectorConfig | null {
  const clientId = blank(env.GOOGLE_CLIENT_ID);
  const clientSecret = blank(env.GOOGLE_CLIENT_SECRET);
  const rawKeys = blank(env.CONNECTOR_TOKEN_KEYS);
  if (!clientId || !clientSecret || !rawKeys) return null;

  const invalid: string[] = [];
  if (!CLIENT_ID.test(clientId)) invalid.push("GOOGLE_CLIENT_ID");
  if (clientSecret.length > 512 || /\s/.test(clientSecret)) invalid.push("GOOGLE_CLIENT_SECRET");
  if (invalid.length > 0) throw new ConfigError(invalid);

  const keys = parseKeys(rawKeys);
  const rawVersion = blank(env.CONNECTOR_TOKEN_KEY_VERSION) ?? "1";
  const keyVersion = /^[1-9][0-9]{0,4}$/.test(rawVersion) ? Number(rawVersion) : Number.NaN;
  if (!keys.has(keyVersion)) throw new ConfigError(["CONNECTOR_TOKEN_KEY_VERSION"]);

  const allowedUserIds = parseAllowList(blank(env.CONNECTOR_ALLOWED_USER_IDS));

  const siteUrl = getSiteUrl(env);
  let site: URL;
  try {
    site = new URL(siteUrl);
  } catch {
    throw new ConfigError(["SITE_URL"]);
  }
  if (site.protocol !== "https:" && site.protocol !== "http:") throw new ConfigError(["SITE_URL"]);

  return {
    google: {
      clientId,
      clientSecret,
      redirectUri: new URL("/api/connectors/google/callback", `${site.origin}/`).toString(),
    },
    keys,
    keyVersion,
    allowedUserIds,
    siteUrl: site.origin,
  };
}

/** Whether this user may connect and use Google (until Zero Data Retention is confirmed on Nebius). */
export function isConnectorUserAllowed(config: ConnectorConfig, userId: string): boolean {
  if (config.allowedUserIds === "*") return true;
  return config.allowedUserIds.has(userId.toLowerCase());
}

/** The host of SITE_URL, for example "pdot.example.com". */
export function siteHost(config: ConnectorConfig): string {
  return new URL(config.siteUrl).host;
}
