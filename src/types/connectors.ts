// Shapes for the connector routes (decision 0016). Shared by the browser and
// the server: no tokens, no secrets and no server-only types here. Every
// string from Google is untrusted; render it as text, never as HTML.
import type { CalendarEventItem } from "./workflows";

export type ConnectorProvider = "google";

/** "needs_reconnect": Google refused the stored refresh token; the user must connect again. */
export type ConnectorGrantStatus = "active" | "needs_reconnect";

/** What one Google sign-in gives access to, read from the granted scopes. Docs, Slides and Sheets come with Drive. */
export interface GoogleProducts {
  calendar: boolean;
  drive: boolean;
}

/** The user's Google grant without any token. */
export interface ConnectorGrantDTO {
  provider: ConnectorProvider;
  accountEmail: string;
  scopes: string[];
  products: GoogleProducts;
  status: ConnectorGrantStatus;
  lastUsedAt: string | null;
  connectedAt: string;
  updatedAt: string;
}

/** GET /api/connectors */
export interface ConnectorsResponse {
  google: ConnectorGrantDTO | null;
  /** The server has a Google client and token keys. */
  available: boolean;
  /** This user may connect (CONNECTOR_ALLOWED_USER_IDS). */
  allowed: boolean;
}

/** POST /api/connectors/google/start: the browser navigates to `url`. */
export interface ConnectorStartResponse {
  url: string;
}

/** DELETE /api/connectors/google when the grant was deleted but Google did not confirm the revocation (204 otherwise). */
export interface ConnectorDisconnectResponse {
  revoked: false;
}

/** GET /api/connectors/google/upcoming?tz=<IANA>: at most 5 events in the next 24 hours, all-day first. */
export type UpcomingEventsResponse =
  | { state: "ok"; events: CalendarEventItem[] }
  | { state: "needs_reconnect" }
  | { state: "not_connected" }
  | { state: "error" };

/** The only codes the callback puts in `/connectors?error=<code>`. Google's own error text is never passed on. */
export const CONNECTOR_ERROR_CODES = [
  "state_mismatch",
  "denied",
  "admin_blocked",
  "not_a_tester",
  "scopes_missing",
  "exchange_failed",
  "storage_failed",
  "not_signed_in",
] as const;

export type ConnectorErrorCode = (typeof CONNECTOR_ERROR_CODES)[number];

/** One line of copy for each callback error code. */
export const CONNECTOR_ERROR_MESSAGES: Record<ConnectorErrorCode, string> = {
  state_mismatch: "That sign-in link expired or came from another tab. Try Connect again.",
  denied: "Google access was not granted.",
  admin_blocked: "Your Google Workspace administrator blocks this app.",
  not_a_tester: "This Google account cannot use P-Dot's Google connection yet.",
  scopes_missing: "Allow at least Calendar or Drive on Google's screen to connect.",
  exchange_failed: "Google did not finish the sign-in. Try again.",
  storage_failed: "P-Dot could not save the connection. Try again.",
  not_signed_in: "Sign in to P-Dot, then connect Google.",
};

/** Shown instead of Connect to a user who is not on the allow list. */
export const CONNECTOR_NOT_ALLOWED_MESSAGE = "Google is not open to your account yet.";

/** Shown after a disconnect that Google did not confirm. */
export const CONNECTOR_REVOKE_FAILED_MESSAGE =
  "Disconnected here. Google did not confirm, so also remove P-Dot at myaccount.google.com/permissions.";

export function isConnectorErrorCode(value: unknown): value is ConnectorErrorCode {
  return typeof value === "string" && (CONNECTOR_ERROR_CODES as readonly string[]).includes(value);
}
