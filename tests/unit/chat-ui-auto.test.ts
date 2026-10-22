import { describe, expect, it } from "vitest";
import { TAINTED_ASK_REASON } from "@/features/actions/format";
import {
  autoTurnsAfterDone,
  readsOutside,
  withTaintedReasons,
  withTaintedTurn,
  withoutTurn,
} from "@/features/chat/auto-turns";
import type { ActionProposalDTO, ChatStreamEvent, MessageRole } from "@/types/api";
import type { WorkflowStep } from "@/types/workflows";

const at = (minute: number) => `2026-10-21T10:${String(minute).padStart(2, "0")}:00.000Z`;
const msg = (id: string, role: MessageRole, minute: number) => ({ id, role, createdAt: at(minute) });
const proposal = (id: string, minute: number, status: ActionProposalDTO["status"] = "proposed"): ActionProposalDTO => ({
  id,
  conversationId: "c1",
  payload: { kind: "create_task", mode: "personal", title: "Pay the invoice" },
  summary: "Add task: Pay the invoice",
  status,
  result: null,
  createdAt: at(minute),
  decidedAt: null,
  verified: false,
});

const clean = new Set<string>();

describe("which turns Auto may act on", () => {
  it("adds a turn sent in Auto when the reply was not tainted", () => {
    expect([...autoTurnsAfterDone(new Set(), "u1", { sentInAuto: true, autoAllowed: true, tainted: clean })]).toEqual(["u1"]);
  });

  it("never adds a tainted reply, and removes it when it was there (a retry)", () => {
    const none = new Set<string>();
    expect(autoTurnsAfterDone(none, "u1", { sentInAuto: true, autoAllowed: false, tainted: clean })).toBe(none);
    expect([
      ...autoTurnsAfterDone(new Set(["u0", "u1"]), "u1", { sentInAuto: true, autoAllowed: false, tainted: clean }),
    ]).toEqual(["u0"]);
  });

  it("never adds a turn sent in Ask first", () => {
    expect([...autoTurnsAfterDone(new Set(["u1"]), "u1", { sentInAuto: false, autoAllowed: true, tainted: clean })]).toEqual([]);
    const none = new Set<string>();
    expect(autoTurnsAfterDone(none, "u2", { sentInAuto: false, autoAllowed: true, tainted: clean })).toBe(none);
  });

  it("refuses a turn an earlier attempt tainted, even when this reply read nothing", () => {
    const tainted = new Set(["u1"]);
    const none = new Set<string>();
    expect(autoTurnsAfterDone(none, "u1", { sentInAuto: true, autoAllowed: true, tainted })).toBe(none);
    expect([...autoTurnsAfterDone(new Set(["u0", "u1"]), "u1", { sentInAuto: true, autoAllowed: true, tainted })]).toEqual([
      "u0",
    ]);
    // Other turns are not affected.
    expect([...autoTurnsAfterDone(none, "u2", { sentInAuto: true, autoAllowed: true, tainted })]).toEqual(["u2"]);
  });
});

describe("taint from the stream itself", () => {
  const step = (id: string, status: WorkflowStep["status"] = "running"): ChatStreamEvent => ({
    type: "step",
    step: { id, label: "A step", status },
  });
  const drive: ChatStreamEvent = { type: "result", result: { kind: "drive", files: [] } };

  it("counts a Google or workflow step and any result as a read", () => {
    expect(readsOutside(step("google-call_1"))).toBe(true);
    expect(readsOutside(step("google-call_1", "done"))).toBe(true);
    expect(readsOutside(step("flights.search"))).toBe(true);
    expect(readsOutside(step("research.read", "partial"))).toBe(true);
    expect(readsOutside(drive)).toBe(true);
  });

  it("does not count a refused call, other tools, the toggle search or text", () => {
    // "Google is off for this message" and "Not run: no room" read nothing.
    expect(readsOutside(step("google-call_1", "failed"))).toBe(false);
    expect(readsOutside(step("flights.search", "failed"))).toBe(false);
    expect(readsOutside(step("google.grant", "failed"))).toBe(false);
    expect(readsOutside(step("tool-0-1", "done"))).toBe(false);
    expect(readsOutside(step("plan-0", "done"))).toBe(false);
    expect(readsOutside({ type: "search", status: "used", sources: [] })).toBe(false);
    expect(readsOutside({ type: "delta", text: "Hello" })).toBe(false);
  });

  it("adds a turn once, only when it read outside results", () => {
    const none = new Set<string>();
    expect(withTaintedTurn(none, "u1", false)).toBe(none);
    expect(withTaintedTurn(none, null, true)).toBe(none);
    const once = withTaintedTurn(none, "u1", true);
    expect([...once]).toEqual(["u1"]);
    expect(withTaintedTurn(once, "u1", true)).toBe(once);
  });

  it("keeps Auto off after a Retry of a tainted reply that failed or was stopped", () => {
    // Attempt 1 read a Drive file, proposed a task, then failed before `done`.
    const attempt1: ChatStreamEvent[] = [step("google-call_1"), step("google-call_1", "done"), drive];
    let tainted: ReadonlySet<string> = new Set();
    tainted = withTaintedTurn(tainted, "u1", attempt1.some(readsOutside));
    // Attempt 2 (Retry, same user message) read nothing and the server allows Auto.
    const autoTurns = autoTurnsAfterDone(new Set(), "u1", { sentInAuto: true, autoAllowed: true, tainted });
    expect(autoTurns.has("u1")).toBe(false);
  });

  it("removes a turn from Auto's set without touching the others", () => {
    const turns = new Set(["u0", "u1"]);
    expect([...withoutTurn(turns, "u1")]).toEqual(["u0"]);
    expect(withoutTurn(turns, "u9")).toBe(turns);
  });
});

describe("why a card from a tainted reply still asks", () => {
  const messages = [msg("u1", "user", 0), msg("a1", "assistant", 2), msg("u2", "user", 10), msg("a2", "assistant", 12)];
  const proposals = [proposal("p1", 1), proposal("p2", 11), proposal("p3", 11, "executed")];

  it("gives waiting proposals of a tainted turn the reason, in Auto only", () => {
    const reasons = withTaintedReasons(new Map(), proposals, messages, new Set(["u2"]), "auto");
    expect([...reasons]).toEqual([["p2", TAINTED_ASK_REASON]]);
    expect(withTaintedReasons(new Map(), proposals, messages, new Set(["u2"]), "manual").size).toBe(0);
  });

  it("keeps a reason that is already there", () => {
    const reasons = withTaintedReasons(new Map([["p2", "It saves something about you."]]), proposals, messages, new Set(["u2"]), "auto");
    expect(reasons.get("p2")).toBe("It saves something about you.");
  });
});
