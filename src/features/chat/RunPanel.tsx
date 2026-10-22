"use client";

import { useId, useState } from "react";
import type { MessageResult, StepStatus } from "@/types/workflows";
import {
  STEP_STATUS_WORDS,
  runCounts,
  runHeaderText,
  runOutcome,
  runOutcomeWords,
  runPanelVisible,
  type RunStep,
} from "./run";

type IconStatus = StepStatus | "plan" | "stopped";

/** A status icon. Decorative: the row says its status in words for assistive technology. */
export function StepIcon({ status }: { status: IconStatus }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2.25,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    className: `step-icon step-icon-${status}`,
  };
  switch (status) {
    case "running":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8" opacity="0.25" />
          <path d="M20 12a8 8 0 0 0-8-8" />
        </svg>
      );
    case "done":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="m8 12.5 2.5 2.5L16 9.5" />
        </svg>
      );
    case "partial":
      return (
        <svg {...common}>
          <path d="M12 3.5 21.5 20h-19L12 3.5z" />
          <path d="M12 10v4M12 17.25v.01" />
        </svg>
      );
    case "failed":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="m9 9 6 6M15 9l-6 6" />
        </svg>
      );
    case "stopped":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M9 12h6" />
        </svg>
      );
    case "plan":
      return (
        <svg {...common}>
          <path d="M5 5h14v10H9l-4 4V5z" />
        </svg>
      );
  }
}

function rowStatus(step: RunStep, streaming: boolean): IconStatus {
  if (step.plan) return "plan";
  // A step still marked running on a finished reply was cut off.
  if (step.status === "running" && !streaming) return "stopped";
  return step.status;
}

const ROW_WORDS: Record<IconStatus, string> = { ...STEP_STATUS_WORDS, plan: "Plan", stopped: "Not finished" };

function StepRow({ step, streaming }: { step: RunStep; streaming: boolean }) {
  const detailId = useId();
  const [open, setOpen] = useState(false);
  const status = rowStatus(step, streaming);
  const words = <span className="visually-hidden">{ROW_WORDS[status]}: </span>;

  if (!step.detail) {
    return (
      <li className={`run-step run-step-${status}`}>
        <StepIcon status={status} />
        <span className="run-step-label">
          {words}
          {step.label}
        </span>
      </li>
    );
  }
  return (
    <li className={`run-step run-step-${status} has-detail`}>
      <button
        type="button"
        className="run-step-toggle"
        data-focus-key={`step-${step.id}`}
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpen((value) => !value)}
      >
        <StepIcon status={status} />
        <span className="run-step-label">
          {words}
          {step.label}
        </span>
        <Chevron open={open} />
      </button>
      <p id={detailId} className="run-step-detail" hidden={!open}>
        {step.detail}
      </p>
    </li>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`run-chevron${open ? " is-open" : ""}`}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

/**
 * What P-Dot did for one reply: a one-line header (an APG disclosure button)
 * over one line per step. It is not a live region; the chat announces each
 * step once through its own status line.
 */
export function RunPanel({
  steps,
  results,
  streaming,
  elapsedMs,
  initialOpen,
  onToggle,
}: {
  steps: readonly RunStep[];
  results: readonly MessageResult[];
  streaming: boolean;
  /** Only for a reply streamed on this page. */
  elapsedMs?: number | null;
  initialOpen: boolean;
  /** Called with the user's choice, so the panel keeps it when the reply is saved. */
  onToggle?: (open: boolean) => void;
}) {
  const listId = useId();
  const [open, setOpen] = useState(initialOpen);
  if (!runPanelVisible(steps, results, streaming)) return null;
  const header = runHeaderText({ streaming, elapsedMs, counts: runCounts(steps, results) });
  const outcome = runOutcome(steps, streaming);
  // The icon is decorative, so a failed or partial run says so in words too.
  const outcomeWords = runOutcomeWords(outcome);

  return (
    <section className={`run-panel run-${outcome}`} aria-label="What P-Dot did">
      <button
        type="button"
        className="run-header"
        data-focus-key="run-header"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => {
          setOpen(!open);
          onToggle?.(!open);
        }}
      >
        <StepIcon status={outcome} />
        <span className="run-header-text">
          {outcomeWords && <span className="visually-hidden">{outcomeWords}: </span>}
          {header}
        </span>
        <Chevron open={open} />
      </button>
      <ol id={listId} className="run-steps" hidden={!open}>
        {steps.map((step) => (
          <StepRow key={step.id} step={step} streaming={streaming} />
        ))}
      </ol>
    </section>
  );
}
