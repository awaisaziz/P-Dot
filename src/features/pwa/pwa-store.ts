// Browser-only state for the installable app: service worker, install prompt
// and notification permission. Read it with usePwa(); the server snapshot says
// nothing is known yet, so server and first client render match.
import { useSyncExternalStore } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

declare global {
  interface Window {
    /** Set by the early script in the root layout if Chrome offered installation before React loaded. */
    __pdotInstallPrompt?: BeforeInstallPromptEvent;
  }
}

export type NotificationState = NotificationPermission | "unsupported";

export interface PwaSnapshot {
  /** False on the server and before the browser state has been read. */
  known: boolean;
  /** The browser offered installation and P-Dot can show its prompt. */
  installable: boolean;
  /** Running as the installed app (its own window, no browser bar). */
  standalone: boolean;
  serviceWorker: "unsupported" | "registering" | "active" | "failed";
  notifications: NotificationState;
  /** The browser can receive push messages (Push API). P-Dot's server does not send any yet. */
  push: boolean;
  platform: "android" | "ios" | "other";
}

const SERVER_SNAPSHOT: PwaSnapshot = {
  known: false,
  installable: false,
  standalone: false,
  serviceWorker: "registering",
  notifications: "default",
  push: false,
  platform: "other",
};

let snapshot = SERVER_SNAPSHOT;
let deferredPrompt: BeforeInstallPromptEvent | null = null;
let started = false;
const listeners = new Set<() => void>();

function update(changes: Partial<PwaSnapshot>) {
  snapshot = { ...snapshot, ...changes };
  for (const listener of listeners) listener();
}

function detectPlatform(): PwaSnapshot["platform"] {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return "android";
  // iPadOS reports itself as a Mac with touch.
  if (/iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "ios";
  return "other";
}

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function notificationState(): NotificationState {
  return "Notification" in window ? Notification.permission : "unsupported";
}

/** Registers the service worker and starts listening. Safe to call more than once. */
export function startPwa(): void {
  if (started || typeof window === "undefined") return;
  started = true;

  deferredPrompt = window.__pdotInstallPrompt ?? null;
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    update({ installable: true });
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    update({ installable: false, standalone: isStandalone() });
  });
  window.matchMedia("(display-mode: standalone)").addEventListener("change", () => update({ standalone: isStandalone() }));

  // Permission changes made in browser settings while the page is open.
  navigator.permissions
    ?.query({ name: "notifications" })
    .then((status) => status.addEventListener("change", () => update({ notifications: notificationState() })))
    .catch(() => {});

  const supportsWorker = "serviceWorker" in navigator;
  update({
    known: true,
    installable: deferredPrompt !== null,
    standalone: isStandalone(),
    notifications: notificationState(),
    push: supportsWorker && "PushManager" in window,
    platform: detectPlatform(),
    serviceWorker: supportsWorker ? "registering" : "unsupported",
  });

  if (supportsWorker) {
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then(() => navigator.serviceWorker.ready)
      .then(() => update({ serviceWorker: "active" }))
      .catch(() => update({ serviceWorker: "failed" }));
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePwa(): PwaSnapshot {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => SERVER_SNAPSHOT,
  );
}

/** Shows the browser's install dialog. Chrome allows it once per offer. */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const prompt = deferredPrompt;
  if (!prompt) return "unavailable";
  deferredPrompt = null;
  window.__pdotInstallPrompt = undefined;
  update({ installable: false });
  await prompt.prompt();
  const { outcome } = await prompt.userChoice;
  return outcome;
}

/** Asks the browser for permission to show notifications. Must be called from a click. */
export async function requestNotifications(): Promise<NotificationState> {
  if (!("Notification" in window)) return "unsupported";
  const result = await Notification.requestPermission();
  update({ notifications: result });
  return result;
}

/**
 * Shows a notification from this device's own service worker. It proves that
 * notifications appear on this device; it is not a push from P-Dot's server.
 */
export async function showTestNotification(): Promise<void> {
  const registration = await navigator.serviceWorker.ready;
  await registration.showNotification("P-Dot", {
    body: "Notifications work on this device (a browser test, not a P-Dot push).",
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-96.png",
    tag: "pdot-test",
    data: { url: "/settings" },
  });
}
