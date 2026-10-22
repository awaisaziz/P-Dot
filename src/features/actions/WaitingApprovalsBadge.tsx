"use client";

import { useEffect, useState } from "react";
import { ACTION_LIST_LIMIT } from "@/lib/limits";
import { fetchActions } from "./api";
import { onActionsChanged } from "./events";

/**
 * How many proposals wait for approval, shown on the Today
 * link. It reloads after a decision or a chat reply, and when the user comes
 * back to the tab. Nothing is shown while the count is unknown or zero.
 */
export function WaitingApprovalsBadge() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let controller: AbortController | null = null;
    const load = () => {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      // A failed load keeps the last count; the Today page shows the full list and its errors.
      fetchActions("proposed", current.signal).then((waiting) => setCount(waiting.length), () => {});
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    load();
    const stopListening = onActionsChanged(load);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopListening();
      document.removeEventListener("visibilitychange", onVisible);
      controller?.abort();
    };
  }, []);

  if (count === 0) return null;
  const shown = count >= ACTION_LIST_LIMIT ? `${ACTION_LIST_LIMIT - 1}+` : String(count);
  return (
    <>
      <span className="nav-badge" aria-hidden="true">
        {shown}
      </span>
      <span className="visually-hidden">
        , {shown} {count === 1 ? "action" : "actions"} waiting for your approval
      </span>
    </>
  );
}
