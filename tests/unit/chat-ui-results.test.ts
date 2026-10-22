import { describe, expect, it } from "vitest";
import {
  STALE_AFTER_MS,
  basisChips,
  displayHost,
  driveReadLine,
  dropLine,
  eventTimeText,
  flightFoot,
  googleLink,
  googleSentLines,
  googleSentRow,
  handOffLinks,
  markCappedReads,
  modifiedText,
  readLine,
  recheckMessage,
  resultWarning,
  sourceView,
  unverifiedLine,
} from "@/features/results/format";
import type { MessageResult, ResearchResult } from "@/types/workflows";

const LONDON = { locale: "en-GB", timeZone: "Europe/London" };
const READ_AT = "2026-10-21T13:05:00.000Z";
const readMs = Date.parse(READ_AT);

describe("price basis chips", () => {
  it("labels known bases once each, in a fixed order", () => {
    expect(basisChips(["per_person", "round_trip"])).toEqual(["per person", "round trip"]);
    expect(basisChips(["round_trip", "from", "from", "one_way"])).toEqual(["from", "round trip", "one way"]);
    expect(basisChips(["range"])).toEqual(["range"]);
  });

  it("drops values it does not know", () => {
    expect(basisChips(["per_person", "total", "<b>x</b>"])).toEqual(["per person"]);
    expect(basisChips([])).toEqual([]);
  });
});

describe("when the pages were read", () => {
  it("shows the local read time while fresh", () => {
    expect(readLine(READ_AT, readMs + 60_000, LONDON)).toEqual({ text: "Read 21 Oct, 14:05", stale: false });
    expect(readLine(READ_AT, readMs + STALE_AFTER_MS - 1, LONDON)?.stale).toBe(false);
  });

  it("counts as fresh before the browser knows the time, and for a clock behind the server", () => {
    expect(readLine(READ_AT, null, LONDON)).toEqual({ text: "Read 21 Oct, 14:05", stale: false });
    expect(readLine(READ_AT, readMs - 3_600_000, LONDON)?.stale).toBe(false);
  });

  it("says how long ago, and that fares change, after 6 hours", () => {
    const fares = { ...LONDON, staleSuffix: "fares change" };
    expect(readLine(READ_AT, readMs + STALE_AFTER_MS, fares)).toEqual({ text: "Read 6 hours ago · fares change", stale: true });
    expect(readLine(READ_AT, readMs + 26 * 3_600_000, fares)).toEqual({ text: "Read 1 day ago · fares change", stale: true });
    expect(readLine(READ_AT, readMs + 3 * 86_400_000 + 5, fares)?.text).toBe("Read 3 days ago · fares change");
    expect(readLine(READ_AT, readMs + 3 * 86_400_000, LONDON)?.text).toBe("Read 3 days ago");
  });

  it("shows nothing for an unreadable date", () => {
    expect(readLine("not a date", readMs)).toBeNull();
  });
});

describe("the flight card's foot", () => {
  const page = { n: 1, title: "Fares", url: "https://a.example/x", domain: "a.example", retrievedAt: READ_AT };

  it("says no page was read when the search read none, and keeps Re-check", () => {
    expect(flightFoot({ sources: [], retrievedAt: READ_AT }, readMs, LONDON)).toEqual({
      text: "No page was read",
      stale: false,
      recheck: true,
    });
  });

  it("shows the read time, and Re-check only once fares are old", () => {
    expect(flightFoot({ sources: [page], retrievedAt: READ_AT }, readMs + 60_000, LONDON)).toEqual({
      text: "Read 21 Oct, 14:05",
      stale: false,
      recheck: false,
    });
    expect(flightFoot({ sources: [page], retrievedAt: READ_AT }, readMs + 2 * 86_400_000, LONDON)).toEqual({
      text: "Read 2 days ago · fares change",
      stale: true,
      recheck: true,
    });
  });
});

