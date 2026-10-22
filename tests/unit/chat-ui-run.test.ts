import { describe, expect, it } from "vitest";
import {
  finishedReply,
  formatElapsed,
  liveReplyParts,
  mergeSteps,
  planStep,
  runCounts,
  runHeaderText,
  runOutcome,
  runOutcomeWords,
  runPanelVisible,
  upsertStep,
  type RunStep,
} from "@/features/chat/run";
import type { FlightResult, ResearchResult } from "@/types/workflows";

const step = (id: string, label: string, status: RunStep["status"] = "done", detail?: string): RunStep => ({
  id,
  label,
  status,
  ...(detail ? { detail } : {}),
});

const source = (n: number, url: string) => ({
  n,
  title: `Page ${n}`,
  url,
  domain: new URL(url).hostname,
  retrievedAt: "2026-10-21T13:05:00.000Z",
});

const flights = (overrides: Partial<FlightResult> = {}): FlightResult => ({
  kind: "flights",
  trip: {
    originLabel: "London (LHR)",
    destinationLabel: "New York (JFK)",
    departDate: "2026-11-12",
    passengers: 1,
    line: "London (LHR) to New York (JFK) · one way · Thu 12 Nov 2026 · 1 adult",
  },
  options: [],
  typical: [],
  dropped: { wrong_direction: 1, price_not_in_quote: 1 },
  links: [],
  sources: [source(1, "https://a.example/x"), source(2, "https://b.example/y")],
  summary: "",
  unverifiedMentions: [],
  retrievedAt: "2026-10-21T13:05:00.000Z",
  ...overrides,
});

describe("step lines", () => {
  it("updates a step in place and keeps the order of arrival", () => {
    let steps: ReadonlyMap<string, RunStep> = new Map();
    steps = upsertStep(steps, step("search", "Searching the web", "running"));
    steps = upsertStep(steps, step("read", "Reading 4 pages", "running"));
    steps = upsertStep(steps, step("search", "Searched the web · 9 results"));
    expect([...steps.values()].map((s) => [s.id, s.label])).toEqual([
      ["search", "Searched the web · 9 results"],
      ["read", "Reading 4 pages"],
    ]);
  });

  it("does not change the map it was given", () => {
    const before = new Map([["a", step("a", "A")]]);
    upsertStep(before, step("b", "B"));
    expect([...before.keys()]).toEqual(["a"]);
  });

  it("turns the model's plan into one line, with the full text as detail when long", () => {
    expect(planStep(0, "  Searching for\nflights…  ")).toEqual({
      id: "plan-0",
      label: "Searching for flights…",
      status: "done",
      plan: true,
    });
    const long = "I will search three travel sites for fares on that date, then read the best pages and check every price.";
    expect(planStep(1, long)).toMatchObject({ id: "plan-1", label: long, detail: long });
    expect(planStep(2, "   ")).toBeNull();
  });

  it("merges the saved steps into the live ones without losing the plan line", () => {
    let live: ReadonlyMap<string, RunStep> = new Map();
    live = upsertStep(live, planStep(0, "Searching for flights…")!);
    live = upsertStep(live, step("flights.search", "Searching", "running"));
    const merged = mergeSteps(live, [step("flights.search", "Searched · 9 results"), step("flights.verify", "Verified 3 of 5 fares", "partial")]);
    expect(merged.map((s) => s.id)).toEqual(["plan-0", "flights.search", "flights.verify"]);
    expect(merged[1]!.label).toBe("Searched · 9 results");
    expect(mergeSteps(live, undefined).map((s) => s.id)).toEqual(["plan-0", "flights.search"]);
  });
});

