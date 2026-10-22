import { describe, expect, it } from "vitest";
import { matches } from "@/features/connectors/ConnectorDirectory";
import { GOOGLE_PRODUCTS, isGoogleSignInUrl, productStatus } from "@/features/connectors/GoogleAccount";
import { isUpcoming, safeHttpsLink, whenLabel } from "@/features/today/ComingUp";
import { comingUpVisible } from "@/features/today/coming-up";
import type { ConnectorGrantDTO, ConnectorsResponse } from "@/types/connectors";
import type { CalendarEventItem } from "@/types/workflows";

function grant(overrides: Partial<ConnectorGrantDTO> = {}): ConnectorGrantDTO {
  return {
    provider: "google",
    accountEmail: "me@example.com",
    scopes: [],
    products: { calendar: true, drive: true },
    status: "active",
    lastUsedAt: null,
    connectedAt: "2026-10-20T10:00:00.000Z",
    updatedAt: "2026-10-20T10:00:00.000Z",
    ...overrides,
  };
}

function state(overrides: Partial<ConnectorsResponse> = {}): ConnectorsResponse {
  return { google: grant(), available: true, allowed: true, ...overrides };
}

function event(overrides: Partial<CalendarEventItem> = {}): CalendarEventItem {
  return {
    title: "Standup",
    start: "2026-10-21T09:00:00",
    end: "2026-10-21T09:30:00",
    allDay: false,
    calendar: "Work",
    fromOthers: false,
    ...overrides,
  };
}

describe("productStatus", () => {
  it("says Connected only with a usable server, an allowed user, an active grant and the product's scope", () => {
    expect(productStatus(state(), "calendar")).toEqual({ label: "Connected", tone: "success" });
    expect(productStatus(state(), "drive")).toEqual({ label: "Connected", tone: "success" });
  });

  it("never says Connected when any of those is missing", () => {
    const cases: ConnectorsResponse[] = [
      state({ available: false }),
      state({ allowed: false }),
      state({ google: null }),
      state({ google: grant({ status: "needs_reconnect" }) }),
      state({ google: grant({ products: { calendar: false, drive: false } }) }),
    ];
    for (const value of cases) {
      for (const scope of ["calendar", "drive"] as const) {
        expect(productStatus(value, scope).label).not.toBe("Connected");
      }
    }
  });

  it("names each missing piece", () => {
    expect(productStatus(state({ available: false }), "calendar").label).toBe("Not set up");
    expect(productStatus(state({ allowed: false }), "calendar").label).toBe("Not open yet");
    expect(productStatus(state({ google: null }), "calendar").label).toBe("Not connected");
    expect(productStatus(state({ google: grant({ status: "needs_reconnect" }) }), "drive")).toEqual({
      label: "Needs reconnect",
      tone: "waiting",
    });
    expect(productStatus(state({ google: grant({ products: { calendar: true, drive: false } }) }), "drive").label).toBe(
      "No access",
    );
  });

  it("puts Docs, Slides, Sheets and Drive on the Drive scope and Calendar on its own", () => {
    const scopes = Object.fromEntries(GOOGLE_PRODUCTS.map((product) => [product.name, product.scope]));
    expect(scopes).toEqual({ Calendar: "calendar", Docs: "drive", Slides: "drive", Sheets: "drive", Drive: "drive" });
  });
});

describe("isGoogleSignInUrl", () => {
  it("accepts Google's https sign-in page", () => {
    expect(isGoogleSignInUrl("https://accounts.google.com/o/oauth2/v2/auth?client_id=x")).toBe(true);
  });

  it("rejects anything else", () => {
    for (const value of [
      "http://accounts.google.com/o/oauth2/v2/auth",
      "https://accounts.google.com.evil.com/o/oauth2/v2/auth",
      "https://evil.com/?next=https://accounts.google.com",
      "javascript:alert(1)",
      "/api/connectors/google/callback",
      "",
      undefined,
      42,
    ]) {
      expect(isGoogleSignInUrl(value)).toBe(false);
    }
  });
});

