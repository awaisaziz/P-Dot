"use client";

import { useId, useState } from "react";
import type { QuotedSource } from "@/types/workflows";
import { ExternalLink } from "./ExternalLink";
import { sourceView } from "./format";

/**
 * "Quoted from <domain>": a disclosure that shows the verbatim quote behind a
 * fact and a link to the page.
 */
export function QuoteBadge({ quote, source }: { quote: string; source: QuotedSource | undefined }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const view = sourceView(source);

  return (
    <div className="quote">
      <button
        type="button"
        className="quote-badge"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-3z" />
          <path d="m9 12 2 2 4-4" />
        </svg>
        <span>Quoted from {view.domain}</span>
      </button>
      <div id={id} className="quote-body" hidden={!open}>
        {/* Page text, shown as text. */}
        <blockquote className="quote-text">“{quote}”</blockquote>
        <p className="hint quote-meta">
          {view.url ? <ExternalLink href={view.url}>Open {view.domain}</ExternalLink> : <span>Link not available</span>}
        </p>
      </div>
    </div>
  );
}
