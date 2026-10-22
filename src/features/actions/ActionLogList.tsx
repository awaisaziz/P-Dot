"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LocalTime, formatLocal, useIsClient } from "@/components/ui/LocalTime";
import { ApiError, errorMessage } from "@/lib/api-client";
import type { ActionLogEntryDTO } from "@/types/api";
import { fetchActionLog } from "./api";
import { describeLogEntry } from "./format";

/** Groups entries (already newest first) by the viewer's local day. */
function groupByDay(entries: ActionLogEntryDTO[], dayOf: (iso: string) => string) {
  const groups: { day: string; entries: ActionLogEntryDTO[] }[] = [];
  for (const entry of entries) {
    const day = dayOf(entry.createdAt);
    const last = groups.at(-1);
    if (last?.day === day) last.entries.push(entry);
    else groups.push({ day, entries: [entry] });
  }
  return groups;
}

export function ActionLogList({ initialEntries, limit }: { initialEntries: ActionLogEntryDTO[]; limit: number }) {
  const router = useRouter();
  const isClient = useIsClient();
  const [entries, setEntries] = useState(initialEntries);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setEntries(await fetchActionLog());
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) router.replace("/login?next=/action-log");
      else setError(errorMessage(err, "Could not load the action log."));
    } finally {
      setLoading(false);
    }
  }

  // The server does not know the viewer's time zone, so it groups by UTC day until hydration.
  const groups = groupByDay(entries, (iso) => (isClient ? formatLocal(iso, "date") : `${iso.slice(0, 10)} (UTC)`));

  return (
    <section className="panel" aria-labelledby="log-heading" aria-busy={loading}>
      <div className="panel-heading">
        <h2 id="log-heading">Recent activity</h2>
        <button type="button" className="button button-small" onClick={() => void refresh()} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {error && (
        <p className="alert alert-error small" role="alert">
          {error}
        </p>
      )}
      {entries.length === 0 && (
        <p className="muted">Nothing yet; proposals, decisions and data changes will appear here.</p>
      )}
      {groups.map((group) => (
        <div key={group.day} className="log-day">
          <h3 className="log-day-title">{group.day}</h3>
          <ol className="log-list">
            {group.entries.map((entry) => {
              const view = describeLogEntry(entry);
              return (
                <li key={entry.id} className={`log-entry log-${view.tone}`}>
                  <span className="log-time">
                    <LocalTime iso={entry.createdAt} style="time" />
                  </span>
                  <span className="log-body">
                    <span className="log-title">{view.title}</span>
                    {view.facts.length > 0 && <span className="hint">{view.facts.join(" · ")}</span>}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      ))}
      {entries.length >= limit && <p className="hint">Showing the latest {limit} entries.</p>}
    </section>
  );
}
