"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { APPROVAL_MODES, APPROVAL_MODE_LABELS, MAX_AUTO_ACTIONS_PER_REPLY, type ApprovalMode } from "@/lib/approval-policy";
import { setApprovalMode, useApprovalMode, useApprovalModeChosen } from "./approval-mode";

const DESCRIPTIONS: Record<ApprovalMode, string> = {
  manual: "Every action waits for your OK (recommended).",
  auto: `Adds tasks and reminders on its own (up to ${MAX_AUTO_ACTIONS_PER_REPLY} per reply, with Undo); everything else still asks.`,
};

function ModeIcon({ mode }: { mode: ApprovalMode }) {
  return mode === "auto" ? (
    // A bolt: acts on its own.
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
      <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />
    </svg>
  ) : (
    // A shield with a check: waits for your OK.
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-3z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

/**
 * The two modes as radio cards with what each does. Used in Settings, in the
 * first-run setup and in the composer menu. `onPicked` runs after a choice.
 */
export function ApprovalModeOptions({ onPicked, autoFocusChecked = false }: { onPicked?: () => void; autoFocusChecked?: boolean }) {
  const mode = useApprovalMode();
  const name = useId();
  return (
    <div role="radiogroup" aria-label="When P-Dot acts" className="approval-options">
      {APPROVAL_MODES.map((value) => (
        <label key={value} className="approval-option" data-approval={value}>
          <input
            type="radio"
            name={name}
            value={value}
            checked={mode === value}
            autoFocus={autoFocusChecked && mode === value}
            onChange={() => {
              setApprovalMode(value);
              onPicked?.();
            }}
          />
          <span className="approval-option-body">
            <span className="approval-option-title">
              <ModeIcon mode={value} /> {APPROVAL_MODE_LABELS[value]}
            </span>
            <span className="hint">{DESCRIPTIONS[value]}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

/**
 * Next to the message box: one button that always shows the current mode and
 * opens a small menu to change it. Works the same with touch, mouse and keyboard.
 */
export function ApprovalModeMenu() {
  const mode = useApprovalMode();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const anchorRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!anchorRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  return (
    <div className="tools-anchor approval-anchor" ref={anchorRef}>
      {open && (
        <div
          id={menuId}
          role="dialog"
          aria-label="When P-Dot acts"
          className="tools-menu approval-menu"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              close();
            }
          }}
        >
          <p className="approval-menu-title">When P-Dot acts</p>
          <ApprovalModeOptions onPicked={close} autoFocusChecked />
          <Link href="/settings#approvals" className="small" onClick={() => setOpen(false)}>
            What always asks
          </Link>
        </div>
      )}
      <button
        ref={buttonRef}
        type="button"
        className="chip-button approval-mode-button"
        data-approval={mode}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Approvals: ${APPROVAL_MODE_LABELS[mode]}. Change`}
        title="Choose whether P-Dot asks before every action"
        onClick={() => setOpen((value) => !value)}
      >
        <ModeIcon mode={mode} />
        <span>{APPROVAL_MODE_LABELS[mode]}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
          <path d="m6 15 6-6 6 6" />
        </svg>
      </button>
    </div>
  );
}

/**
 * Shown once in chat on a device where no mode was chosen yet. Choosing either
 * mode, or keeping the default, hides it for good on this device.
 */
export function ApprovalModeSetup() {
  const chosen = useApprovalModeChosen();
  if (chosen) return null;
  return (
    <section className="approval-setup" aria-labelledby="approval-setup-heading">
      <div className="panel-heading">
        <h2 id="approval-setup-heading">How should P-Dot act?</h2>
        <button type="button" className="link-button small" onClick={() => setApprovalMode("manual")}>
          Keep Ask first
        </button>
      </div>
      <ApprovalModeOptions />
      <p className="hint">Change it any time next to the message box or in Settings.</p>
    </section>
  );
}
