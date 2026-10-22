"use client";

// The composer's Google chip (decision 0011, amendment of 2026-10-21). The
// connection comes from GET /api/connectors, read once per page load. The
// chip's on/off choice is kept on this device and is off until the user
// turns it on; turning it on is the user's approval for reads.
import { useSyncExternalStore } from "react";
import { getJson } from "@/lib/api-client";
import { CONNECTOR_NOT_ALLOWED_MESSAGE, type ConnectorsResponse, type GoogleProducts } from "@/types/connectors";

export type GoogleLinkState =
  | { state: "loading" }
  | { state: "error" }
  | { state: "unavailable" }
  | { state: "not_allowed" }
  | { state: "not_connected" }
  | { state: "needs_reconnect" }
  /** `products`: what the grant covers, so only those tools and starters are offered. */
  | { state: "connected"; accountEmail: string; products: GoogleProducts };

/** What the composer can offer, from the connectors response. Pure, so it is unit-tested. */
export function googleLinkState(response: ConnectorsResponse | "loading" | "error"): GoogleLinkState {
  if (response === "loading" || response === "error") return { state: response };
  if (!response.available) return { state: "unavailable" };
  if (!response.allowed) return { state: "not_allowed" };
  if (!response.google) return { state: "not_connected" };
  if (response.google.status !== "active") return { state: "needs_reconnect" };
  const { calendar, drive } = response.google.products;
  return { state: "connected", accountEmail: response.google.accountEmail, products: { calendar, drive } };
}

/** One line under the menu row for each state that cannot be switched on. */
export const GOOGLE_ROW_HINTS = {
  loading: "Checking your Google connection…",
  error: "Could not check your Google connection.",
  unavailable: "Google is not available here yet.",
  not_allowed: CONNECTOR_NOT_ALLOWED_MESSAGE,
} as const;

export const GOOGLE_TOGGLE_HINT = "P-Dot reads your calendar and Drive only while this is on.";

/** The toggle's one-line hint, naming only what the grant covers. */
export function googleToggleHint(products: GoogleProducts): string {
  if (products.calendar && products.drive) return GOOGLE_TOGGLE_HINT;
  if (products.calendar) return "P-Dot reads your calendar only while this is on.";
  if (products.drive) return "P-Dot reads your Drive only while this is on.";
  return "P-Dot reads your Google account only while this is on.";
}

let connectorsLoad: Promise<ConnectorsResponse> | null = null;

/** GET /api/connectors, once per page load. A failed read is asked for again on the next call. */
export function fetchConnectorsOnce(): Promise<ConnectorsResponse> {
  if (!connectorsLoad) {
    connectorsLoad = getJson<ConnectorsResponse>("/api/connectors").catch((error: unknown) => {
      connectorsLoad = null;
      throw error;
    });
  }
  return connectorsLoad;
}

const STORAGE_KEY = "pdot.connectors.google";
const listeners = new Set<() => void>();
/** Used when storage refuses the write, so this page still follows the choice until it reloads. */
let memoryFallback: boolean | null = null;

function read(): boolean {
  if (memoryFallback !== null) return memoryFallback;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    // Storage can be blocked (private windows, strict settings).
    return false;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Another tab changed it.
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function setGoogleChip(on: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
    memoryFallback = null;
  } catch {
    memoryFallback = on;
  }
  for (const listener of listeners) listener();
}

/** The chip's stored choice on this device. Off on the server and until the browser has checked. */
export function useGoogleChip(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
