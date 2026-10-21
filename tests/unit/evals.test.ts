import { describe, expect, it } from "vitest";
import { EVAL_DATASET } from "../evals/dataset";
import { runEvalSuite } from "../evals/runner";

describe("AI-02: 50-Prompt Evaluation Benchmark", () => {
  it("contains exactly 50 curated evaluation cases across all 5 categories", () => {
    expect(EVAL_DATASET).toHaveLength(50);

    const categories = new Set(EVAL_DATASET.map((c) => c.category));
    expect(categories).toEqual(
      new Set([
        "tool_decision",
        "citation_grounding",
        "safety_injection",
        "context_formatting",
        "budget_cost",
      ]),
    );

    // Verify unique IDs
    const ids = new Set(EVAL_DATASET.map((c) => c.id));
    expect(ids.size).toBe(50);
  });

  it("verifies tool decision distribution (8 search, 7 no-search)", () => {
    const toolCases = EVAL_DATASET.filter((c) => c.category === "tool_decision");
    expect(toolCases).toHaveLength(15);

    const searchCount = toolCases.filter((c) => c.expectedTool === "web_search").length;
    const noSearchCount = toolCases.filter((c) => c.expectedTool === "none").length;
    expect(searchCount).toBe(8);
    expect(noSearchCount).toBe(7);
  });

  it("runs the evaluation runner harness successfully in mock mode with 100% pass rate", async () => {
    // No report file: a test run must not change a tracked file.
    const summary = await runEvalSuite({ isLive: false, writeReport: false });
    expect(summary.total).toBe(50);
    expect(summary.passed).toBe(50);
    expect(summary.passRate).toBe(100);
  });
});