describe("dropped candidates and unverified mentions", () => {
  it("names each drop reason in one line", () => {
    expect(dropLine({ wrong_direction: 1, price_not_in_quote: 1 })).toBe(
      "2 candidates dropped: wrong direction, price not in quote",
    );
    expect(dropLine({ quote_not_found: 3 })).toBe("3 candidates dropped: quote not on the page (3)");
    expect(dropLine({ ambiguous_quote: 1 })).toBe("1 candidate dropped: more than one price or airline");
  });

  it("is empty when nothing was dropped, and ignores unknown reasons", () => {
    expect(dropLine({})).toBeNull();
    expect(dropLine({ wrong_direction: 0 })).toBeNull();
    expect(dropLine({ made_up: 4 } as Record<string, number>)).toBeNull();
  });

  it("warns about prices and times in the reply that the pages do not show", () => {
    expect(unverifiedLine(["£350", "09:40"])).toBe(
      "Not verified: £350, 09:40 appear in the reply but not on the pages read.",
    );
    expect(unverifiedLine(["£350"])).toBe("Not verified: £350 appears in the reply but not on the pages read.");
    expect(unverifiedLine([])).toBeNull();
    expect(unverifiedLine(["  "])).toBeNull();
    const many = ["£1", "£2", "£3", "£4", "£5", "£6", "£7", "£8"];
    expect(unverifiedLine(many)).toBe(
      "Not verified: £1, £2, £3, £4, £5, £6 and 2 more appear in the reply but not on the pages read.",
    );
  });

  it("gives research cards the same warning, and none for older rows without the field", () => {
    const research: ResearchResult = {
      kind: "research",
      question: "Best phone under $500?",
      claims: [],
      dropped: {},
      sources: [],
      summary: "",
      retrievedAt: READ_AT,
    };
    expect(resultWarning(research)).toBeNull();
    expect(resultWarning({ ...research, unverifiedMentions: [] })).toBeNull();
    expect(resultWarning({ ...research, unverifiedMentions: ["$449"] })).toBe(
      "Not verified: $449 appears in the reply but not on the pages read.",
    );
    expect(resultWarning({ unverifiedMentions: ["£350", "09:40"] })).toBe(unverifiedLine(["£350", "09:40"]));
  });
});

describe("links", () => {
  it("keeps only allowed hand-off links and labels them", () => {
    const links = handOffLinks([
      { label: "Check live fares on Google Flights", url: "https://www.google.com/travel/flights?q=Flights+from+LHR+to+JFK" },
      { label: "Check live fares on Skyscanner", url: "https://www.skyscanner.net/transport/flights/lhr/jfk/261112/?adultsv2=1" },
    ]);
    expect(links).toEqual([
      {
        url: "https://www.google.com/travel/flights?q=Flights+from+LHR+to+JFK",
        label: "See live fares on Google Flights",
        text: "See live fares on Google Flights",
      },
      {
        url: "https://www.skyscanner.net/transport/flights/lhr/jfk/261112/?adultsv2=1",
        label: "See live fares on Skyscanner",
        text: "Skyscanner",
      },
    ]);
  });

  it("refuses other hosts, paths, schemes and credentials", () => {
    const refused = [
      "http://www.google.com/travel/flights?q=x",
      "https://www.google.com/search?q=flights",
      "https://google.com/travel/flights",
      "https://www.google.com.evil.example/travel/flights",
      "https://user:pass@www.skyscanner.net/transport/flights/lhr/jfk/",
      "https://www.kayak.com/flights/LHR-JFK/2026-11-12",
      "javascript:alert(1)",
      "not a url",
    ];
    expect(handOffLinks(refused.map((url) => ({ label: "x", url })))).toEqual([]);
  });

  it("shows a site once", () => {
    const url = "https://www.skyscanner.net/transport/flights/lhr/jfk/261112/";
    expect(handOffLinks([{ label: "a", url }, { label: "b", url: `${url}?x=1` }])).toHaveLength(1);
  });

  it("reads the source domain from its own link, not the stored domain", () => {
    expect(sourceView({ url: "https://www.britishairways.com/en-gb/flights", domain: "britishairways.com" })).toEqual({
      url: "https://www.britishairways.com/en-gb/flights",
      domain: "britishairways.com",
    });
    expect(sourceView({ url: "https://evil.example/fares", domain: "britishairways.com" })).toEqual({
      url: "https://evil.example/fares",
      domain: "evil.example",
    });
    expect(sourceView({ url: "javascript:alert(1)", domain: "britishairways.com" })).toEqual({
      url: null,
      domain: "a page P-Dot read",
    });
    expect(sourceView(undefined)).toEqual({ url: null, domain: "a page P-Dot read" });
    expect(displayHost("https://www.example.com/a")).toBe("example.com");
    expect(displayHost("nope")).toBeNull();
  });

  it("links calendar events and Drive files only on Google's own https hosts", () => {
    expect(googleLink("https://www.google.com/calendar/event?eid=abc", "calendar")).toBe(
      "https://www.google.com/calendar/event?eid=abc",
    );
    expect(googleLink("https://calendar.google.com/calendar/r/eventedit/abc", "calendar")).not.toBeNull();
    expect(googleLink("https://docs.google.com/document/d/abc/edit", "drive")).not.toBeNull();
    expect(googleLink("https://drive.google.com/file/d/abc/view", "drive")).not.toBeNull();
    expect(googleLink("https://docs.google.com/document/d/abc/edit", "calendar")).toBeNull();
    // Google's redirector and search are on www.google.com but are not Calendar.
    expect(googleLink("https://www.google.com/url?q=https://evil.example", "calendar")).toBeNull();
    expect(googleLink("https://www.google.com/search?q=calendar", "calendar")).toBeNull();
    expect(googleLink("http://docs.google.com/document/d/abc", "drive")).toBeNull();
    expect(googleLink("https://docs.google.com.evil.example/x", "drive")).toBeNull();
    expect(googleLink(undefined, "drive")).toBeNull();
  });

  it("builds the Re-check message from the trip line", () => {
    expect(recheckMessage({ trip: { line: "London (LHR) to New York (JFK) · one way · Thu 12 Nov 2026 · 1 adult" } as never })).toBe(
      "Check flight prices again: London (LHR) to New York (JFK) · one way · Thu 12 Nov 2026 · 1 adult",
    );
  });
});