describe("matches", () => {
  it("shows everything for an empty query and needs every word to match", () => {
    expect(matches("  ", "Google", "Docs", "Finds and reads your documents.")).toBe(true);
    expect(matches("google docs", "Google", "Docs", "Finds and reads your documents.")).toBe(true);
    expect(matches("READS", "Google", "Docs", "Finds and reads your documents.")).toBe(true);
    expect(matches("docs gmail", "Google", "Docs", "Finds and reads your documents.")).toBe(false);
  });
});

describe("isUpcoming", () => {
  it("accepts the four known states", () => {
    expect(isUpcoming({ state: "ok", events: [] })).toBe(true);
    expect(isUpcoming({ state: "not_connected" })).toBe(true);
    expect(isUpcoming({ state: "needs_reconnect" })).toBe(true);
    expect(isUpcoming({ state: "error" })).toBe(true);
  });

  it("rejects an unknown state or shape", () => {
    expect(isUpcoming({ state: "connected" })).toBe(false);
    expect(isUpcoming({ state: "ok" })).toBe(false);
    expect(isUpcoming({ state: "ok", events: "none" })).toBe(false);
    expect(isUpcoming(null)).toBe(false);
    expect(isUpcoming("ok")).toBe(false);
  });
});

describe("comingUpVisible", () => {
  it("shows Today's panel only where Connect works", () => {
    expect(comingUpVisible(state())).toBe(true);
    expect(comingUpVisible(state({ google: null }))).toBe(true);
  });

  it("hides it, with its Connect link, on a server without Google and for users not on the allow list", () => {
    // Previews never get the keys; the allow list is empty by default.
    expect(comingUpVisible(state({ available: false, allowed: false }))).toBe(false);
    expect(comingUpVisible(state({ available: true, allowed: false }))).toBe(false);
    // A user removed from the allow list keeps a grant but cannot read it.
    expect(comingUpVisible(state({ google: grant(), allowed: false }))).toBe(false);
  });
});

describe("safeHttpsLink", () => {
  it("keeps https links only", () => {
    expect(safeHttpsLink("https://www.google.com/calendar/event?eid=abc")).toBe("https://www.google.com/calendar/event?eid=abc");
    expect(safeHttpsLink("http://www.google.com/calendar/event?eid=abc")).toBeNull();
    expect(safeHttpsLink("javascript:alert(1)")).toBeNull();
    expect(safeHttpsLink("not a url")).toBeNull();
    expect(safeHttpsLink(undefined)).toBeNull();
  });
});

describe("whenLabel", () => {
  // Local times, so the checks hold in any time zone.
  const now = new Date(2026, 9, 21, 12, 0);

  it("shows a later event today with its time and no weekday", () => {
    const later = new Date(2026, 9, 21, 15, 30);
    const label = whenLabel(event({ start: later.toISOString() }), now);
    expect(label.day).toBeNull();
    expect(label.time).not.toBe("Now");
  });

  it("adds the weekday for an event tomorrow", () => {
    const tomorrow = new Date(2026, 9, 22, 9, 0);
    expect(whenLabel(event({ start: tomorrow.toISOString() }), now).day).toBeTruthy();
    expect(whenLabel(event({ start: "2026-10-22", end: "2026-10-23", allDay: true }), now)).toMatchObject({
      time: "All day",
    });
    expect(whenLabel(event({ start: "2026-10-22", end: "2026-10-23", allDay: true }), now).day).toBeTruthy();
  });

  it("shows an event that is already running as today's, without its past weekday", () => {
    expect(whenLabel(event({ start: "2026-10-19", end: "2026-10-23", allDay: true }), now)).toEqual({
      time: "All day",
      day: null,
    });
    const yesterday = new Date(2026, 9, 20, 22, 0);
    const tomorrow = new Date(2026, 9, 22, 2, 0);
    expect(whenLabel(event({ start: yesterday.toISOString(), end: tomorrow.toISOString() }), now)).toEqual({
      time: "Now",
      day: null,
    });
  });
});
