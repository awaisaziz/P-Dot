import { describe, expect, it } from "vitest";
import { ConfigError } from "@/lib/supabase-config";
import { getConnectorConfig, isConnectorUserAllowed } from "@/server/connectors/config";
import {
  base64Decode,
  base64UrlDecode,
  base64UrlEncode,
  ciphertextKeyVersion,
  createKeyring,
  createPkceVerifier,
  decryptToken,
  encryptToken,
  isPkceVerifier,
  pkceChallenge,
  randomState,
  signState,
  timingSafeEqual,
  tokenAdditionalData,
  TokenCryptoError,
  verifyState,
  type OAuthStatePayload,
  type TokenBinding,
} from "@/server/connectors/crypto";
import { connectorEnv, testConnectorConfig, testKey } from "../support/connector-fakes";

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN = "1//refresh-token-value-0123456789";
const binding: TokenBinding = { userId: ALICE, provider: "google", accountSub: "sub-1", purpose: "refresh" };

const keyringFor = (keys: Record<string, string>, version = "1") =>
  createKeyring(testConnectorConfig({ CONNECTOR_TOKEN_KEYS: JSON.stringify(keys), CONNECTOR_TOKEN_KEY_VERSION: version }));

async function cryptoError(run: () => Promise<unknown>): Promise<TokenCryptoError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof TokenCryptoError) return error;
    throw error;
  }
  throw new Error("expected a TokenCryptoError");
}

