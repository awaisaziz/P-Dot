import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GOOGLE_TOGGLE_HINT, googleLinkState, googleToggleHint } from "@/features/chat/connectors";
import { buildChatRequest, requestTimeZone } from "@/features/chat/request";
import {
  WEEK_STARTER,
  chatStarters,
  draftFromQuery,
  starterHref,
  starterSuggestions,
  todayStarters,
} from "@/features/chat/starters";
import { MAX_MESSAGE_CHARS } from "@/lib/limits";
import { chatRequestSchema } from "@/lib/schemas";
import type { ConnectorGrantDTO } from "@/types/connectors";

const base = {
  message: "Find flights",
  conversationId: null,
  webSearch: false,
  effort: "auto" as const,
  timeZone: "Europe/London",
  google: false,
};

describe("the chat request body", () => {
  it("sends the time zone and the Google chip with every send", () => {
    expect(buildChatRequest({ ...base, action: "send", google: true })).toEqual({
      action: "send",
      message: "Find flights",
      webSearch: false,
      effort: "auto",
      timeZone: "Europe/London",
      connectors: { google: true },
    });
    expect(buildChatRequest({ ...base, action: "send", conversationId: "c1" })).toMatchObject({
      conversationId: "c1",
      connectors: { google: false },
    });
  });

  it("sends them with every retry too, and needs a conversation to retry", () => {
    expect(buildChatRequest({ ...base, action: "retry", conversationId: "c1", webSearch: true, google: true })).toEqual({
      action: "retry",
      conversationId: "c1",
      webSearch: true,
      effort: "auto",
      timeZone: "Europe/London",
      connectors: { google: true },
    });
    expect(buildChatRequest({ ...base, action: "retry" })).toBeNull();
  });

  it("leaves out a missing time zone", () => {
    expect(buildChatRequest({ ...base, action: "send", timeZone: undefined })).not.toHaveProperty("timeZone");
  });

  it("passes the server's strict schema", () => {
    const conversationId = "6f9619ff-8b86-4d11-b42d-00c04fc964ff";
    for (const body of [
      buildChatRequest({ ...base, action: "send", google: true }),
      buildChatRequest({ ...base, action: "send", conversationId, timeZone: undefined }),
      buildChatRequest({ ...base, action: "retry", conversationId }),
    ]) {
      expect(chatRequestSchema.safeParse(body).success).toBe(true);
    }
  });
});

describe("the browser time zone", () => {
  it("keeps an IANA name the server accepts", () => {
    expect(requestTimeZone(() => "America/Argentina/Buenos_Aires")).toBe("America/Argentina/Buenos_Aires");
    expect(requestTimeZone(() => "Etc/GMT+5")).toBe("Etc/GMT+5");
  });

  it("drops a zone the server would refuse, so the message is still sent", () => {
    expect(requestTimeZone(() => undefined)).toBeUndefined();
    expect(requestTimeZone(() => "")).toBeUndefined();
    expect(requestTimeZone(() => "Europe/London; drop")).toBeUndefined();
    expect(requestTimeZone(() => "A".repeat(65))).toBeUndefined();
    expect(
      requestTimeZone(() => {
        throw new RangeError("no Intl");
      }),
    ).toBeUndefined();
  });

  it("reads this runtime's zone by default", () => {
    const zone = requestTimeZone();
    expect(zone === undefined || /^[A-Za-z0-9_+\-/]+$/.test(zone)).toBe(true);
  });
});

describe("the composer's Google row", () => {
  const grant = (status: ConnectorGrantDTO["status"]): ConnectorGrantDTO => ({
    provider: "google",
    accountEmail: "me@example.com",
    scopes: ["openid"],
    products: { calendar: true, drive: true },
    status,
    lastUsedAt: null,
    connectedAt: "2026-10-21T10:00:00Z",
    updatedAt: "2026-10-21T10:00:00Z",
  });

  it("can be switched on only for an active grant", () => {
    expect(googleLinkState({ google: grant("active"), available: true, allowed: true })).toEqual({
      state: "connected",
      accountEmail: "me@example.com",
      products: { calendar: true, drive: true },
    });
    expect(googleLinkState({ google: grant("needs_reconnect"), available: true, allowed: true }).state).toBe(
      "needs_reconnect",
    );
    expect(googleLinkState({ google: null, available: true, allowed: true }).state).toBe("not_connected");
  });

  it("says why when the server or the account cannot use Google", () => {
    expect(googleLinkState({ google: grant("active"), available: false, allowed: false }).state).toBe("unavailable");
    expect(googleLinkState({ google: grant("active"), available: true, allowed: false }).state).toBe("not_allowed");
    expect(googleLinkState("loading").state).toBe("loading");
    expect(googleLinkState("error").state).toBe("error");
  });

  it("names only the granted products in the toggle's hint", () => {
    expect(googleToggleHint({ calendar: true, drive: true })).toBe(GOOGLE_TOGGLE_HINT);
    expect(GOOGLE_TOGGLE_HINT).toBe("P-Dot reads your calendar and Drive only while this is on.");
    expect(googleToggleHint({ calendar: true, drive: false })).toBe("P-Dot reads your calendar only while this is on.");
    expect(googleToggleHint({ calendar: false, drive: true })).toBe("P-Dot reads your Drive only while this is on.");
    const driveOnly = { ...grant("active"), products: { calendar: false, drive: true } };
    const link = googleLinkState({ google: driveOnly, available: true, allowed: true });
    expect(link.state === "connected" && link.products).toEqual({ calendar: false, drive: true });
  });
});

