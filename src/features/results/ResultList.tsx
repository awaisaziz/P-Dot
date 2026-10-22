"use client";

import type { MessageResult } from "@/types/workflows";
import { CalendarResults, DriveResults } from "./AccountResults";
import { FlightResults } from "./FlightResults";
import { ResearchResults } from "./ResearchResults";

/** The verified results of one reply, as cards between its run panel and its text. */
export function ResultList({
  results,
  onRecheck,
  busy,
}: {
  results: readonly MessageResult[];
  onRecheck?: (message: string) => void;
  busy?: boolean;
}) {
  if (results.length === 0) return null;
  return (
    <div className="result-list">
      {results.map((result, index) => {
        const key = `${result.kind}-${index}`;
        switch (result.kind) {
          case "flights":
            return <FlightResults key={key} result={result} onRecheck={onRecheck} busy={busy} />;
          case "research":
            return <ResearchResults key={key} result={result} />;
          case "calendar":
            return <CalendarResults key={key} result={result} />;
          case "drive":
            return <DriveResults key={key} result={result} />;
          default:
            // A kind this tab does not know yet is left out.
            return null;
        }
      })}
    </div>
  );
}
