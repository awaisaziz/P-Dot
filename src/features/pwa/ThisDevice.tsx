"use client";

import { usePwa, type PwaSnapshot } from "./pwa-store";

const PLATFORM_NAMES: Record<PwaSnapshot["platform"], string> = {
  android: "Android",
  ios: "iPhone or iPad",
  other: "Computer or other device",
};

const WORKER_TEXT: Record<PwaSnapshot["serviceWorker"], string> = {
  active: "Ready (offline page and notifications)",
  registering: "Starting…",
  failed: "Could not start",
  unsupported: "Not supported by this browser",
};

const NOTIFICATION_TEXT = {
  granted: "Allowed",
  denied: "Blocked",
  default: "Not asked yet",
  unsupported: "Not supported",
} as const;

/** What this browser supports right now. Read from the browser; nothing is sent to P-Dot. */
export function ThisDevice() {
  const pwa = usePwa();
  if (!pwa.known) return <p className="muted">Checking this device…</p>;
  return (
    <dl className="device-facts">
      <div>
        <dt>Device</dt>
        <dd>{PLATFORM_NAMES[pwa.platform]}</dd>
      </div>
      <div>
        <dt>Installed as an app</dt>
        <dd>{pwa.standalone ? "Yes, running as the app" : pwa.installable ? "No, but it can be installed" : "No"}</dd>
      </div>
      <div>
        <dt>Background service</dt>
        <dd>{WORKER_TEXT[pwa.serviceWorker]}</dd>
      </div>
      <div>
        <dt>Notifications</dt>
        <dd>{NOTIFICATION_TEXT[pwa.notifications]}</dd>
      </div>
      <div>
        <dt>Push messages</dt>
        <dd>
          {pwa.push
            ? "Supported; P-Dot does not send any yet."
            : pwa.platform === "ios" && !pwa.standalone
              ? "Available after you add P-Dot to the Home Screen"
              : "Not supported by this browser"}
        </dd>
      </div>
    </dl>
  );
}