describe("a finished reply", () => {
  const live = (steps: RunStep[], results: FlightResult[] = []) => ({
    steps: new Map(steps.map((s) => [s.id, s])),
    results,
    elapsedMs: 14_000,
    open: null,
  });

  it("keeps the saved results, which alone carry the reply's unverified mentions", () => {
    const liveFlights = flights();
    const savedFlights = flights({ unverifiedMentions: ["£350", "09:40"] });
    const saved = { results: [savedFlights], steps: [step("flights.verify", "Verified 3 of 5 fares", "partial")] };
    const reply = finishedReply(saved, live([planStep(0, "Searching…")!, step("flights.verify", "Verifying", "running")], [liveFlights]));
    expect(reply.results).toBe(saved);
    expect(reply.results?.results[0]).toMatchObject({ unverifiedMentions: ["£350", "09:40"] });
    expect(reply.run?.steps.map((s) => [s.id, s.label])).toEqual([
      ["plan-0", "Searching…"],
      ["flights.verify", "Verified 3 of 5 fares"],
    ]);
    expect(reply.run).toMatchObject({ elapsedMs: 14_000, open: null });
  });

  it("falls back to the live results and steps, without the plan lines, when nothing was saved", () => {
    const reply = finishedReply(undefined, live([planStep(0, "Searching…")!, step("s", "Searched · 9 results")], [flights()]));
    expect(reply.results?.results).toHaveLength(1);
    expect(reply.results?.steps.map((s) => s.id)).toEqual(["s"]);
    expect(reply.run?.steps.map((s) => s.id)).toEqual(["plan-0", "s"]);
  });

  it("keeps a plan line for the panel but saves nothing when no workflow ran", () => {
    const reply = finishedReply(undefined, live([planStep(0, "Thinking it over")!]));
    expect(reply.results).toBeUndefined();
    expect(reply.run?.steps).toHaveLength(1);
    expect(finishedReply(undefined, live([]))).toEqual({});
  });
});

describe("run header counts", () => {
  const steps = [
    planStep(0, "Searching for flights…")!,
    step("flights.search", "Searched the web for LHR to JFK · 9 results"),
    step("flights.read", "Read 4 pages"),
    step("flights.extract", "Read the fares"),
    step("flights.verify", "Verified 3 of 5 fares", "partial", "2 dropped: wrong direction 1, price not in the quote 1"),
  ];

  it("counts pages read and dropped candidates from the verified results", () => {
    expect(runCounts(steps, [flights()])).toEqual({ steps: 4, pagesRead: 2, dropped: 2 });
  });

  it("counts each page once across results", () => {
    const research: ResearchResult = {
      kind: "research",
      question: "q",
      claims: [],
      dropped: { quote_not_found: 3 },
      sources: [source(1, "https://a.example/x"), source(3, "https://c.example/z")],
      summary: "",
      retrievedAt: "2026-10-21T13:05:00.000Z",
    };
    expect(runCounts(steps, [flights(), research])).toEqual({ steps: 4, pagesRead: 3, dropped: 5 });
  });

  it("falls back to the step lines when there is no lookup result", () => {
    expect(runCounts(steps, [])).toEqual({ steps: 4, pagesRead: 4, dropped: 2 });
    expect(runCounts([step("r", "Read 3 of 5 pages", "partial")], [])).toMatchObject({ pagesRead: 3 });
    // A page still being read is not counted yet.
    expect(runCounts([step("r", "Read 2 pages", "running")], [])).toMatchObject({ pagesRead: 0 });
  });

  it("says Working while streaming and what was done afterwards", () => {
    const counts = runCounts(steps, [flights()]);
    expect(runHeaderText({ streaming: true, counts })).toBe("Working · 4 steps");
    expect(runHeaderText({ streaming: true, counts: { steps: 0, pagesRead: 0, dropped: 0 } })).toBe("Working");
    expect(runHeaderText({ streaming: false, elapsedMs: 14_200, counts })).toBe(
      "Worked for 14 s · 4 steps · 2 pages read · 2 dropped",
    );
    // A saved reply has no elapsed time.
    expect(runHeaderText({ streaming: false, counts })).toBe("4 steps · 2 pages read · 2 dropped");
    expect(runHeaderText({ streaming: false, counts: { steps: 1, pagesRead: 1, dropped: 0 } })).toBe("1 step · 1 page read");
    expect(runHeaderText({ streaming: false, elapsedMs: 3000, counts: { steps: 0, pagesRead: 0, dropped: 0 } })).toBe(
      "Worked for 3 s",
    );
  });

  it("formats the elapsed time", () => {
    expect(formatElapsed(400)).toBe("0 s");
    expect(formatElapsed(59_400)).toBe("59 s");
    expect(formatElapsed(65_000)).toBe("1 min 5 s");
    expect(formatElapsed(180_000)).toBe("3 min");
    expect(formatElapsed(-5)).toBe("0 s");
  });

  it("says a failed or partial outcome in words, since the header icon is decorative", () => {
    expect(runOutcomeWords("failed")).toBe("Failed");
    expect(runOutcomeWords("partial")).toBe("Partly done");
    expect(runOutcomeWords("done")).toBeNull();
    expect(runOutcomeWords("running")).toBeNull();
    expect(runOutcomeWords(runOutcome(steps, false))).toBe("Partly done");
  });

  it("picks the header icon from the steps", () => {
    expect(runOutcome(steps, true)).toBe("running");
    expect(runOutcome(steps, false)).toBe("partial");
    expect(runOutcome([step("a", "A"), step("b", "B")], false)).toBe("done");
    expect(runOutcome([step("a", "A", "failed")], false)).toBe("failed");
    // A step left running on a finished reply was cut off.
    expect(runOutcome([step("a", "A", "running")], false)).toBe("partial");
    expect(runOutcome([planStep(0, "Plan")!], false)).toBe("done");
  });
});

