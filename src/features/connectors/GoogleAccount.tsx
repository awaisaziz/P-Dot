"use client";

// The one Google sign-in row on the Connectors page (decision 0016): Connect,
// the connected account with Disconnect, or "Needs reconnect".
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { LocalTime } from "@/components/ui/LocalTime";
import { ApiError, apiRequest, errorMessage } from "@/lib/api-client";
import {
  CONNECTOR_NOT_ALLOWED_MESSAGE,
  type ConnectorStartResponse,
  type ConnectorsResponse,
  type GoogleProducts,
} from "@/types/connectors";
import { ConnectorIcon, type ConnectorIconName } from "./ConnectorIcon";

export interface GoogleProduct {
  icon: ConnectorIconName;
  name: string;
  /** What P-Dot can do with it, in one line. Reads only. */
  description: string;
  /** Which granted scope it rides on. Docs, Slides and Sheets come with Drive. */
  scope: keyof GoogleProducts;
}

export const GOOGLE_PRODUCTS: readonly GoogleProduct[] = [
  { icon: "calendar", name: "Calendar", description: "Reads events from the calendars you show.", scope: "calendar" },
  { icon: "docs", name: "Docs", description: "Finds and reads your documents.", scope: "drive" },
  { icon: "slides", name: "Slides", description: "Finds and reads the text of your decks.", scope: "drive" },
  { icon: "sheets", name: "Sheets", description: "Finds and reads the first sheet of a spreadsheet.", scope: "drive" },
  { icon: "drive", name: "Drive", description: "Searches your files by name and content.", scope: "drive" },
];

export type PillTone = "success" | "waiting" | "muted";

export const PILL_CLASSES: Record<PillTone, string> = {
  success: "status-executed",
  waiting: "status-proposed",
  muted: "status-unconfirmed",
};

/** A product's pill. "Connected" only with a stored, active grant that includes the product's scope. */
export function productStatus(state: ConnectorsResponse, scope: keyof GoogleProducts): { label: string; tone: PillTone } {
  if (!state.available) return { label: "Not set up", tone: "muted" };
  if (!state.allowed) return { label: "Not open yet", tone: "muted" };
  const grant = state.google;
  if (!grant) return { label: "Not connected", tone: "muted" };
  if (grant.status === "needs_reconnect") return { label: "Needs reconnect", tone: "waiting" };
  return grant.products[scope] ? { label: "Connected", tone: "success" } : { label: "No access", tone: "muted" };
}

/** Only Google's own sign-in page may be opened from the start route's answer. */
export function isGoogleSignInUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "accounts.google.com";
  } catch {
    return false;
  }
}

interface GoogleAccountProps {
  state: ConnectorsResponse;
  /** `revoked` is false when Google did not confirm the revocation. */
  onDisconnected: (revoked: boolean) => void;
}

type FocusTarget = "connect" | "disconnect" | "confirm";

export function GoogleAccount({ state, onDisconnected }: GoogleAccountProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<"connect" | "disconnect" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const grant = state.google;
  const usable = state.available && state.allowed;

  // A button that removes itself hands focus to the next one, so focus never falls to the page.
  const rowRef = useRef<HTMLDivElement>(null);
  const connectRef = useRef<HTMLButtonElement>(null);
  const disconnectRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<FocusTarget | null>(null);
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    const button = { connect: connectRef, disconnect: disconnectRef, confirm: confirmRef }[target].current;
    if (button && !button.disabled) button.focus();
    else rowRef.current?.focus();
  });

  function fail(err: unknown, fallback: string) {
    if (err instanceof ApiError && err.status === 401) router.replace("/login?next=/connectors");
    else setError(errorMessage(err, fallback));
  }

  async function connect() {
    setBusy("connect");
    setError(null);
    try {
      const response = await apiRequest("/api/connectors/google/start", { method: "POST" });
      const body = (await response.json()) as Partial<ConnectorStartResponse>;
      if (!isGoogleSignInUrl(body.url)) throw new Error("Google sign-in did not start. Try again.");
      // The page is leaving for Google, so the button stays busy.
      window.location.assign(body.url);
    } catch (err) {
      fail(err, "Google sign-in did not start. Try again.");
      pendingFocus.current = "connect";
      setBusy(null);
    }
  }

  async function disconnect() {
    setBusy("disconnect");
    setError(null);
    try {
      const response = await apiRequest("/api/connectors/google", { method: "DELETE" });
      // 204: revoked at Google and deleted. 200 { revoked: false }: deleted here only.
      pendingFocus.current = "connect";
      setConfirming(false);
      onDisconnected(response.status === 204);
    } catch (err) {
      pendingFocus.current = "confirm";
      fail(err, "Could not disconnect Google. Try again.");
    } finally {
      setBusy(null);
    }
  }

  function askToDisconnect() {
    pendingFocus.current = "confirm";
    setConfirming(true);
  }

  function keep() {
    pendingFocus.current = "disconnect";
    setConfirming(false);
  }

  let line: React.ReactNode;
  if (!state.available) line = "Not set up on this server yet.";
  else if (!grant) line = state.allowed ? "One sign-in for Calendar, Docs, Slides, Sheets and Drive, read only." : CONNECTOR_NOT_ALLOWED_MESSAGE;
  else if (grant.status === "needs_reconnect") line = "Needs reconnect · Google ended P-Dot's access.";
  else if (!state.allowed) line = CONNECTOR_NOT_ALLOWED_MESSAGE;
  else
    line = (
      <>
        Read only · {grant.lastUsedAt ? <>last used <LocalTime iso={grant.lastUsedAt} style="date" /></> : "not used yet"}
      </>
    );

  return (
    <div ref={rowRef} className="google-account" tabIndex={-1} role="group" aria-label="Google account" aria-busy={busy !== null}>
      <ConnectorIcon name="google" />
      <div className="google-account-body">
        <p className="google-account-name">{grant ? <span className="google-account-email">{grant.accountEmail}</span> : "Google account"}</p>
        <p className="muted small">{line}</p>
      </div>

      {confirming && grant ? (
        <div className="actions google-account-actions" role="group" aria-label="Disconnect Google?">
          <span className="small">Disconnecting stops new reads but does not delete past conversations.</span>
          <button
            ref={confirmRef}
            type="button"
            className="button button-danger button-small"
            disabled={busy !== null}
            onClick={() => void disconnect()}
          >
            {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
          </button>
          <button type="button" className="button button-small" disabled={busy !== null} onClick={keep}>
            Keep
          </button>
        </div>
      ) : (
        <div className="actions google-account-actions">
          {(!grant || grant.status === "needs_reconnect") && (
            <button
              ref={connectRef}
              type="button"
              className="button button-primary button-small"
              disabled={!usable || busy !== null}
              onClick={() => void connect()}
            >
              {busy === "connect" ? "Opening Google…" : grant ? "Reconnect" : "Connect Google"}
            </button>
          )}
          {grant && (
            <button
              ref={disconnectRef}
              type="button"
              className="button button-small"
              // Without the server's keys a disconnect could not revoke the token, so it waits (decision 0016).
              disabled={!state.available || busy !== null}
              onClick={askToDisconnect}
            >
              Disconnect
            </button>
          )}
        </div>
      )}

      {error && (
        <p className="alert alert-error small google-account-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
