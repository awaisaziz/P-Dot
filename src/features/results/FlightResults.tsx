"use client";

import { useId } from "react";
import { useNow } from "@/components/ui/LocalTime";
import type { FlightOption, FlightResult, QuotedSource } from "@/types/workflows";
import { ExternalLink } from "./ExternalLink";
import { QuoteBadge } from "./QuoteBadge";
import { basisChips, dropLine, flightFoot, handOffLinks, recheckMessage, resultWarning } from "./format";

const NOT_STATED = "not stated on page";

function FareCard({ option, source }: { option: FlightOption; source: QuotedSource | undefined }) {
  const chips = basisChips(option.basis ?? []);
  const facts: [string, string | undefined][] = [
    ["Departs", option.departs],
    ["Arrives", option.arrives],
    ["Stops", option.stops],
  ];
  const anyFact = facts.some(([, value]) => value);
  // The page's own words about how fresh it is, apart from when P-Dot read it.
  const freshness = source?.freshness?.trim();

  return (
    <li className="fare-card">
      <div className="fare-head">
        <span className="fare-airline">{option.airline}</span>
        {/* The price exactly as the page wrote it. */}
        <span className="fare-price">{option.priceText}</span>
      </div>
      {(chips.length > 0 || option.currency === null) && (
        <ul className="result-chips" aria-label="How the price is meant">
          {chips.map((chip) => (
            <li key={chip} className="result-chip">
              {chip}
            </li>
          ))}
          {option.currency === null && <li className="result-chip result-chip-muted">currency not stated</li>}
        </ul>
      )}
      {anyFact ? (
        <dl className="fare-facts">
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd className={value ? undefined : "muted"}>{value ?? NOT_STATED}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="hint">Times and stops {NOT_STATED}</p>
      )}
      {freshness && <p className="hint fare-freshness">Page says “{freshness}”</p>}
      <QuoteBadge quote={option.quote} source={source} />
    </li>
  );
}

/**
 * Fares the workflow verified against the pages it read (decision 0015). Code
 * built the trip line, the links and the counts; every price and time is the
 * page's own text, with the quote behind it one click away.
 */
export function FlightResults({
  result,
  onRecheck,
  busy = false,
}: {
  result: FlightResult;
  onRecheck?: (message: string) => void;
  /** A reply is streaming, so Re-check waits. */
  busy?: boolean;
}) {
  const titleId = useId();
  const typicalId = useId();
  const now = useNow();
  const options = result.options ?? [];
  const typical = result.typical ?? [];
  const sources = result.sources ?? [];
  const sourceFor = (n: number) => sources.find((source) => source.n === n);
  const warning = resultWarning(result);
  const drops = dropLine(result.dropped ?? {});
  const links = handOffLinks(result.links ?? []);
  // "No page was read" when the search found nothing to read, never a read time.
  const foot = flightFoot(result, now);

  return (
    <section className="result-card result-flights" aria-labelledby={titleId}>
      <p className="result-kicker">{result.trip.line}</p>
      <p id={titleId} className="result-title">
        Fares quoted on travel pages
      </p>
      {warning && <p className="result-warning">{warning}</p>}
      {options.length > 0 && (
        <ul className="fare-list" aria-label="Fares for your date">
          {options.map((option, index) => (
            <FareCard key={`${option.source}-${index}`} option={option} source={sourceFor(option.source)} />
          ))}
        </ul>
      )}
      {typical.length > 0 && (
        <div className="fare-typical">
          <p id={typicalId} className="result-subtitle">
            Typical prices on this route
          </p>
          <ul className="fare-list" aria-labelledby={typicalId}>
            {typical.map((option, index) => (
              <FareCard key={`${option.source}-${index}`} option={option} source={sourceFor(option.source)} />
            ))}
          </ul>
        </div>
      )}
      {options.length === 0 && typical.length === 0 && (
        <p className="result-empty">No fare could be verified from the pages read.</p>
      )}
      {drops && <p className="hint">{drops}</p>}
      {links.length > 0 && (
        <div className="result-links">
          {links.map((link) => (
            <ExternalLink key={link.url} href={link.url} className="button button-small result-link" label={link.label}>
              {link.text}
            </ExternalLink>
          ))}
        </div>
      )}
      {foot && (
        <div className="result-foot">
          <span className={foot.stale ? "result-stale" : "hint"}>{foot.text}</span>
          {foot.recheck && onRecheck && (
            <button
              type="button"
              className="button button-small"
              disabled={busy}
              onClick={() => onRecheck(recheckMessage(result))}
            >
              Re-check
            </button>
          )}
        </div>
      )}
    </section>
  );
}
