import "server-only";

// Token encryption and the OAuth state cookie (decision 0016, amendments of
// 2026-10-21). WebCrypto only, so it runs the same in Node 22 and Workers.
//
// Each key version's 32 raw bytes go through HKDF-SHA256 into two
// non-extractable keys: AES-GCM 256 for tokens ("pdot/connector-token/v<k>")
// and HMAC-SHA256 for the state cookie ("pdot/oauth-state/v<k>"). A stored
// token is key_version (2 bytes, big endian) || IV (12 bytes) || AES-GCM
// ciphertext and tag. The additional data binds it to the user, provider,
// account, purpose and key version, so a ciphertext copied to another row,
// user or purpose does not decrypt. Errors never carry key or token bytes.

export type TokenPurpose = "refresh" | "access";

export interface TokenBinding {
  userId: string;
  provider: "google";
  accountSub: string;
  purpose: TokenPurpose;
}

export type TokenCryptoErrorKind = "unknown_key_version" | "malformed" | "decrypt_failed";

export class TokenCryptoError extends Error {
  constructor(readonly kind: TokenCryptoErrorKind) {
    super(`Connector token could not be read: ${kind}`);
    this.name = "TokenCryptoError";
  }
}

const IV_BYTES = 12;
const VERSION_BYTES = 2;
const TAG_BYTES = 16;
const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Base64 helpers (atob/btoa exist in Node 22 and Workers).
// ---------------------------------------------------------------------------

function toBinary(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return binary;
}

function fromBinary(binary: string): Uint8Array {
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Standard base64 (padding optional) to bytes, or null when it is not base64. */
export function base64Decode(value: string): Uint8Array | null {
  const text = value.trim();
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.replace(/=+$/, "").length % 4 === 1) return null;
  try {
    return fromBinary(atob(text));
  } catch {
    return null;
  }
}

export function base64UrlEncode(bytes: Uint8Array): string {
  return btoa(toBinary(bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Unpadded base64url to bytes, or null when the text is not base64url. */
export function base64UrlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  try {
    return fromBinary(atob(padded));
  } catch {
    return null;
  }
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** WebCrypto wants an ArrayBuffer-backed view; copy to be sure. */
function buffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

interface DerivedKeys {
  token: CryptoKey;
  state: CryptoKey;
}

export interface Keyring {
  /** The version new ciphertexts and cookies use. */
  readonly currentVersion: number;
  has(version: number): boolean;
  /** Derived keys for a version, or null when the version is unknown. */
  keys(version: number): Promise<DerivedKeys | null>;
}

async function deriveKeys(raw: Uint8Array, version: number): Promise<DerivedKeys> {
  const base = await crypto.subtle.importKey("raw", buffer(raw), "HKDF", false, ["deriveKey"]);
  // An empty salt is allowed by RFC 5869; the key material is already uniform random bytes.
  const hkdf = (info: string) => ({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode(info) });
  const [token, state] = await Promise.all([
    crypto.subtle.deriveKey(hkdf(`pdot/connector-token/v${version}`), base, { name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]),
    crypto.subtle.deriveKey(hkdf(`pdot/oauth-state/v${version}`), base, { name: "HMAC", hash: "SHA-256", length: 256 }, false, [
      "sign",
      "verify",
    ]),
  ]);
  return { token, state };
}

/** Derives keys lazily, once per version, for one request. */
export function createKeyring(config: { keys: ReadonlyMap<number, Uint8Array>; keyVersion: number }): Keyring {
  const cache = new Map<number, Promise<DerivedKeys>>();
  return {
    currentVersion: config.keyVersion,
    has: (version) => config.keys.has(version),
    async keys(version) {
      const raw = config.keys.get(version);
      if (!raw) return null;
      let derived = cache.get(version);
      if (!derived) {
        derived = deriveKeys(raw, version);
        cache.set(version, derived);
      }
      return derived;
    },
  };
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/** `pdot.connector.v1|<user_id>|google|<account_sub>|<refresh|access>|<key_version>` */
export function tokenAdditionalData(binding: TokenBinding, keyVersion: number): string {
  return `pdot.connector.v1|${binding.userId}|${binding.provider}|${binding.accountSub}|${binding.purpose}|${keyVersion}`;
}

/** Encrypts a token with the current key version and a fresh 12-byte IV. */
export async function encryptToken(keyring: Keyring, plaintext: string, binding: TokenBinding): Promise<Uint8Array> {
  const version = keyring.currentVersion;
  const keys = await keyring.keys(version);
  if (!keys) throw new TokenCryptoError("unknown_key_version");
  const iv = randomBytes(IV_BYTES);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: buffer(iv), additionalData: encoder.encode(tokenAdditionalData(binding, version)) },
      keys.token,
      encoder.encode(plaintext),
    ),
  );
  const out = new Uint8Array(VERSION_BYTES + IV_BYTES + sealed.length);
  out[0] = (version >> 8) & 0xff;
  out[1] = version & 0xff;
  out.set(iv, VERSION_BYTES);
  out.set(sealed, VERSION_BYTES + IV_BYTES);
  return out;
}

/** The key version a stored ciphertext names, or null when it is too short. */
export function ciphertextKeyVersion(stored: Uint8Array): number | null {
  if (stored.length < VERSION_BYTES + IV_BYTES + TAG_BYTES) return null;
  return ((stored[0] ?? 0) << 8) | (stored[1] ?? 0);
}

/** Decrypts a stored token. Throws TokenCryptoError, never with key or token bytes. */
export async function decryptToken(keyring: Keyring, stored: Uint8Array, binding: TokenBinding): Promise<string> {
  const version = ciphertextKeyVersion(stored);
  if (version === null) throw new TokenCryptoError("malformed");
  const keys = await keyring.keys(version);
  if (!keys) throw new TokenCryptoError("unknown_key_version");
  try {
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: buffer(stored.subarray(VERSION_BYTES, VERSION_BYTES + IV_BYTES)),
        additionalData: encoder.encode(tokenAdditionalData(binding, version)),
      },
      keys.token,
      buffer(stored.subarray(VERSION_BYTES + IV_BYTES)),
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(plain);
  } catch {
    throw new TokenCryptoError("decrypt_failed");
  }
}