describe("connector config", () => {
  const env = (overrides: Record<string, string | undefined> = {}) => connectorEnv(overrides) as NodeJS.ProcessEnv;

  it("is off (null) when the client ID, secret or keys are missing", () => {
    expect(getConnectorConfig(env({ GOOGLE_CLIENT_ID: undefined }))).toBeNull();
    expect(getConnectorConfig(env({ GOOGLE_CLIENT_SECRET: "  " }))).toBeNull();
    expect(getConnectorConfig(env({ CONNECTOR_TOKEN_KEYS: "" }))).toBeNull();
    expect(getConnectorConfig({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("reads keys, the key version, the allow list and the redirect URI", () => {
    const config = getConnectorConfig(
      env({
        CONNECTOR_TOKEN_KEYS: JSON.stringify({ "1": testKey(1), "2": testKey(2) }),
        CONNECTOR_TOKEN_KEY_VERSION: "2",
        CONNECTOR_ALLOWED_USER_IDS: ` ${ALICE.toUpperCase()} ,`,
        SITE_URL: "https://pdot.test/",
      }),
    );
    expect(config).not.toBeNull();
    expect(config!.keyVersion).toBe(2);
    expect([...config!.keys.keys()]).toEqual([1, 2]);
    expect(config!.keys.get(2)).toHaveLength(32);
    expect(config!.google.redirectUri).toBe("https://pdot.test/api/connectors/google/callback");
    expect(config!.siteUrl).toBe("https://pdot.test");
    expect(isConnectorUserAllowed(config!, ALICE)).toBe(true);
    expect(isConnectorUserAllowed(config!, BOB)).toBe(false);
  });

  it("defaults the key version to 1 and allows nobody without an allow list", () => {
    const config = getConnectorConfig(env({ CONNECTOR_TOKEN_KEY_VERSION: undefined, CONNECTOR_ALLOWED_USER_IDS: undefined }));
    expect(config!.keyVersion).toBe(1);
    expect(isConnectorUserAllowed(config!, ALICE)).toBe(false);
    expect(isConnectorUserAllowed(getConnectorConfig(env({ CONNECTOR_ALLOWED_USER_IDS: "*" }))!, BOB)).toBe(true);
  });

  it.each([
    ["CONNECTOR_TOKEN_KEYS", { CONNECTOR_TOKEN_KEYS: "not json" }],
    ["CONNECTOR_TOKEN_KEYS", { CONNECTOR_TOKEN_KEYS: JSON.stringify({ "1": Buffer.alloc(16).toString("base64") }) }],
    ["CONNECTOR_TOKEN_KEYS", { CONNECTOR_TOKEN_KEYS: JSON.stringify({ one: testKey(1) }) }],
    ["CONNECTOR_TOKEN_KEYS", { CONNECTOR_TOKEN_KEYS: JSON.stringify({ "1": "%%%not-base64%%%" }) }],
    ["CONNECTOR_TOKEN_KEYS", { CONNECTOR_TOKEN_KEYS: "[]" }],
    ["CONNECTOR_TOKEN_KEYS", { CONNECTOR_TOKEN_KEYS: "{}" }],
    ["CONNECTOR_TOKEN_KEY_VERSION", { CONNECTOR_TOKEN_KEY_VERSION: "2" }],
    ["CONNECTOR_TOKEN_KEY_VERSION", { CONNECTOR_TOKEN_KEY_VERSION: "1.5" }],
    ["CONNECTOR_ALLOWED_USER_IDS", { CONNECTOR_ALLOWED_USER_IDS: "alice" }],
    ["GOOGLE_CLIENT_ID", { GOOGLE_CLIENT_ID: "has spaces in it" }],
    ["SITE_URL", { SITE_URL: "ftp://pdot.test" }],
  ])("throws a ConfigError naming %s, without the value", (name, overrides) => {
    let error: unknown;
    try {
      getConnectorConfig(env(overrides));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).missing).toEqual([name]);
    const message = (error as Error).message;
    for (const value of Object.values(overrides)) expect(message).not.toContain(value);
    expect(message).not.toContain(testKey(1));
  });
});

describe("base64 helpers", () => {
  it("round-trips bytes through base64url without padding", () => {
    for (const length of [0, 1, 2, 3, 31, 32, 33, 255]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + 11) % 256);
      const text = base64UrlEncode(bytes);
      expect(text).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(base64UrlDecode(text)).toEqual(bytes);
    }
  });

  it("refuses text that is not base64", () => {
    expect(base64UrlDecode("a+b/")).toBeNull();
    expect(base64UrlDecode("abcde")).toBeNull();
    expect(base64Decode("@@@@")).toBeNull();
    expect(base64Decode(testKey(3))).toHaveLength(32);
  });
});

describe("token encryption", () => {
  it("round-trips, with a fresh IV and the key version in front", async () => {
    const keyring = keyringFor({ "1": testKey(1) });
    const first = await encryptToken(keyring, TOKEN, binding);
    const second = await encryptToken(keyring, TOKEN, binding);
    expect(await decryptToken(keyring, first, binding)).toBe(TOKEN);
    expect(first.length).toBe(2 + 12 + new TextEncoder().encode(TOKEN).length + 16);
    expect(Array.from(first.subarray(0, 2))).toEqual([0, 1]);
    expect(ciphertextKeyVersion(first)).toBe(1);
    expect(Buffer.from(first.subarray(2, 14)).equals(Buffer.from(second.subarray(2, 14)))).toBe(false);
    expect(Buffer.from(first).toString("latin1")).not.toContain(TOKEN);
  });

  it("binds the additional data to the user, provider, account, purpose and key version", async () => {
    expect(tokenAdditionalData(binding, 3)).toBe(`pdot.connector.v1|${ALICE}|google|sub-1|refresh|3`);
    const keyring = keyringFor({ "1": testKey(1) });
    const sealed = await encryptToken(keyring, TOKEN, binding);
    for (const other of [
      { ...binding, userId: BOB },
      { ...binding, accountSub: "sub-2" },
      { ...binding, purpose: "access" as const },
    ]) {
      expect((await cryptoError(() => decryptToken(keyring, sealed, other))).kind).toBe("decrypt_failed");
    }
  });

  it("fails on any tampered byte", async () => {
    const keyring = keyringFor({ "1": testKey(1) });
    const sealed = await encryptToken(keyring, TOKEN, binding);
    for (const index of [2, 13, 14, sealed.length - 1]) {
      const tampered = Uint8Array.from(sealed);
      tampered[index] = (tampered[index] ?? 0) ^ 0x01;
      expect((await cryptoError(() => decryptToken(keyring, tampered, binding))).kind).toBe("decrypt_failed");
    }
    expect((await cryptoError(() => decryptToken(keyring, sealed.subarray(0, 20), binding))).kind).toBe("malformed");
  });

  it("fails on an unknown key version without key or token text in the error", async () => {
    const v1 = keyringFor({ "1": testKey(1) });
    const sealed = await encryptToken(v1, TOKEN, binding);
    const v2only = keyringFor({ "2": testKey(2) }, "2");
    const error = await cryptoError(() => decryptToken(v2only, sealed, binding));
    expect(error.kind).toBe("unknown_key_version");
    expect(`${error.message} ${error.stack ?? ""}`).not.toContain(TOKEN);
    expect(`${error.message} ${error.stack ?? ""}`).not.toContain(testKey(2));
  });

  it("decrypts an older key version after rotation and writes new tokens with the current one", async () => {
    const old = await encryptToken(keyringFor({ "1": testKey(1) }), TOKEN, binding);
    const rotated = keyringFor({ "1": testKey(1), "2": testKey(2) }, "2");
    expect(await decryptToken(rotated, old, binding)).toBe(TOKEN);
    const fresh = await encryptToken(rotated, TOKEN, binding);
    expect(ciphertextKeyVersion(fresh)).toBe(2);
    // The same raw bytes under another version label derive another key.
    const relabelled = Uint8Array.from(old);
    relabelled[1] = 2;
    expect((await cryptoError(() => decryptToken(rotated, relabelled, binding))).kind).toBe("decrypt_failed");
  });

  it("derives non-extractable keys", async () => {
    const keys = await keyringFor({ "1": testKey(1) }).keys(1);
    expect(keys!.token.extractable).toBe(false);
    expect(keys!.state.extractable).toBe(false);
    expect(keys!.token.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    expect(keys!.state.algorithm).toMatchObject({ name: "HMAC" });
    await expect(crypto.subtle.exportKey("raw", keys!.token)).rejects.toThrow();
  });
});

describe("state cookie", () => {
  const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
  const payload = (): OAuthStatePayload => ({
    v: 1,
    uid: ALICE,
    state: randomState(),
    verifier: createPkceVerifier(),
    iat: Math.floor(NOW / 1000),
  });

  it("verifies its own signature and returns the payload", async () => {
    const keyring = keyringFor({ "1": testKey(1) });
    const p = payload();
    const cookie = await signState(keyring, p);
    expect(cookie).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(await verifyState(keyring, cookie, NOW + 1000)).toEqual(p);
  });

  it("refuses a tampered payload, a tampered signature and another key", async () => {
    const keyring = keyringFor({ "1": testKey(1) });
    const cookie = await signState(keyring, payload());
    const [body, signature] = cookie.split(".") as [string, string];
    const forged = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ ...payload(), uid: BOB })));
    expect(await verifyState(keyring, `${forged}.${signature}`, NOW)).toBeNull();
    const flipped = signature.slice(0, -2) + (signature.at(-2) === "A" ? "B" : "A") + signature.at(-1);
    expect(await verifyState(keyring, `${body}.${flipped}`, NOW)).toBeNull();
    expect(await verifyState(keyringFor({ "1": testKey(9) }), cookie, NOW)).toBeNull();
    for (const bad of ["", "x", `${body}.`, `${body}.${signature}.x`, "a".repeat(2000), null, undefined]) {
      expect(await verifyState(keyring, bad, NOW)).toBeNull();
    }
  });

  it("refuses an expired cookie and one from the future", async () => {
    const keyring = keyringFor({ "1": testKey(1) });
    const cookie = await signState(keyring, payload());
    expect(await verifyState(keyring, cookie, NOW + 600_000)).not.toBeNull();
    expect(await verifyState(keyring, cookie, NOW + 601_000)).toBeNull();
    expect(await verifyState(keyring, cookie, NOW - 31_000)).toBeNull();
  });

  it("refuses a signed payload with the wrong shape", async () => {
    const keyring = keyringFor({ "1": testKey(1) });
    for (const bad of [
      { ...payload(), v: 2 },
      { ...payload(), state: "short" },
      { ...payload(), verifier: "too-short" },
      { ...payload(), iat: "now" },
    ]) {
      expect(await verifyState(keyring, await signState(keyring, bad as OAuthStatePayload), NOW)).toBeNull();
    }
  });
});

describe("PKCE", () => {
  it("makes verifiers of 43 to 128 unreserved characters", () => {
    const verifier = createPkceVerifier();
    expect(isPkceVerifier(verifier)).toBe(true);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(createPkceVerifier()).not.toBe(verifier);
    expect(isPkceVerifier("a".repeat(42))).toBe(false);
    expect(isPkceVerifier("a".repeat(129))).toBe(false);
  });

  it("computes the S256 challenge from RFC 7636, appendix B", async () => {
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("compares strings in full", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(randomState()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
