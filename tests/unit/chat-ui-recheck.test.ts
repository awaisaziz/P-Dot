import { describe, expect, it } from "vitest";
import { recheckMessage } from "@/features/results/format";
import { detectFlightIntent } from "@/server/assistant/workflows/intent";

// Re-check sends a new message. It must read as a fare search, so the server
// forces the verified flight workflow and no unverified excerpt reaches the answer (decision 0015).
describe("the Re-check message", () => {
  const trips = [
    "London (LHR) to New York (JFK) · one way · Thu 12 Nov 2026 · 1 adult",
    "London (LHR) to New York (JFK) · round trip · Thu 12 Nov 2026 to Sun 15 Nov 2026 · 2 adults",
    "Paris (CDG) to Lisbon (LIS) · one way · Fri 4 Dec 2026 · 3 adults",
  ];

  it.each(trips)("forces the flight workflow for %s", (line) => {
    const message = recheckMessage({ trip: { line } as never });
    expect(detectFlightIntent(message)).toBe(true);
  });
});
