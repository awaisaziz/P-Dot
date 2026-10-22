"use client";

// One-time notice that Personal and Work became one workspace (decision 0014).
// Dismissing it is remembered on this device only.
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "pdot.workspaceMergedNotice";
const listeners = new Set<() => void>();
/** Set on dismiss, so the notice stays hidden on this page when storage refuses the write. */
let dismissedHere = false;

function isDismissed(): boolean {
  if (dismissedHere) return true;
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    // Storage can be blocked (private windows, strict settings).
    return false;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Dismissed in another tab.
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function dismiss(): void {
  dismissedHere = true;
  try {
    window.localStorage.setItem(STORAGE_KEY, "dismissed");
  } catch {
    // Hidden for this page only.
  }
  for (const listener of listeners) listener();
}

/** Shows nothing on the server render, so it appears only once the browser has checked. */
export function WorkspaceMergedNotice({ count }: { count: number }) {
  const dismissed = useSyncExternalStore(subscribe, isDismissed, () => true);
  if (count <= 0 || dismissed) return null;

  return (
    <p className="alert alert-notice small" role="status">
      Personal and Work are now one workspace:{" "}
      {count === 1 ? "1 item from Work is in your lists." : `${count} items from Work are in your lists.`}{" "}
      <button type="button" className="link-button" aria-label="Dismiss notice" onClick={dismiss}>
        Dismiss
      </button>
    </p>
  );
}
