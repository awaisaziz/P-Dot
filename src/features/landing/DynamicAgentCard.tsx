"use client";

import { useState, useEffect, useRef, useCallback } from "react";

export type AgentStepState = "done" | "approval" | "next";

export type SupportedTool =
  | "Calendar"
  | "Gmail"
  | "GitHub"
  | "Telegram"
  | "Vercel"
  | "WhatsApp"
  | "Phone"
  | "Search"
  | "Drive";

export interface AgentStep {
  title: string;
  tool?: SupportedTool;
  detail?: string;
  state: AgentStepState;
  approvalPrompt?: string;
  approvedDetail?: string;
  skippedDetail?: string;
}

export interface UseCase {
  id: string;
  tabLabel: string;
  icon: string;
  category: string;
  task: string;
  badgeWaiting: string;
  badgeApproved: string;
  badgeSkipped: string;
  steps: AgentStep[];
}

export const USE_CASES: readonly UseCase[] = [
  {
    id: "flights",
    tabLabel: "Flight check",
    icon: "✈️",
    category: "Travel, checked against sources",
    task: "Find me a flight from London to New York on 12 Nov",
    badgeWaiting: "1 step needs you",
    badgeApproved: "Reminder set ✓",
    badgeSkipped: "No reminder set",
    // No Google read here: a flight check runs first, and after it a reply may not search the web, run
    // another workflow or read Google (decision 0015, Tainted replies). A Google read first would block the check.
    steps: [
      {
        title: "Searched travel pages",
        tool: "Search",
        detail: "LHR to JFK on 12 Nov · 9 results, 4 pages read.",
        state: "done",
      },
      {
        title: "Verified 3 of 5 fares",
        detail: "Each fare is quoted from its page with the source and time; 2 were dropped.",
        state: "done",
      },
      {
        title: "Remind you to book",
        state: "approval",
        approvalPrompt: "Set a reminder for Friday 9:00 to book once you approve.",
        approvedDetail: "Reminder saved for Friday at 9:00.",
        skippedDetail: "No reminder set; the fares stay in the chat.",
      },
      {
        title: "Open the links to book",
        detail: "Google Flights and Skyscanner links; P-Dot never books or pays.",
        state: "next",
      },
    ],
  },
  {
    id: "errands",
    tabLabel: "Weekend errands",
    icon: "📅",
    category: "Personal life & booking",
    task: "Get me ready for Friday and book a haircut",
    badgeWaiting: "1 step needs you",
    badgeApproved: "All steps approved ✓",
    badgeSkipped: "Step skipped",
    steps: [
      {
        title: "Understood the goal",
        detail: "Prepare for Friday, book a haircut for Saturday morning.",
        state: "done",
      },
      {
        title: "Checked your calendar",
        tool: "Calendar",
        detail: "Two meetings Friday. Saturday 11:00 is free.",
        state: "done",
      },
      {
        title: "Read your inbox and drafted a reply",
        tool: "Gmail",
        detail: "One email needs an answer. Draft saved, not sent.",
        state: "done",
      },
      {
        title: "Ready to call the salon",
        state: "approval",
        approvalPrompt: "Book Saturday 11:00 by phone once you approve.",
        approvedDetail: "Call confirmed! Appointment reserved for Saturday at 11:00 AM.",
        skippedDetail: "Call skipped. Salon booking was not made.",
      },
      {
        title: "Then send your brief",
        tool: "Telegram",
        detail: "Summary and to-do list to your own chat.",
        state: "next",
      },
    ],
  },
  {
    id: "morning",
    tabLabel: "Morning triage",
    icon: "🌅",
    category: "Daily routine & inbox zero",
    task: "Triage inbox, protect focus time, and organize tasks",
    badgeWaiting: "1 step needs you",
    badgeApproved: "Reply dispatched ✓",
    badgeSkipped: "Draft preserved",
    steps: [
      {
        title: "Scanned 14 unread messages",
        tool: "Gmail",
        detail: "11 newsletters archived, 2 invoices filed, 1 partner proposal flagged.",
        state: "done",
      },
      {
        title: "Defended deep-work blocks",
        tool: "Calendar",
        detail: "3 meetings scheduled. 2-hour morning focus block protected.",
        state: "done",
      },
      {
        title: "Drafted reply to project partner",
        state: "approval",
        approvalPrompt: "Send the draft reply to Alex once you approve.",
        approvedDetail: "Email sent to Alex with agreed timeline and deliverables.",
        skippedDetail: "Draft preserved in Gmail Drafts for your manual review.",
      },
      {
        title: "Synced to-dos to today's list",
        detail: "Added 2 priority action items to your workspace checklist.",
        state: "next",
      },
      {
        title: "Delivered morning voice briefing",
        tool: "Telegram",
        detail: "90-second audio summary delivered directly to your chat.",
        state: "next",
      },
    ],
  },
  {
    id: "devops",
    tabLabel: "Dev & incidents",
    icon: "⚡",
    category: "DevOps & bug triage",
    task: "Triage failing production deployment and deploy hotfix",
    badgeWaiting: "1 step needs you",
    badgeApproved: "Hotfix deployed ✓",
    badgeSkipped: "Deploy paused",
    steps: [
      {
        title: "Detected deployment alert",
        tool: "Vercel",
        detail: "Production build failed on commit #842f (edge API route timeout).",
        state: "done",
      },
      {
        title: "Isolated root cause in git diff",
        tool: "GitHub",
        detail: "Found unhandled async promise timeout in session verification.",
        state: "done",
      },
      {
        title: "Opened hotfix PR with passing test",
        tool: "GitHub",
        detail: "PR #142 opened; test suite and regression checks passed in CI.",
        state: "done",
      },
      {
        title: "Authorize production hotfix deployment",
        state: "approval",
        approvalPrompt: "Merge PR #142 and promote it to production once you approve.",
        approvedDetail: "PR #142 merged and redeployed to production. All checks green.",
        skippedDetail: "Deployment paused. PR #142 held for manual engineer review.",
      },
      {
        title: "Broadcast incident resolution",
        tool: "Telegram",
        detail: "Posted post-mortem timeline and changelog link to #engineering.",
        state: "next",
      },
    ],
  },
  {
    id: "meeting",
    tabLabel: "Meeting prep",
    icon: "📊",
    category: "Work & meetings",
    task: "Prepare executive brief for 2:00 PM product review",
    badgeWaiting: "1 step needs you",
    badgeApproved: "Brief sent ✓",
    badgeSkipped: "Brief saved locally",
    steps: [
      {
        title: "Reviewed invite & attendees",
        tool: "Calendar",
        detail: "Quarterly review with Product Director and 3 department leads.",
        state: "done",
      },
      {
        title: "Read the planning doc",
        tool: "Drive",
        detail: "Q3 plan in Google Docs, first 6,000 characters.",
        state: "done",
      },
      {
        title: "Synthesized open stakeholder feedback",
        tool: "Gmail",
        detail: "Extracted 2 unresolved feedback items from yesterday's thread.",
        state: "done",
      },
      {
        title: "Distribute pre-read executive summary",
        state: "approval",
        approvalPrompt: "Send the 1-page summary to the 4 attendees once you approve.",
        approvedDetail: "Executive brief sent to all attendees with meeting agenda highlights.",
        skippedDetail: "Pre-read was not sent. Saved locally to your private workspace.",
      },
      {
        title: "Deliver talking points before call",
        tool: "Telegram",
        detail: "Push key talking points to your smartwatch 5 minutes before call.",
        state: "next",
      },
    ],
  },
] as const;