describe("calendar and Drive rows", () => {
  it("shows an event's day and times in the viewer's zone", () => {
    expect(
      eventTimeText({ start: "2026-10-22T13:00:00Z", end: "2026-10-22T14:00:00Z", allDay: false }, LONDON),
    ).toBe("Thu 22 Oct · 14:00–15:00");
    expect(
      eventTimeText({ start: "2026-10-22T21:00:00Z", end: "2026-10-23T05:00:00Z", allDay: false }, LONDON),
    ).toBe("Thu 22 Oct, 22:00 – Fri 23 Oct, 06:00");
    expect(eventTimeText({ start: "2026-10-22T13:00:00Z", end: "bad", allDay: false }, LONDON)).toBe("Thu 22 Oct · 14:00");
  });

  it("reads an all-day date as that calendar day in every zone", () => {
    const allDay = { start: "2026-10-22", end: "2026-10-23", allDay: true };
    expect(eventTimeText(allDay, { locale: "en-GB", timeZone: "America/Los_Angeles" })).toBe("Thu 22 Oct · All day");
    expect(eventTimeText(allDay, { locale: "en-GB", timeZone: "Pacific/Auckland" })).toBe("Thu 22 Oct · All day");
  });

  it("says how much of a Drive file was read", () => {
    expect(driveReadLine({ id: "f", name: "Budget 2026", chars: 6000, totalChars: 18240, truncated: true })).toBe(
      "Read Budget 2026 · first 6,000 of 18,240 characters",
    );
    expect(driveReadLine({ id: "f", name: "Notes", chars: 3100, totalChars: 3100, truncated: false })).toBe(
      "Read Notes · 3,100 characters",
    );
    expect(driveReadLine({ id: "f", name: "  ", chars: 1, totalChars: 1, truncated: false })).toBe("Read the file · 1 character");
  });

  it("says more than the characters read when the byte cap cut the file", () => {
    const read = { id: "f", name: "Budget 2026", chars: 6000, totalChars: 49_152, truncated: true };
    expect(driveReadLine({ ...read, capped: true })).toBe("Read Budget 2026 · first 6,000 of more than 49,152 characters");
    expect(driveReadLine({ ...read, capped: false })).toBe("Read Budget 2026 · first 6,000 of 49,152 characters");
  });

  it("finds a capped read from its step detail, as connector.ts words it", () => {
    const read = { id: "f", name: "Budget", chars: 6000, totalChars: 49_100, truncated: true };
    const result: MessageResult = { kind: "drive", files: [{ id: "f", name: "Budget", kind: "doc" }], read };
    const capped = { id: "google-call_2", detail: "first 6,000 of more than 49,100 characters" };
    const marked = markCappedReads([result], [{ id: "google-call_1" }, capped]);
    expect(marked).not.toBe(result);
    expect(marked[0]?.kind === "drive" && driveReadLine(marked[0].read!)).toBe(
      "Read Budget · first 6,000 of more than 49,100 characters",
    );
    // The stored result is not changed.
    expect(read).not.toHaveProperty("capped");
  });

  it("leaves a read alone without such a step", () => {
    const read = { id: "f", name: "Budget", chars: 6000, totalChars: 18_240, truncated: true };
    const results: MessageResult[] = [{ kind: "drive", files: [], read }];
    expect(markCappedReads(results, undefined)).toBe(results);
    expect(markCappedReads(results, [{ id: "google-call_1", detail: "first 6,000 of 18,240 characters" }])).toBe(results);
    // Another tool's detail does not count, nor does a different length.
    expect(markCappedReads(results, [{ id: "tool-0-1", detail: "first 6,000 of more than 18,240 characters" }])).toBe(results);
    expect(markCappedReads(results, [{ id: "google-call_1", detail: "first 6,000 of more than 18,241 characters" }])).toBe(
      results,
    );
  });

  it("uses the read's own capped field when the server sent one", () => {
    const read = { id: "f", name: "Budget", chars: 6000, totalChars: 49_100, truncated: true };
    const detail = [{ id: "google-call_1", detail: "first 6,000 of more than 49,100 characters" }];
    const cappedRead: MessageResult[] = [{ kind: "drive", files: [], read: { ...read, capped: true } }];
    expect(markCappedReads(cappedRead, undefined)).toBe(cappedRead);
    expect(cappedRead[0]?.kind === "drive" && driveReadLine(cappedRead[0].read!)).toBe(
      "Read Budget · first 6,000 of more than 49,100 characters",
    );
    // The field wins over a step detail, so a row that says false stays exact.
    const exact: MessageResult[] = [{ kind: "drive", files: [], read: { ...read, capped: false } }];
    expect(markCappedReads(exact, detail)).toBe(exact);
    expect(googleSentLines(exact)).toEqual(["Read Budget · first 6,000 of 49,100 characters"]);
  });

  const calendar = { kind: "calendar" as const, window: { start: "", end: "" } };
  const event = { title: "Standup", start: "2026-10-22T09:00:00Z", end: "2026-10-22T09:15:00Z", allDay: false, calendar: "Work", fromOthers: false };
  const budget = { id: "fileid0001", name: "Budget 2026", kind: "doc" as const };

  it("lists what a reply read from Google for What was sent", () => {
    expect(
      googleSentLines([
        { ...calendar, events: [event, event] },
        { ...calendar, events: [event] },
        { kind: "drive", files: [budget, { ...budget, id: "fileid0002" }] },
        {
          kind: "drive",
          files: [budget],
          read: { id: budget.id, name: "Budget 2026", chars: 6000, totalChars: 18240, truncated: true },
        },
      ]),
    ).toEqual(["3 calendar events", "2 Drive files listed", "Read Budget 2026 · first 6,000 of 18,240 characters"]);
    expect(googleSentLines([{ ...calendar, events: [] }])).toEqual(["Calendar checked, no events"]);
    expect(googleSentLines([])).toEqual([]);
  });

  it("counts a read file as read, not listed", () => {
    expect(
      googleSentLines([
        { kind: "drive", files: [budget], read: { id: budget.id, name: "Budget 2026", chars: 900, totalChars: 900, truncated: false } },
      ]),
    ).toEqual(["Read Budget 2026 · 900 characters"]);
  });

  it("says Drive was searched when the search found nothing", () => {
    expect(googleSentLines([{ kind: "drive", files: [] }])).toEqual(["Drive searched, no match"]);
    expect(googleSentLines([{ kind: "drive", files: [] }, { kind: "drive", files: [budget] }])).toEqual(["1 Drive file listed"]);
  });

  it("never says Google was not used without a saved record", () => {
    expect(googleSentRow(undefined)).toEqual({ lines: [], none: "None recorded" });
    expect(googleSentRow({ results: [], steps: [] })).toEqual({ lines: [], none: "Not used" });
    expect(googleSentRow({ results: [{ kind: "drive", files: [] }], steps: [] }).lines).toEqual(["Drive searched, no match"]);
  });

  it("counts a Google step whose result was not kept", () => {
    expect(googleSentRow({ results: [], steps: [{ id: "google-call_1", status: "done" }] }).lines).toEqual([
      "Read from Google; the details were not kept",
    ]);
    // A refused call ("Google is off for this message") read nothing.
    expect(googleSentRow({ results: [], steps: [{ id: "google-call_1", status: "failed" }] }).lines).toEqual([]);
  });

  it("says at least when the server trimmed the saved lists", () => {
    const results: MessageResult[] = [
      { ...calendar, events: [event, event] },
      { ...calendar, events: [event] },
      { kind: "drive", files: [budget, { ...budget, id: "fileid0002" }] },
    ];
    expect(googleSentLines(results, true)).toEqual(["At least 3 calendar events", "At least 2 Drive files listed"]);
    expect(googleSentLines([{ ...calendar, events: [event] }], true)).toEqual(["At least 1 calendar event"]);
    // An empty list may sit beside a result that was cut, so it does not claim there were none.
    expect(googleSentLines([{ ...calendar, events: [] }, { kind: "drive", files: [] }], true)).toEqual([
      "Calendar checked",
      "Drive searched",
    ]);
    // A file's read line has its own counts, which trimming never changes.
    const read = { id: budget.id, name: "Budget 2026", chars: 900, totalChars: 900, truncated: false };
    expect(googleSentLines([{ kind: "drive", files: [budget], read }], true)).toEqual(["Read Budget 2026 · 900 characters"]);
  });

  it("shows exact counts unless the payload says it was trimmed", () => {
    const steps = [{ id: "google-call_1", status: "done" as const }];
    const results: MessageResult[] = [{ ...calendar, events: [event, event] }];
    expect(googleSentRow({ results, steps }).lines).toEqual(["2 calendar events"]);
    expect(googleSentRow({ results, steps, trimmed: false }).lines).toEqual(["2 calendar events"]);
    expect(googleSentRow({ results, steps, trimmed: true }).lines).toEqual(["At least 2 calendar events"]);
  });

  it("counts the Google reads whose whole result the trim cut", () => {
    const steps = [
      { id: "google-call_1", status: "done" as const },
      { id: "google-call_2", status: "partial" as const },
      { id: "google-call_3", status: "done" as const },
      // Refused and other tools' steps are not reads.
      { id: "google-call_4", status: "failed" as const },
      { id: "flights.search", status: "done" as const },
    ];
    const results: MessageResult[] = [{ ...calendar, events: [event] }];
    expect(googleSentRow({ results, steps, trimmed: true }).lines).toEqual([
      "At least 1 calendar event",
      "2 more reads from Google; the details were not kept",
    ]);
    expect(googleSentRow({ results, steps: steps.slice(0, 2), trimmed: true }).lines).toEqual([
      "At least 1 calendar event",
      "1 more read from Google; the details were not kept",
    ]);
    // Without the trim flag the extra line is not guessed from the steps.
    expect(googleSentRow({ results, steps }).lines).toEqual(["1 calendar event"]);
    // With every Google result cut, the row still says Google was read.
    expect(googleSentRow({ results: [], steps, trimmed: true }).lines).toEqual(["Read from Google; the details were not kept"]);
  });

  it("shows when a file was edited", () => {
    expect(modifiedText("2026-10-21T13:05:00Z", LONDON)).toBe("Edited 21 Oct");
    expect(modifiedText(undefined)).toBeNull();
    expect(modifiedText("bad")).toBeNull();
  });
});
