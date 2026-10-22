import "server-only";
import type { GoogleProducts } from "@/types/connectors";

// Scopes for the read-only Google connector (decision 0016, amendment of
// 2026-10-21). A server constant: the state cookie never carries scopes.

export const GOOGLE_CALENDAR_READ_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
export const GOOGLE_DRIVE_READ_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

/** What the authorization URL asks for. */
export const GOOGLE_REQUESTED_SCOPES = [GOOGLE_CALENDAR_READ_SCOPE, GOOGLE_DRIVE_READ_SCOPE, "openid", "email"] as const;

// include_granted_scopes can return a broader scope the user granted earlier
// in the same Cloud project. These also allow the reads the tools make.
const CALENDAR_READ_SCOPES = new Set([GOOGLE_CALENDAR_READ_SCOPE, "https://www.googleapis.com/auth/calendar"]);
const DRIVE_READ_SCOPES = new Set([GOOGLE_DRIVE_READ_SCOPE, "https://www.googleapis.com/auth/drive"]);

const MAX_STORED_SCOPES = 20;
const SCOPE = /^[\x21-\x7e]{1,200}$/;

/** The granted scope string as a clean list: no duplicates, at most 20, tool scopes first. */
export function parseGrantedScopes(scope: string): string[] {
  const unique = [...new Set(scope.split(/\s+/).filter((s) => SCOPE.test(s)))];
  const tool = unique.filter((s) => CALENDAR_READ_SCOPES.has(s) || DRIVE_READ_SCOPES.has(s));
  const rest = unique.filter((s) => !tool.includes(s));
  return [...tool, ...rest].slice(0, MAX_STORED_SCOPES);
}

export function googleProducts(scopes: readonly string[]): GoogleProducts {
  return {
    calendar: scopes.some((s) => CALENDAR_READ_SCOPES.has(s)),
    drive: scopes.some((s) => DRIVE_READ_SCOPES.has(s)),
  };
}

/** At least one scope that a connector tool needs. */
export function hasToolScope(scopes: readonly string[]): boolean {
  const products = googleProducts(scopes);
  return products.calendar || products.drive;
}
