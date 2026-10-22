"use client";

import { useState } from "react";
import { errorMessage } from "@/lib/api-client";
import { promptInstall, requestNotifications, showTestNotification, usePwa } from "./pwa-store";

function InstallControl() {
  const pwa = usePwa();
  const [message, setMessage] = useState<string | null>(null);

  if (!pwa.known) return <p className="muted">Checking this browser…</p>;
  if (pwa.standalone) {
    return <p>P-Dot is running as an installed app on this device.</p>;
  }
  if (pwa.installable) {
    return (
      <div className="stack">
        <p>Install P-Dot to open it from your home screen in its own window.</p>
        <div className="actions">
          <button
            type="button"
            className="button button-primary"
            onClick={() =>
              void promptInstall().then((outcome) =>
                setMessage(
                  outcome === "accepted"
                    ? "Installing; open P-Dot from your home screen or app list."
                    : "Not installed; you can install it later from your browser menu.",
                ),
              )
            }
          >
            Install P-Dot
          </button>
        </div>
        {message && (
          <p className="hint" role="status">
            {message}
          </p>
        )}
      </div>
    );
  }
  if (pwa.platform === "ios") {
    return (
      <p>
        On iPhone or iPad, open this page in Safari, tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.
      </p>
    );
  }
  return (
    <p className="muted">
      {message ??
        (pwa.platform === "android"
          ? "Use Install app or Add to Home screen in the browser menu (⋮)."
          : "In Chrome or Edge, install from the icon in the address bar or the browser menu.")}
    </p>
  );
}

const PERMISSION_TEXT = {
  granted: "Allowed in this browser.",
  denied: "Blocked; allow notifications in this site's settings (the icon next to the address).",
  default: "Not allowed yet.",
  unsupported: "This browser does not support notifications.",
} as const;

function NotificationControl() {
  const pwa = usePwa();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function allow() {
    setBusy(true);
    setResult(null);
    try {
      await requestNotifications();
    } catch (err) {
      setResult(errorMessage(err, "The browser did not ask for permission."));
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setResult(null);
    try {
      await showTestNotification();
      setResult("Test notification sent; if it did not appear, check your browser's notification settings.");
    } catch (err) {
      setResult(errorMessage(err, "Could not show a notification."));
    } finally {
      setBusy(false);
    }
  }

  if (!pwa.known) return <p className="muted">Checking this browser…</p>;
  return (
    <div className="stack">
      <p>
        <strong>Notifications:</strong> {PERMISSION_TEXT[pwa.notifications]}
      </p>
      <div className="actions">
        {pwa.notifications === "default" && (
          <button type="button" className="button button-primary" disabled={busy} onClick={() => void allow()}>
            Allow notifications
          </button>
        )}
        {pwa.notifications === "granted" && (
          <button
            type="button"
            className="button"
            disabled={busy || pwa.serviceWorker !== "active"}
            onClick={() => void test()}
          >
            Send a test notification
          </button>
        )}
      </div>
      {pwa.notifications === "default" && pwa.platform === "ios" && !pwa.standalone && (
        <p className="hint">On iPhone and iPad, notifications work only after P-Dot is added to the Home Screen.</p>
      )}
      {result && (
        <p className="hint" role="status">
          {result}
        </p>
      )}
    </div>
  );
}

/** Settings section: install the app and allow notifications on this device. */
export function AppSettings() {
  return (
    <section className="card stack" aria-labelledby="app-heading">
      <h2 id="app-heading">App and notifications</h2>
      <InstallControl />
      <NotificationControl />
      <p className="alert alert-warning small">P-Dot does not send notifications yet; allowing them only prepares this device.</p>
    </section>
  );
}