/** Whether a step comes after the case's approval step, so it follows the approve or skip choice. */
export function isAfterApproval(steps: readonly AgentStep[], index: number): boolean {
  const approval = steps.findIndex((step) => step.state === "approval");
  return approval !== -1 && index > approval;
}

type ApprovalStatus = "waiting" | "approved" | "skipped";

export function DynamicAgentCard() {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [approvalStates, setApprovalStates] = useState<Record<string, ApprovalStatus>>({});
  const [isPaused, setIsPaused] = useState(false);
  const [userInteracted, setUserInteracted] = useState(false);
  const containerRef = useRef<HTMLElement>(null);

  const fallbackCase: UseCase = USE_CASES[0] as UseCase;
  const currentCase: UseCase = USE_CASES[selectedIndex] ?? fallbackCase;
  const currentApprovalStatus = approvalStates[currentCase.id] ?? "waiting";

  const nextUseCase = useCallback(() => {
    setSelectedIndex((prev) => (prev + 1) % USE_CASES.length);
  }, []);

  const prevUseCase = useCallback(() => {
    setSelectedIndex((prev) => (prev - 1 + USE_CASES.length) % USE_CASES.length);
  }, []);

  const handleSelectCase = (index: number) => {
    setUserInteracted(true);
    setSelectedIndex(index);
  };

  const handleApprove = () => {
    setUserInteracted(true);
    setApprovalStates((prev) => ({
      ...prev,
      [currentCase.id]: "approved",
    }));
  };

  const handleSkip = () => {
    setUserInteracted(true);
    setApprovalStates((prev) => ({
      ...prev,
      [currentCase.id]: "skipped",
    }));
  };

  const handleReset = () => {
    setApprovalStates((prev) => ({
      ...prev,
      [currentCase.id]: "waiting",
    }));
  };

  // Auto-advance through use cases unless user is hovering, focused, or manually interacted
  useEffect(() => {
    if (isPaused || userInteracted) return;

    // Honor prefers-reduced-motion
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }

    const timer = setInterval(() => {
      setSelectedIndex((prev) => (prev + 1) % USE_CASES.length);
    }, 7000);

    return () => clearInterval(timer);
  }, [isPaused, userInteracted]);

  return (
    <section
      ref={containerRef}
      className="agent-card"
      aria-label="Example of personal bot agent runs"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
      onFocus={() => setIsPaused(true)}
      onBlur={() => setIsPaused(false)}
    >
      <div className="agent-card-nav">
        <div className="agent-tabs" role="tablist" aria-label="Personal bot use cases">
          {USE_CASES.map((useCase, idx) => {
            const isActive = idx === selectedIndex;
            return (
              <button
                key={useCase.id}
                type="button"
                role="tab"
                id={`agent-tab-${useCase.id}`}
                aria-selected={isActive}
                aria-controls={`agent-panel-${useCase.id}`}
                className={`agent-tab${isActive ? " is-active" : ""}`}
                onClick={() => handleSelectCase(idx)}
              >
                <span className="agent-tab-icon" aria-hidden="true">
                  {useCase.icon}
                </span>
                <span>{useCase.tabLabel}</span>
              </button>
            );
          })}
        </div>

        <div className="agent-nav-controls" aria-label="Use case carousel controls">
          <button
            type="button"
            className="agent-nav-btn"
            onClick={() => {
              setUserInteracted(true);
              prevUseCase();
            }}
            aria-label="Previous scenario"
            title="Previous scenario"
          >
            ‹
          </button>
          <button
            type="button"
            className="agent-nav-btn"
            onClick={() => {
              setUserInteracted(true);
              nextUseCase();
            }}
            aria-label="Next scenario"
            title="Next scenario"
          >
            ›
          </button>
        </div>
      </div>

      <div
        id={`agent-panel-${currentCase.id}`}
        role="tabpanel"
        aria-labelledby={`agent-tab-${currentCase.id}`}
        className="agent-card-panel"
      >
        <div className="agent-card-head">
          <div>
            <p className="small muted agent-label">
              Task <span className="agent-category-tag">• {currentCase.category}</span>
            </p>
            <p className="agent-task">{currentCase.task}</p>
          </div>
          {currentApprovalStatus === "waiting" && (
            <span className="chip chip-warning">{currentCase.badgeWaiting}</span>
          )}
          {currentApprovalStatus === "approved" && (
            <span className="chip chip-success">{currentCase.badgeApproved}</span>
          )}
          {currentApprovalStatus === "skipped" && (
            <span className="chip chip-neutral">{currentCase.badgeSkipped}</span>
          )}
        </div>

        <ol className="agent-steps">
          {currentCase.steps.map((step, index) => {
            const isApprovalStep = step.state === "approval";
            const isSubsequentStep = isAfterApproval(currentCase.steps, index);

            // Compute dynamic step display based on interactive approval state
            let stepStateClass = `agent-step-${step.state}`;
            let bulletClass = "agent-bullet";

            if (isApprovalStep) {
              if (currentApprovalStatus === "approved") {
                stepStateClass = "agent-step-done";
                bulletClass = "agent-bullet agent-bullet-done";
              } else if (currentApprovalStatus === "skipped") {
                stepStateClass = "agent-step-skipped";
                bulletClass = "agent-bullet agent-bullet-skipped";
              } else {
                stepStateClass = "agent-step-approval";
              }
            } else if (isSubsequentStep && currentApprovalStatus === "approved") {
              stepStateClass = "agent-step-done";
              bulletClass = "agent-bullet agent-bullet-done";
            }

            return (
              <li key={step.title} className={`agent-step ${stepStateClass}`}>
                <span className={bulletClass} aria-hidden="true">
                  {isApprovalStep && currentApprovalStatus === "approved" ? "✓" : index + 1}
                </span>

                <div className="agent-step-body">
                  <p className="agent-step-title">{step.title}</p>

                  {step.tool && (
                    <p className="agent-step-detail">
                      <span className={`chip chip-${step.tool.toLowerCase()}`}>{step.tool}</span> {step.detail}
                    </p>
                  )}

                  {!step.tool && step.state === "done" && !isApprovalStep && (
                    <p className="agent-step-detail">{step.detail}</p>
                  )}

                  {!step.tool && isSubsequentStep && (
                    <p className="agent-step-detail">
                      {currentApprovalStatus === "approved"
                        ? step.detail
                        : currentApprovalStatus === "skipped"
                        ? "Proceeding with remaining items..."
                        : step.detail}
                    </p>
                  )}

                  {isApprovalStep && (
                    <>
                      {currentApprovalStatus === "waiting" && (
                        <div className="agent-approval">
                          <p className="small">{step.approvalPrompt}</p>
                          <div className="actions">
                            <button
                              type="button"
                              className="button button-primary button-small"
                              onClick={handleApprove}
                            >
                              Approve
                            </button>
                            <button
                              type="button"
                              className="button button-small"
                              onClick={handleSkip}
                            >
                              Skip
                            </button>
                          </div>
                        </div>
                      )}

                      {currentApprovalStatus === "approved" && (
                        <div className="agent-approval agent-approval-confirmed">
                          <div className="agent-approval-header">
                            <span>✓ Approved by you</span>
                            <button
                              type="button"
                              className="agent-reset-btn"
                              onClick={handleReset}
                              title="Reset step state"
                            >
                              ↺ Reset
                            </button>
                          </div>
                          <p className="small">{step.approvedDetail}</p>
                        </div>
                      )}

                      {currentApprovalStatus === "skipped" && (
                        <div className="agent-approval agent-approval-skipped">
                          <div className="agent-approval-header">
                            <span>Bypassed by you</span>
                            <button
                              type="button"
                              className="agent-reset-btn"
                              onClick={handleReset}
                              title="Reset step state"
                            >
                              ↺ Reset
                            </button>
                          </div>
                          <p className="small">{step.skippedDetail}</p>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </div>

      <div className="agent-foot">
        <p className="small muted">Illustrative preview; calls, email sending, messaging and GitHub are not built yet.</p>
      </div>
    </section>
  );
}
