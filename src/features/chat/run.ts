// The run panel's data: one line per step, in arrival order, and the one-line
// header. Pure functions, so they are unit-tested (tests/unit/chat-ui-run.test.ts).
import type { MessageResult, MessageResultsPayload, StepStatus, WorkflowStep } from "@/types/workflows";

/** A step line. `plan` marks the model's own plan (a `thought` event), which is shown but not counted. */
export interface RunStep extends WorkflowStep {
  plan?: boolean;
}

export type RunSteps = ReadonlyMap<string, RunStep>;

/** A plan line longer than this keeps its full text as the expandable detail. */
const PLAN_LABEL_CHARS = 90;

/** Adds a step, or updates the line with the same id in place, so the order stays the order of arrival. */
export function upsertStep(steps: RunSteps, step: RunStep): Map<string, RunStep> {
  const next = new Map(steps);
  next.set(step.id, step);
  return next;
}

/** The model's plan before a tool call, as a step line. */
export function planStep(index: number, text: string): RunStep | null {
  const label = text.replace(/\s+/g, " ").trim();
  if (!label) return null;
  return {
    id: `plan-${index}`,
    label,
    status: "done",
    plan: true,
    ...(label.length > PLAN_LABEL_CHARS ? { detail: label } : {}),
  };
}

/** Merges the saved steps into the live ones: same ids update in place, new ids go last. */
export function mergeSteps(live: RunSteps, saved: readonly WorkflowStep[] | undefined): RunStep[] {
  let merged: RunSteps = live;
  for (const step of saved ?? []) merged = upsertStep(merged, step);
  return [...merged.values()];
}

/** A reply streamed on this page: its steps with plan lines, how long it took, and the user's open or close. */
export interface LiveRun {
  steps: RunStep[];
  elapsedMs: number;
  open: boolean | null;
}

/**
 * What a finished reply keeps. The saved results win over the live ones
 * (only the saved copy carries the reply's unverified mentions), and the
 * plan lines stay in front of the saved steps.
 */
export function finishedReply(
  saved: MessageResultsPayload | undefined,
  live: { steps: RunSteps; results: readonly MessageResult[]; elapsedMs: number; open: boolean | null },
): { results?: MessageResultsPayload; run?: LiveRun } {
  const steps = mergeSteps(live.steps, saved?.steps);
  const workflowSteps = steps.filter((step) => !step.plan);
  const results = [...live.results];
  const payload =
    saved ?? (results.length > 0 || workflowSteps.length > 0 ? { results, steps: workflowSteps } : undefined);
  return {
    ...(payload ? { results: payload } : {}),
    ...(steps.length > 0 ? { run: { steps, elapsedMs: live.elapsedMs, open: live.open } } : {}),
  };
}

export interface RunCounts {
  steps: number;
  pagesRead: number;
  dropped: number;
}

const READ_LABEL = /^Read (\d+)(?: of \d+)? pages?$/;
const DROPPED = /\b(\d+) dropped\b/;

function sumDropped(dropped: Partial<Record<string, number>>): number {
  return Object.values(dropped).reduce<number>((sum, count) => sum + (typeof count === "number" && count > 0 ? count : 0), 0);
}

/**
 * Counts for the header. Pages read and dropped candidates come from the
 * verified results when there are any, else from the step lines.
 */
export function runCounts(steps: Iterable<RunStep>, results: readonly MessageResult[]): RunCounts {
  const counted = [...steps].filter((step) => !step.plan);
  const pages = new Set<string>();
  let dropped = 0;
  let lookups = 0;
  for (const result of results) {
    if (result.kind !== "flights" && result.kind !== "research") continue;
    lookups += 1;
    for (const source of result.sources) pages.add(source.url);
    dropped += sumDropped(result.dropped);
  }
  if (lookups > 0) return { steps: counted.length, pagesRead: pages.size, dropped };

  let pagesRead = 0;
  for (const step of counted) {
    if (step.status === "running" || step.status === "failed") continue;
    const read = READ_LABEL.exec(step.label);
    if (read) pagesRead += Number(read[1]);
    const drop = DROPPED.exec(step.detail ?? "") ?? DROPPED.exec(step.label);
    if (drop) dropped += Number(drop[1]);
  }
  return { steps: counted.length, pagesRead, dropped };
}

/** "14 s", "1 min 5 s", "3 min". */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The one-line header: "Working · 3 steps" while streaming, "Worked for 14 s ·
 * 4 steps · 4 pages read · 2 dropped" when done. Saved replies have no elapsed time.
 */
export function runHeaderText({
  streaming,
  elapsedMs,
  counts,
}: {
  streaming: boolean;
  elapsedMs?: number | null;
  counts: RunCounts;
}): string {
  if (streaming) return counts.steps > 0 ? `Working · ${count(counts.steps, "step", "steps")}` : "Working";
  const parts: string[] = [];
  if (typeof elapsedMs === "number") parts.push(`Worked for ${formatElapsed(elapsedMs)}`);
  if (counts.steps > 0 || parts.length === 0) parts.push(count(counts.steps, "step", "steps"));
  if (counts.pagesRead > 0) parts.push(`${count(counts.pagesRead, "page", "pages")} read`);
  if (counts.dropped > 0) parts.push(`${counts.dropped} dropped`);
  return parts.join(" · ");
}

/** The header's icon: running while any step runs, failed when every step failed, partial when any did not finish cleanly. */
export function runOutcome(steps: Iterable<RunStep>, streaming: boolean): StepStatus {
  if (streaming) return "running";
  const counted = [...steps].filter((step) => !step.plan);
  if (counted.length === 0) return "done";
  if (counted.every((step) => step.status === "failed")) return "failed";
  if (counted.some((step) => step.status !== "done")) return "partial";
  return "done";
}

export const STEP_STATUS_WORDS: Record<StepStatus, string> = {
  running: "Running",
  done: "Done",
  partial: "Partly done",
  failed: "Failed",
};

/** Words for the header's outcome, which the icon shows only visually. Null when it went as planned or is still running. */
export function runOutcomeWords(outcome: StepStatus): string | null {
  return outcome === "failed" || outcome === "partial" ? STEP_STATUS_WORDS[outcome] : null;
}

/**
 * Whether a reply has a run panel. While streaming, any line shows (the
 * model's plan too). A finished reply needs a counted step, or a plan line
 * next to its result cards, so a header like "Worked for 1 min 2 s" never
 * stands over nothing.
 */
export function runPanelVisible(
  steps: readonly RunStep[],
  results: readonly MessageResult[],
  streaming: boolean,
): boolean {
  if (steps.length === 0) return false;
  if (streaming) return true;
  return results.length > 0 || steps.some((step) => !step.plan);
}

/**
 * What the live reply shows before its text: the run panel once the first
 * line arrives (a flight check can send a step before the model's first
 * token), and the "Thinking…" line only while there is neither text nor panel.
 */
export function liveReplyParts({
  text,
  steps,
  results,
}: {
  text: string;
  steps: readonly RunStep[];
  results: readonly MessageResult[];
}): { panel: boolean; thinking: boolean } {
  const panel = runPanelVisible(steps, results, true);
  return { panel, thinking: !text && !panel };
}
