import { describe, expect, it } from "vitest";
import { airportsInUserWords, datesNamedIn, parseFlightRequest } from "@/server/assistant/workflows/request";

// parseFlightRequest (decision 0015, changes after the final review): code
// reads a clear flight request from the user's own words, so a model that
// ignores a forced tool call cannot skip the check and one that gets a vague
// request cannot fill in a trip. Anything missing or unclear is null.

/** Thursday 22 October 2026, noon UTC. */
const NOW = new Date("2026-10-22T12:00:00Z");
const parse = (text: string, now = NOW, timeZone = "UTC") => parseFlightRequest(text, now, timeZone);

describe("parseFlightRequest", () => {
  it("reads both places and the date from a plain request", () => {
    expect(parse("Find me cheap flights from London to New York on 12 November")).toEqual({
      origin: "London",
      destination: "New York",
      depart_date: "2026-11-12",
      passengers: 1,
    });
    expect(parse("LHR to JFK 2026-11-12")).toMatchObject({ origin: "LHR", destination: "JFK", depart_date: "2026-11-12" });
    expect(parse("I want to fly from New York JFK to London Heathrow on Nov 12th")).toMatchObject({
      origin: "New York JFK",
      destination: "London Heathrow",
      depart_date: "2026-11-12",
    });
    expect(parse("flights London to Paris November 12, 2026")).toMatchObject({ origin: "London", destination: "Paris", depart_date: "2026-11-12" });
  });

  it("reads every written date form, a date without a year as the next one on or after local today", () => {
    const date = (when: string) => parse(`flights from London to Paris ${when}`)?.depart_date ?? null;
    expect(date("on 12 Nov")).toBe("2026-11-12");
    expect(date("on 12 November")).toBe("2026-11-12");
    expect(date("on Nov 12")).toBe("2026-11-12");
    expect(date("on November 12th")).toBe("2026-11-12");
    expect(date("on the 12th of November")).toBe("2026-11-12");
    expect(date("on Thu 12 Nov")).toBe("2026-11-12");
    expect(date("on 2026-11-12")).toBe("2026-11-12");
    expect(date("on 3 March")).toBe("2027-03-03");
    expect(date("on 22 Oct")).toBe("2026-10-22");
    expect(date("today")).toBe("2026-10-22");
    expect(date("tomorrow")).toBe("2026-10-23");
    expect(date("this Friday")).toBe("2026-10-23");
    expect(date("this Thursday")).toBe("2026-10-22");
    expect(date("next Friday")).toBe("2026-10-30");
    expect(date("next Monday")).toBe("2026-10-26");
  });

  it("reads the date in the user's time zone", () => {
    // 23:30 UTC on 22 Oct is already 23 Oct in Auckland, and still 22 Oct in Los Angeles.
    const late = new Date("2026-10-22T23:30:00Z");
    expect(parse("flights from London to Paris tomorrow", late, "Pacific/Auckland")?.depart_date).toBe("2026-10-24");
    expect(parse("flights from London to Paris tomorrow", late, "America/Los_Angeles")?.depart_date).toBe("2026-10-23");
    // An unknown zone is UTC.
    expect(parse("flights from London to Paris tomorrow", late, "Mars/Olympus")?.depart_date).toBe("2026-10-23");
  });

  it("reads a return date and the travellers", () => {
    expect(parse("flights from London to New York on 12 Nov returning 19 Nov for 2 adults")).toEqual({
      origin: "London",
      destination: "New York",
      depart_date: "2026-11-12",
      return_date: "2026-11-19",
      passengers: 2,
    });
    expect(parse("flights London to New York 12 Nov to 19 Nov")).toMatchObject({ depart_date: "2026-11-12", return_date: "2026-11-19" });
    expect(parse("flights London to New York on 12 Nov, back on 19 Nov")).toMatchObject({ return_date: "2026-11-19" });
    expect(parse("flights from London to Rome on 12 Nov for 3 people")?.passengers).toBe(3);
    expect(parse("flights from London to Rome on 12 Nov for two passengers")?.passengers).toBe(2);
  });

  it.each([
    ["no origin", "cheap flights to Lisbon on 12 Nov"],
    ["no destination", "flights from London on 12 Nov"],
    ["no date", "flights from London to New York"],
    ["a vague date", "flights from London to New York next week"],
    ["a month only", "flights from London to New York in November"],
    ["a place the table does not know", "flights from Atlantis to New York on 12 Nov"],
    ["a place with two airports of that name", "flights from Portland to New York on 12 Nov"],
    ["the same place twice", "flights from London to Heathrow on 12 Nov"],
    ["two legs", "flights from London to Paris to Rome on 12 Nov"],
    ["a choice of dates", "flights from London to Paris on 12 Nov or 13 Nov"],
    ["a span of days", "flights from London to Paris 12-19 Nov"],
    ["two departure dates", "flights from London to Paris on 12 Nov, maybe 14 Nov"],
    ["a weekday that does not fit the date", "flights from London to Paris on Wed 12 Nov"],
    ["a day that does not exist", "flights from London to Paris on 31 Nov"],
    ["a date in the past", "flights from London to Paris on 2026-10-01"],
    ["a date more than 330 days ahead", "flights from London to Paris on 21 Oct"],
    ["a year too far", "flights from London to Paris on 12 Nov 2027"],
    ["a return before the departure", "flights from London to Paris on 12 Nov returning 10 Nov"],
    ["a round trip without its return date", "round trip flights from London to Paris on 12 Nov"],
    ["children", "flights from London to Paris on 12 Nov for 2 adults and 2 children"],
    ["a group without a count", "we want to fly from London to Paris on 12 Nov"],
    ["two counts", "flights from London to Paris on 12 Nov for 2 adults, or 3 people"],
    ["more than nine travellers", "flights from London to Paris on 12 Nov for 12 people"],
    ["codes in lower case", "lhr to jfk on 12 Nov"],
    // A month and a count or a stay length is not a day and a month.
    ["a month and a count of adults", "Cheap flights from London to Paris in June 2 adults"],
    ["a month and a count of people", "Find flights London to Paris for Dec 4 people"],
    ["a month and a number of nights", "London to Paris June 3 nights"],
    // A city with a qualifier the table does not know is not the city alone.
    ["a destination with an unknown qualifier", "London to Paris Texas 12 Nov"],
    ["a destination with an unknown qualifier after a comma", "London to Paris, Texas on 12 Nov"],
    ["a destination with an unknown qualifier in brackets", "London to Paris (Texas) on 12 Nov"],
    // A return asked for but no return date read.
    ["a return date in a form not read", "Flights from London to Paris on 12 Nov returning 19/11"],
    ["a return day without a month", "Flights from London to Paris on 12 Nov, back on the 19th"],
    ["a stay length", "Flights from London to Paris on 12 Nov for a week"],
    ["a stay in days", "Flights from London to Paris on 12 Nov for 5 days"],
    ["one way or return", "Flights from London to Paris on 12 Nov one way or return"],
    // A bound or an approximate date is not the date to search.
    ["today's fares", "What are today's fares from London to Paris?"],
    ["tonight's prices", "tonight's prices London to Paris"],
    ["a date to leave before", "London to Paris before 12 Nov"],
    ["a date to arrive by", "London to Paris by 12 Nov"],
    ["a date to leave after", "London to Paris any day after 12 Nov"],
    ["a date around", "London to Paris around 12 Nov"],
    ["the week of a date", "London to Paris week of 12 Nov"],
    ["a date until", "London to Paris until 12 Nov"],
    ["a date or later", "London to Paris 12 Nov or later"],
    ["a date or a vague choice", "London to Paris tomorrow or next week"],
    ["a date plus or minus", "London to Paris 12 Nov plus or minus a day"],
    ["a date with a +/-", "London to Paris 12 Nov +/- 2 days"],
    ["a date onwards", "London to Paris from 12 Nov onwards"],
    ["a flexible date", "London to Paris on 12 Nov, I am flexible"],
    ["a return to be back by", "London to Paris on 12 Nov, back by 19 Nov"],
  ])("returns null for %s", (_label, text) => {
    expect(parse(text)).toBeNull();
  });

  it("still reads a clear request next to a count, a weekday or a new sentence", () => {
    expect(parse("London to Paris on 12 Nov 2 adults")).toMatchObject({ depart_date: "2026-11-12", passengers: 2 });
    expect(parse("London to Paris Thursday 12 Nov")).toMatchObject({ destination: "Paris", depart_date: "2026-11-12" });
    expect(parse("London to Paris, Friday 13 Nov")).toMatchObject({ destination: "Paris", depart_date: "2026-11-13" });
    expect(parse("Flights London to Paris on 12 Nov. Thanks")).toMatchObject({ destination: "Paris", depart_date: "2026-11-12" });
    expect(parse("London to Paris tomorrow's flights")).toMatchObject({ depart_date: "2026-10-23" });
    expect(parse("London to New York on 12 Nov returning 19 Nov")).toMatchObject({ return_date: "2026-11-19" });
  });

  it("reads only the start of a very long message", () => {
    expect(parse(`${"a".repeat(2_100)} flights from London to Paris on 12 Nov`)).toBeNull();
  });
});

