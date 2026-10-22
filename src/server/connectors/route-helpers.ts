import "server-only";
import type { ConnectorGrantRow } from "@/server/db/connector-grants";
import type { ConnectorGrantDTO } from "@/types/connectors";
import { googleProducts } from "./google/scopes";

// Small pieces the connector routes share: the OAuth state cookie, the
// request host, redirects and the grant DTO.

/** __Host-: Secure, Path=/ and no Domain, so only this exact host gets it. */
export const STATE_COOKIE = "__Host-pdot_oauth";

export function stateCookieHeader(value: string): string {
  return `${STATE_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`;
}

export function clearStateCookieHeader(): string {
  return `${STATE_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** One cookie's value from the Cookie header, or null. */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

/** The host the browser used, read the same way as isSameOrigin. */
export function requestHost(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-host");
  const host = request.headers.get("host");
  return (forwarded ?? host ?? new URL(request.url).host).trim().toLowerCase();
}

export function redirectResponse(location: string, requestId: string, setCookie?: string): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store", "X-Request-Id": requestId });
  if (setCookie) headers.append("Set-Cookie", setCookie);
  return new Response(null, { status: 303, headers });
}

export function noContent(requestId: string): Response {
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } });
}

/** The grant for the browser: never a token, the account ID or the row ID. */
export function toConnectorGrantDTO(row: ConnectorGrantRow): ConnectorGrantDTO {
  return {
    provider: row.provider,
    accountEmail: row.accountEmail,
    scopes: row.scopes,
    products: googleProducts(row.scopes),
    status: row.status,
    lastUsedAt: row.lastUsedAt,
    connectedAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
