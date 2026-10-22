"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { APPROVAL_MODE_LABELS } from "@/lib/approval-policy";
import type { ActionProposalDTO } from "@/types/api";
import { ApprovalCard } from "./ApprovalCard";
import { useApprovalMode } from "./approval-mode";
import { visibleProposals } from "./format";
import { useProposals } from "./useProposals";

/**
 * The Today panel: proposals that are waiting for approval, plus the ones
 * decided here (so the user sees the outcome). Chat shows proposals under the
 * reply that made them instead (features/chat/TurnExtras).
 */
export function ApprovalList({ initial }: { initial?: ActionProposalDTO[] }) {
  const router = useRouter();
  const approvalMode = useApprovalMode();
  const toLogin = useCallback(() => router.replace("/login?next=/today"), [router]);
  const { proposals, state, decidedHere, decided, stale, reload } = useProposals({ initial, onUnauthorized: toLogin });

  const onDecided = useCallback(
    (updated: ActionProposalDTO) => {
      decided(updated);
      // Today also lists tasks, so show the new item without a reload.
      if (updated.status === "executed") router.refresh();
    },
    [decided, router],
  );

  const visible = visibleProposals(proposals, {}, decidedHere);
  const waiting = visible.filter((p) => p.status === "proposed").length;

  return (
    <section className="panel" aria-labelledby="approval-heading">
      <div className="panel-heading">
        <h2 id="approval-heading">Waiting for your approval</h2>
        {waiting > 0 && <span className="status-pill status-proposed">{waiting} waiting</span>}
      </div>
      {state === "loading" && <p className="muted">Loading…</p>}
      {state === "error" && (
        <p className="alert alert-error small" role="alert">
          Could not load actions waiting for approval.{" "}
          <button type="button" className="link-button" onClick={reload}>
            Retry
          </button>
        </p>
      )}
      {state === "ready" && visible.length === 0 && (
        <p className="muted">Nothing is waiting; proposals from chat appear here until you approve them.</p>
      )}
      {visible.length > 0 && (
        <div className="approval-list">
          {visible.map((proposal) => (
            <ApprovalCard
              key={proposal.id}
              proposal={proposal}
              onDecided={onDecided}
              onStale={() => stale(proposal.id)}
              onUnauthorized={toLogin}
            />
          ))}
        </div>
      )}
      <p className="hint approval-mode-line">
        Approvals: <strong>{APPROVAL_MODE_LABELS[approvalMode]}</strong> · <Link href="/settings#approvals">Change</Link>
      </p>
    </section>
  );
}