describe("the user's words, for checking a flight search the model asked for", () => {
  it("names the airports of every place, codes in any case", () => {
    const named = airportsInUserWords("fly from lhr to New York, or maybe Paris");
    for (const code of ["LHR", "JFK", "LGA", "EWR", "CDG"]) expect(named.has(code), code).toBe(true);
    expect(named.has("LGW")).toBe(false);
    expect(airportsInUserWords("cheap flights to Lisbon").has("LHR")).toBe(false);
  });

  it("does not read everyday words as codes, but keeps them in capitals", () => {
    expect([...airportsInUserWords("I was hoping to find cheap flights to Lisbon on 12 Nov")]).toEqual(["LIS"]);
    expect([...airportsInUserWords("What is the cheapest fare per person to Lisbon on 12 Nov?")]).toEqual(["LIS"]);
    expect([...airportsInUserWords("Can you find flights to Lisbon on 12 Nov?")]).toEqual(["LIS"]);
    for (const word of ["man", "sea", "mad", "oak", "san", "saw", "den", "sin"]) {
      expect(airportsInUserWords(`a ${word} to Lisbon`).size, word).toBe(1);
    }
    expect([...airportsInUserWords("flights to San Francisco")]).toEqual(["SFO"]);
    expect(airportsInUserWords("from MAN to LIS").has("MAN")).toBe(true);
  });

  it("lists the dates the text names, against local today", () => {
    expect([...datesNamedIn("leaving 12 Nov, back Nov 19th, or tomorrow", NOW, "UTC")].sort()).toEqual(["2026-10-23", "2026-11-12", "2026-11-19"]);
    expect(datesNamedIn("sometime next month", NOW, "UTC").size).toBe(0);
  });

  it("does not list a month and a count or a stay length as a date, or today's fares as today", () => {
    for (const text of ["in June 2 adults", "for Dec 4 people", "June 3 nights", "What are today's fares?"]) {
      expect(datesNamedIn(text, NOW, "UTC").size, text).toBe(0);
    }
    expect([...datesNamedIn("on 12 Nov for 2 adults", NOW, "UTC")]).toEqual(["2026-11-12"]);
  });
});
