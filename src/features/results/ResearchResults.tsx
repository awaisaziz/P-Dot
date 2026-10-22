"use client";

import { useId } from "react";
import { useNow } from "@/components/ui/LocalTime";
import type { ResearchResult } from "@/types/workflows";
import { ExternalLink } from "./ExternalLink";
import { dropLine, readLine, resultWarning, sourceView } from "./format";

/**
 * Facts verified against the pages read (decision 0015). The verbatim quote is
 * the fact; the model's claim is only its label. "Verified" means the text is
 * on the page, not that the page is right.
 */
export function ResearchResults({ result }: { result: ResearchResult }) {
  const titleId = useId();
  const now = useNow();
  const claims = result.claims ?? [];
  const sources = result.sources ?? [];
  const drops = dropLine(result.dropped ?? {});
  const read = readLine(result.retrievedAt, now);
  // Amounts or times in the reply that no verified quote contains.
  const warning = resultWarning(result);

  return (
    <section className="result-card result-research" aria-labelledby={titleId}>
      {result.question && <p className="result-kicker">{result.question}</p>}
      <p id={titleId} className="result-title">
        Quotes found on the pages read
      </p>
      {warning && <p className="result-warning">{warning}</p>}
      {claims.length === 0 ? (
        <p className="result-empty">Nothing could be verified from the pages read.</p>
      ) : (
        <ul className="claim-list">
          {claims.map((claim, index) => {
            const view = sourceView(sources.find((source) => source.n === claim.source));
            return (
              <li key={`${claim.source}-${index}`} className="claim">
                <p className="claim-label">
                  <span>{claim.claim}</span>
                  {claim.paraphrased && <span className="result-chip result-chip-warn">paraphrased</span>}
                </p>
                {/* Page text, shown as text. */}
                <blockquote className="claim-quote">“{claim.quote}”</blockquote>
                <p className="hint claim-source">
                  From{" "}
                  {view.url ? <ExternalLink href={view.url}>{view.domain}</ExternalLink> : <span>{view.domain}</span>}
                </p>
              </li>
            );
          })}
        </ul>
      )}
      {drops && <p className="hint">{drops}</p>}
      {read && (
        <div className="result-foot">
          <span className="hint">{read.text}</span>
        </div>
      )}
    </section>
  );
}