// ---------------------------------------------------------------------------
// OAuth state cookie: base64url(JSON payload) "." base64url(HMAC-SHA256)
// ---------------------------------------------------------------------------

export interface OAuthStatePayload {
  v: 1;
  uid: string;
  /** 32 random bytes, base64url. */
  state: string;
  /** PKCE code verifier. */
  verifier: string;
  /** Issued at, seconds since the epoch. */
  iat: number;
}

/** The cookie lives 10 minutes. */
export const STATE_MAX_AGE_SECONDS = 600;
/** Clock skew allowed between Worker instances. */
const STATE_FUTURE_SKEW_SECONDS = 30;
const MAX_COOKIE_CHARS = 1024;

export async function signState(keyring: Keyring, payload: OAuthStatePayload): Promise<string> {
  const keys = await keyring.keys(keyring.currentVersion);
  if (!keys) throw new TokenCryptoError("unknown_key_version");
  const body = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", keys.state, encoder.encode(body)));
  return `${body}.${base64UrlEncode(signature)}`;
}

function isStatePayload(value: unknown): value is OAuthStatePayload {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return (
    p.v === 1 &&
    typeof p.uid === "string" &&
    p.uid.length > 0 &&
    p.uid.length <= 64 &&
    typeof p.state === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(p.state) &&
    typeof p.verifier === "string" &&
    isPkceVerifier(p.verifier) &&
    typeof p.iat === "number" &&
    Number.isSafeInteger(p.iat)
  );
}

/**
 * Checks the signature (crypto.subtle.verify), the shape and the age.
 * Returns the payload, or null for anything wrong. The caller still compares
 * `uid` and `state`.
 */
export async function verifyState(
  keyring: Keyring,
  cookie: string | null | undefined,
  nowMs: number,
): Promise<OAuthStatePayload | null> {
  if (!cookie || cookie.length > MAX_COOKIE_CHARS) return null;
  const [body, signature, extra] = cookie.split(".");
  if (!body || !signature || extra !== undefined) return null;
  const signatureBytes = base64UrlDecode(signature);
  const keys = await keyring.keys(keyring.currentVersion);
  if (!signatureBytes || !keys) return null;
  const valid = await crypto.subtle.verify("HMAC", keys.state, buffer(signatureBytes), encoder.encode(body));
  if (!valid) return null;
  const json = base64UrlDecode(body);
  if (!json) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(json));
  } catch {
    return null;
  }
  if (!isStatePayload(payload)) return null;
  const age = Math.floor(nowMs / 1000) - payload.iat;
  if (age > STATE_MAX_AGE_SECONDS || age < -STATE_FUTURE_SKEW_SECONDS) return null;
  return payload;
}

/** 32 random bytes, base64url (43 characters). */
export function randomState(): string {
  return base64UrlEncode(randomBytes(32));
}

/** Compares two strings without stopping at the first difference. */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// PKCE (RFC 7636)
// ---------------------------------------------------------------------------

const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

export function isPkceVerifier(value: string): boolean {
  return PKCE_VERIFIER.test(value);
}

/** 48 random bytes, base64url: 64 characters from the unreserved set. */
export function createPkceVerifier(): string {
  return base64UrlEncode(randomBytes(48));
}

/** S256: base64url(SHA-256(ASCII(verifier))), unpadded. */
export async function pkceChallenge(verifier: string): Promise<string> {
  if (!isPkceVerifier(verifier)) throw new Error("Invalid PKCE verifier");
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}
