import { describe, expect, it } from "vitest";
import { USE_CASES, isAfterApproval } from "@/features/landing/DynamicAgentCard";

describe("landing page dynamic use cases", () => {
  it("provides multiple diverse use cases demonstrating personal bot usage", () => {
    expect(USE_CASES.length).toBeGreaterThanOrEqual(4);
  });

  it("includes the foundational haircut/errands scenario preserving initial design", () => {
    const haircutCase = USE_CASES.find((c) => c.id === "errands");
    expect(haircutCase).toBeDefined();
    expect(haircutCase?.task).toBe("Get me ready for Friday and book a haircut");
    expect(haircutCase?.steps).toHaveLength(5);

    const toolsUsed = haircutCase?.steps.map((s) => s.tool).filter(Boolean);
    expect(toolsUsed).toContain("Calendar");
    expect(toolsUsed).toContain("Gmail");
    expect(toolsUsed).toContain("Telegram");
  });

  it("ensures every use case has valid required metadata, unique IDs, and an approval step", () => {
    const ids = new Set<string>();

    for (const useCase of USE_CASES) {
      expect(ids.has(useCase.id)).toBe(false);
      ids.add(useCase.id);

      expect(useCase.tabLabel).toBeTruthy();
      expect(useCase.icon).toBeTruthy();
      expect(useCase.category).toBeTruthy();
      expect(useCase.task).toBeTruthy();
      expect(useCase.badgeWaiting).toBeTruthy();
      expect(useCase.badgeApproved).toBeTruthy();
      expect(useCase.badgeSkipped).toBeTruthy();
      expect(useCase.steps.length).toBeGreaterThanOrEqual(4);

      // Verify human-in-the-loop approval step exists
      const approvalStep = useCase.steps.find((s) => s.state === "approval");
      expect(approvalStep).toBeDefined();
      expect(approvalStep?.approvalPrompt).toBeTruthy();
      expect(approvalStep?.approvedDetail).toBeTruthy();
      expect(approvalStep?.skippedDetail).toBeTruthy();
    }
  });

  it("never shows a web search after a Google read in the same run (decision 0015, tainted replies)", () => {
    for (const useCase of USE_CASES) {
      const firstRead = useCase.steps.findIndex((s) => s.tool === "Calendar" || s.tool === "Drive");
      if (firstRead === -1) continue;
      const later = useCase.steps.slice(firstRead + 1).map((s) => s.tool);
      expect(later, useCase.id).not.toContain("Search");
    }
  });

  it("never shows a Google read after a web search or a flight check (decision 0015, tainted replies)", () => {
    for (const useCase of USE_CASES) {
      const firstSearch = useCase.steps.findIndex((s) => s.tool === "Search");
      if (firstSearch === -1) continue;
      const later = useCase.steps.slice(firstSearch + 1).map((s) => s.tool);
      expect(later, useCase.id).not.toContain("Calendar");
      expect(later, useCase.id).not.toContain("Drive");
    }
  });

  it("lets every step after the approval follow the approve or skip choice", () => {
    const flights = USE_CASES.find((c) => c.id === "flights")!;
    const approval = flights.steps.findIndex((s) => s.state === "approval");
    expect(flights.steps.map((_, index) => isAfterApproval(flights.steps, index))).toEqual(
      flights.steps.map((_, index) => index > approval),
    );
    expect(isAfterApproval(flights.steps, flights.steps.length - 1)).toBe(true);
    expect(isAfterApproval([{ title: "Only", state: "done" }], 0)).toBe(false);
  });

  it("covers key tool integrations across scenarios", () => {
    const allTools = new Set(
      USE_CASES.flatMap((c) => c.steps.map((s) => s.tool).filter(Boolean))
    );

    expect(allTools.has("Calendar")).toBe(true);
    expect(allTools.has("Gmail")).toBe(true);
    expect(allTools.has("GitHub")).toBe(true);
    expect(allTools.has("Telegram")).toBe(true);
    expect(allTools.has("Search")).toBe(true);
  });
});