describe("when a reply has a run panel", () => {
  const plan = planStep(0, "Let me add that for you.")!;

  it("never shows a finished reply's header over nothing", () => {
    expect(runPanelVisible([], [], false)).toBe(false);
    expect(runPanelVisible([], [flights()], false)).toBe(false);
    // Only the model's plan and no result: "Worked for 1 min 2 s" would stand alone.
    expect(runPanelVisible([plan], [], false)).toBe(false);
  });

  it("shows a finished reply with a counted step, or a plan next to its results", () => {
    expect(runPanelVisible([step("google-call_1", "Read 6 events from your calendar")], [], false)).toBe(true);
    expect(runPanelVisible([plan, step("flights.verify", "Verified 3 of 5 fares", "partial")], [], false)).toBe(true);
    expect(runPanelVisible([plan], [flights()], false)).toBe(true);
  });

  it("shows any line while streaming, the plan too", () => {
    expect(runPanelVisible([plan], [], true)).toBe(true);
    expect(runPanelVisible([], [], true)).toBe(false);
  });

  it("hides a saved reply's panel when its results were not stored", () => {
    // A reload of a reply whose results row is missing: no steps, no results.
    const reply = finishedReply(undefined, { steps: new Map(), results: [], elapsedMs: 62_000, open: null });
    expect(runPanelVisible(reply.run?.steps ?? reply.results?.steps ?? [], reply.results?.results ?? [], false)).toBe(false);
  });
});

describe("the live reply before its text", () => {
  it("says Thinking only while there is neither text nor a step", () => {
    expect(liveReplyParts({ text: "", steps: [], results: [] })).toEqual({ panel: false, thinking: true });
    expect(liveReplyParts({ text: "Hello", steps: [], results: [] })).toEqual({ panel: false, thinking: false });
  });

  it("opens the panel with a step that comes before any text, without Thinking beside it", () => {
    // A clear flight request runs the check before the first model call.
    const first = upsertStep(new Map(), step("flights.search", "Searching travel pages", "running"));
    expect(liveReplyParts({ text: "", steps: [...first.values()], results: [] })).toEqual({ panel: true, thinking: false });
  });
});
