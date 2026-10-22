import "server-only";
import { z } from "zod";
import { ProviderError } from "@/server/providers/errors";
import { base64UrlDecode } from "../crypto";
import { GOOGLE_OAUTH_HOST, GoogleOAuthError, googleOAuthPost, type GoogleRequestOptions } from "./http";
import { GOOGLE_REQUESTED_SCOPES, parseGrantedScopes } from "./scopes";

// Google's web-server OAuth flow with PKCE (decision 0016). The client secret
// is used only here, in the Worker. No token, code or response body is
// logged or put in an error message.

export const GOOGLE_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = `https://${GOOGLE_OAUTH_HOST}/token`;
const REVOKE_URL = `https://${GOOGLE_OAUTH_HOST}/revoke`;

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Google refused the refresh token: it was revoked, expired (7 days in Testing) or is unknown. */
export class GoogleInvalidGrantError extends Error {
  constructor() {
    super("google refresh token is no longer valid");
    this.name = "GoogleInvalidGrantError";
  }
}

/** The authorization URL the browser navigates to. */
export function buildAuthorizationUrl(
  client: Pick<GoogleClient, "clientId" | "redirectUri">,
  input: { state: string; codeChallenge: string },
): string {
  const url = new URL(GOOGLE_AUTHORIZATION_URL);
  url.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: "code",
    scope: GOOGLE_REQUESTED_SCOPES.join(" "),
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

const tokenResponse = z.object({
  access_token: z.string().min(1).max(4096),
  expires_in: z.coerce.number().int().min(1).max(86_400),
  refresh_token: z.string().min(1).max(2048).optional(),
  scope: z.string().max(4096).optional(),
  id_token: z.string().max(16_384).optional(),
});

export interface GoogleTokens {
  accessToken: string;
  expiresInSeconds: number;
  /** Only on the first exchange (prompt=consent) or when Google rotates it. */
  refreshToken: string | null;
  /** The granted scopes. Granular consent can make this a subset of the request. */
  scopes: string[];
}

export interface GoogleAccount {
  sub: string;
  email: string;
}

export interface ExchangedGrant extends GoogleTokens {
  /** Null when the ID token is missing or unreadable. The tokens are live then, and the caller must revoke them. */
  account: GoogleAccount | null;
}

const idTokenPayload = z.object({
  iss: z.enum(["https://accounts.google.com", "accounts.google.com"]),
  aud: z.string(),
  sub: z.string().min(1).max(255),
  email: z.string().min(3).max(320),
});

/**
 * Reads `sub` and `email` from the ID token's payload. The signature is not
 * checked: the token came straight from Google's token endpoint over TLS in
 * answer to our own client-authenticated request, which OpenID Connect Core
 * (3.1.3.7) accepts in place of a signature check. Issuer and audience are
 * still compared.
 */
export function decodeIdToken(idToken: string, clientId: string): GoogleAccount | null {
  const part = idToken.split(".")[1];
  const bytes = part ? base64UrlDecode(part) : null;
  if (!bytes) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  const parsed = idTokenPayload.safeParse(payload);
  if (!parsed.success || parsed.data.aud !== clientId) return null;
  return { sub: parsed.data.sub, email: parsed.data.email };
}

function toTokens(body: unknown): z.infer<typeof tokenResponse> {
  const parsed = tokenResponse.safeParse(body);
  if (!parsed.success) throw new ProviderError("google", "bad_response");
  return parsed.data;
}

/**
 * Exchanges the authorization code (with the PKCE verifier) for tokens and
 * the account. Once Google has issued tokens this does not throw: an
 * unreadable ID token gives `account: null`, so the caller can revoke them.
 */
export async function exchangeCode(
  client: GoogleClient,
  input: { code: string; verifier: string },
  options: GoogleRequestOptions = {},
): Promise<ExchangedGrant> {
  const body = await googleOAuthPost(
    new URL(TOKEN_URL),
    new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.verifier,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: client.redirectUri,
    }),
    options,
  );
  const tokens = toTokens(body);
  const account = tokens.id_token ? decodeIdToken(tokens.id_token, client.clientId) : null;
  return {
    accessToken: tokens.access_token,
    expiresInSeconds: tokens.expires_in,
    refreshToken: tokens.refresh_token ?? null,
    scopes: parseGrantedScopes(tokens.scope ?? ""),
    account,
  };
}

/** A new access token. Throws GoogleInvalidGrantError when the refresh token no longer works. */
export async function refreshAccessToken(
  client: GoogleClient,
  refreshToken: string,
  options: GoogleRequestOptions = {},
): Promise<GoogleTokens> {
  let body: unknown;
  try {
    body = await googleOAuthPost(
      new URL(TOKEN_URL),
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: client.clientId,
        client_secret: client.clientSecret,
      }),
      options,
    );
  } catch (error) {
    if (error instanceof GoogleOAuthError && error.label === "invalid_grant") throw new GoogleInvalidGrantError();
    if (error instanceof GoogleOAuthError) throw new ProviderError("google", "auth", error.status);
    throw error;
  }
  const tokens = toTokens(body);
  return {
    accessToken: tokens.access_token,
    expiresInSeconds: tokens.expires_in,
    refreshToken: tokens.refresh_token ?? null,
    scopes: parseGrantedScopes(tokens.scope ?? ""),
  };
}

/**
 * Revokes a token at Google, with the token in the form body (never the
 * query string). Revoking ends the whole grant for this account and client.
 * Answers true only when Google confirmed it; never throws.
 */
export async function revokeToken(token: string, options: GoogleRequestOptions = {}): Promise<boolean> {
  try {
    await googleOAuthPost(new URL(REVOKE_URL), new URLSearchParams({ token }), { timeoutMs: 5_000, ...options }, false);
    return true;
  } catch {
    return false;
  }
}

export { GoogleOAuthError };