describe("starter suggestions", () => {
  it("offers the Google starters only when Google is connected", () => {
    expect(starterSuggestions(null)).toEqual([
      "Find flights from London to New York next Friday",
      "Research the best phone under $500 with sources",
    ]);
    expect(starterSuggestions({ calendar: true, drive: true })).toEqual([
      "Find flights from London to New York next Friday",
      "What's on my calendar tomorrow?",
      "Summarise my latest Google Doc about the budget",
      "Research the best phone under $500 with sources",
    ]);
  });

  it("offers each Google starter only when the grant covers its product", () => {
    expect(starterSuggestions({ calendar: false, drive: true })).toEqual([
      "Find flights from London to New York next Friday",
      "Summarise my latest Google Doc about the budget",
      "Research the best phone under $500 with sources",
    ]);
    expect(starterSuggestions({ calendar: true, drive: false })).toEqual([
      "Find flights from London to New York next Friday",
      "What's on my calendar tomorrow?",
      "Research the best phone under $500 with sources",
    ]);
  });
});

describe("the chat's starters and the Google chip", () => {
  const connected = { state: "connected" as const, accountEmail: "me@example.com", products: { calendar: true, drive: true } };
  const calendar = "What's on my calendar tomorrow?";
  const drive = "Summarise my latest Google Doc about the budget";

  it("offers the Google starters only while the chip is on", () => {
    expect(chatStarters(connected, true)).toEqual(expect.arrayContaining([calendar, drive]));
    // A message sent with the chip off cannot read Google.
    expect(chatStarters(connected, false)).not.toEqual(expect.arrayContaining([calendar]));
    expect(chatStarters(connected, false)).not.toEqual(expect.arrayContaining([drive]));
    expect(chatStarters(connected, false)).toEqual(starterSuggestions(null));
  });

  it("offers none for a chip left on while Google is not usable", () => {
    for (const state of ["loading", "error", "unavailable", "not_allowed", "not_connected", "needs_reconnect"] as const) {
      expect(chatStarters({ state }, true), state).toEqual(starterSuggestions(null));
    }
  });
});

describe("a starter from Today", () => {
  it("offers the calendar starter only where Google can be used", () => {
    const usable = todayStarters(true);
    const notUsable = todayStarters(false);
    expect(usable.map((starter) => starter.title)).toEqual([
      "Find a flight",
      "Check your week",
      "Research with sources",
      "Plan something",
    ]);
    expect(usable.find((starter) => starter.title === "Check your week")?.prompt).toBe(WEEK_STARTER);
    // Previews and users not on the allow list: nothing that needs Google.
    expect(notUsable.map((starter) => starter.title)).toEqual(["Find a flight", "Research with sources", "Plan something"]);
    expect(notUsable.some((starter) => /calendar|google|drive/i.test(`${starter.prompt} ${starter.example}`))).toBe(false);
  });

  it("gates Today's starters on the same check as Coming up", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(workspace)/today/page.tsx"), "utf8");
    expect(page).toMatch(/const showComingUp = comingUpVisible\(/);
    expect(page).toMatch(/todayStarters\(showComingUp\)/);
  });

  it("links to the chat with its text in q", () => {
    expect(starterHref(WEEK_STARTER)).toBe("/chat?q=What's%20on%20my%20calendar%20this%20week%3F");
    expect(new URL(starterHref("Phones under $500 & cases"), "https://x.test").searchParams.get("q")).toBe(
      "Phones under $500 & cases",
    );
  });

  it("becomes the draft once: one value, trimmed, at most one message long", () => {
    expect(draftFromQuery("  Find flights  ")).toBe("Find flights");
    expect(draftFromQuery(undefined)).toBeNull();
    expect(draftFromQuery("   ")).toBeNull();
    expect(draftFromQuery(["a", "b"])).toBeNull();
    expect(draftFromQuery("x".repeat(MAX_MESSAGE_CHARS + 10))).toHaveLength(MAX_MESSAGE_CHARS);
  });
});
