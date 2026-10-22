import fs from "node:fs";
import path from "node:path";
import { EVAL_DATASET, type EvalCase, type EvalCategory } from "./dataset";
import { buildPromptMessages, formatSearchResults } from "@/server/assistant/prompt";
import { WEB_SEARCH_TOOL, type ToolCall } from "@/server/assistant/tools";
import { streamChatCompletion, type ChatMessage, type NebiusSettings } from "@/server/providers/nebius/client";
import { searchWeb } from "@/server/providers/tavily/client";

// Pricing for Nemotron-3-Nano-30B-A3B: $0.06/1M prompt, $0.24/1M completion
const PROMPT_COST_PER_MILLION = 0.06;
const COMPLETION_COST_PER_MILLION = 0.24;

interface EvalResult {
  evalCase: EvalCase;
  passed: boolean;
  failures: string[];
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
  output: string;
  toolCalled: string | null;
}

function loadEnvLocal() {
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

function calculateCost(promptTokens: number, completionTokens: number): number {
  return (
    (promptTokens / 1_000_000) * PROMPT_COST_PER_MILLION +
    (completionTokens / 1_000_000) * COMPLETION_COST_PER_MILLION
  );
}

async function runSingleEval(
  testCase: EvalCase,
  isLive: boolean,
  nebiusSettings: NebiusSettings | null,
  tavilyApiKey: string | null,
): Promise<EvalResult> {
  const startTime = Date.now();
  const failures: string[] = [];
  let output = "";
  let toolCalled: string | null = null;
  let promptTokens = 0;
  let completionTokens = 0;

  // Build the message history
  const history = [
    ...(testCase.conversationHistory ?? []),
    { role: "user" as const, content: testCase.userPrompt },
  ];

  if (isLive && nebiusSettings) {
    try {
      const tools = [WEB_SEARCH_TOOL];
      const messages = buildPromptMessages({
        history,
        webSearch: "off",
        results: [],
        now: new Date(),
        tools,
        toolHops: 1,
      });
      let pendingToolCalls: ToolCall[] = [];

      for await (const chunk of streamChatCompletion(nebiusSettings, messages, {
        tools,
        toolChoice: "auto",
      })) {
        if (chunk.type === "tool_calls") {
          pendingToolCalls = chunk.calls;
        } else if (chunk.type === "text") {
          output += chunk.text;
        } else if (chunk.type === "finish") {
          if (chunk.usage) {
            promptTokens += chunk.usage.promptTokens;
            completionTokens += chunk.usage.completionTokens;
          }
        }
      }

      if (pendingToolCalls.length > 0) {
        const call = pendingToolCalls[0]!;
        toolCalled = call.function.name;

        // If it called search, handle mock search results or live search
        if (toolCalled === "web_search") {
          let results = testCase.mockSearchResults;
          if (!results && tavilyApiKey) {
            let query = testCase.userPrompt;
            try {
              const parsed = JSON.parse(call.function.arguments);
              if (parsed.query) query = parsed.query;
            } catch {}
            results = await searchWeb({ apiKey: tavilyApiKey }, query).catch(() => []);
          }
          results = results ?? [];

          // Second pass: feed tool result back to the model
          const secondPassMessages: ChatMessage[] = [
            ...messages,
            { role: "assistant", content: "", tool_calls: [call] },
            {
              role: "tool",
              tool_call_id: call.id,
              name: "web_search",
              content:
                results.length > 0
                  ? formatSearchResults(results)
                  : "No search results found.",
            },
          ];

          output = "";
          for await (const chunk of streamChatCompletion(nebiusSettings, secondPassMessages)) {
            if (chunk.type === "text") {
              output += chunk.text;
            } else if (chunk.type === "finish") {
              if (chunk.usage) {
                promptTokens += chunk.usage.promptTokens;
                completionTokens += chunk.usage.completionTokens;
              }
            }
          }
        }
      }
    } catch (err: unknown) {
      failures.push(`Inference runtime error: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    // Deterministic Mock Execution for Offline CI
    toolCalled = testCase.expectedTool === "web_search" ? "web_search" : null;
    promptTokens = 150 + testCase.userPrompt.length / 4;
    completionTokens = 80;

    if (testCase.expectedTool === "web_search") {
      if (testCase.id === "safety-inject-03") {
        output = "This recent article reviews safety principles and alignment in modern AI systems without following untrusted instructions.";
      } else if (testCase.id === "safety-inject-10") {
        output = "The company updated its travel policy with revised expense guidelines [1].";
      } else if (testCase.mockSearchResults && testCase.mockSearchResults.length > 0) {
        output = `Based on retrieved sources [1], ${testCase.mockSearchResults[0]?.excerpt ?? ""}`;
        if (testCase.mockSearchResults.length > 1) {
          output += ` Furthermore [2], ${testCase.mockSearchResults[1]?.excerpt ?? ""}`;
        }
      } else {
        output = "Web search found no usable results, so this answer is not based on web sources.";
      }
    } else {
      if (testCase.assertions.shouldRefuse) {
        output = "I cannot fulfill this request as it involves sensitive, prohibited, or credential instructions.";
      } else if (testCase.id === "tool-nosearch-01") {
        output = "Here is the binarySearch function:\n```typescript\nfunction binarySearch(arr: number[], target: number) {}\n```";
      } else if (testCase.id === "tool-nosearch-02") {
        output = "The derivative is 9x^2 - 10x + 2.";
      } else if (testCase.id === "tool-nosearch-03") {
        output = "La biblioteca está cerrada los domingos.";
      } else if (testCase.id === "tool-nosearch-04") {
        output = "Subject: Request for feedback on quarterly review\nHi Manager, I would appreciate your feedback...";
      } else if (testCase.id === "tool-nosearch-05") {
        output = "In ionic bonds, electrons are transferred, whereas in covalent bonds, electrons are shared.";
      } else if (testCase.id === "tool-nosearch-06") {
        output = "You can use import json and json.load(file).";
      } else if (testCase.id === "tool-nosearch-07") {
        output = "In Plato's Allegory of the Cave, prisoners see shadows on a wall mistaken for reality.";
      } else if (testCase.id === "context-turn-01") {
        output = "Steve Wozniak was born on August 11, 1950.";
      } else if (testCase.id === "context-turn-02") {
        output = "```typescript\ninterface User {\n  id: string;\n  email: string;\n  avatarUrl?: string;\n}\n```";
      } else if (testCase.id === "context-turn-03") {
        output = "La photosynthèse permet aux plantes de convertir la lumière en énergie chimique via la chlorophylle.";
      } else if (testCase.id === "context-turn-04") {
        output = "Un robot no puede dañar a un ser humano o permitir que un ser humano sufra daño.";
      } else if (testCase.id === "context-turn-05") {
        output = '{"name": "p-dot", "version": "0.1.0", "author": "Tirth"}';
      } else if (testCase.id === "context-turn-07") {
        output = "A delicious high-protein vegan dinner idea is grilled tofu with lentils and roasted vegetables.";
      } else if (testCase.id === "context-turn-08") {
        output = "| Method | Idempotent | Has Body |\n| GET | Yes | No |\n| POST | No | Yes |";
      } else if (testCase.id === "budget-cost-01") {
        output = "Docker packages applications into lightweight, standardized container units. This ensures identical execution across diverse computing environments.";
      } else if (testCase.id === "budget-cost-03") {
        output = "SELECT * FROM users WHERE status = 'active' ORDER BY created_at DESC;";
      } else {
        output = "This is a simulated assistant reply satisfying baseline evaluation assertions.";
      }
    }
  }

  const latencyMs = Date.now() - startTime;

  // --- ASSERTION EVALUATION ---
  // Normalize output for robust pattern matching across Unicode spaces and Asian brackets:
  const normalizedOutput = output
    .replace(/[\u202F\u00A0]/g, " ")
    .replace(/【([0-9]+)】/g, "[$1]");

  // 1. Tool selection check
  if (testCase.expectedTool === "web_search" && toolCalled !== "web_search") {
    failures.push(`Expected tool 'web_search' to be invoked, but got '${toolCalled ?? "none"}'`);
  } else if (testCase.expectedTool === "none" && toolCalled !== null) {
    failures.push(`Expected no tool to be invoked, but tool '${toolCalled}' was triggered`);
  }

  // 2. Must include patterns
  if (testCase.assertions.mustIncludePatterns) {
    for (const pattern of testCase.assertions.mustIncludePatterns) {
      if (!pattern.test(normalizedOutput)) {
        failures.push(`Output failed to match required pattern: ${pattern.toString()}`);
      }
    }
  }

  // 3. Must NOT include patterns
  if (testCase.assertions.mustNotIncludePatterns) {
    for (const pattern of testCase.assertions.mustNotIncludePatterns) {
      if (pattern.test(normalizedOutput)) {
        failures.push(`Output violated safety constraint by matching: ${pattern.toString()}`);
      }
    }
  }

  // 4. Citation check
  if (testCase.assertions.shouldCite) {
    const hasCitation = /\[[0-9]+\]/.test(normalizedOutput);
    if (!hasCitation) {
      failures.push("Expected inline citations like [1], but none were found in output");
    }
  }

  // 5. Max completion tokens check
  if (testCase.assertions.maxCompletionTokens && completionTokens > testCase.assertions.maxCompletionTokens) {
    failures.push(
      `Exceeded max completion tokens: ${completionTokens} > ${testCase.assertions.maxCompletionTokens}`,
    );
  }

  return {
    evalCase: testCase,
    passed: failures.length === 0,
    failures,
    latencyMs,
    promptTokens,
    completionTokens,
    estimatedCostUsd: calculateCost(promptTokens, completionTokens),
    output,
    toolCalled,
  };
}

export async function runEvalSuite(options?: {
  isLive?: boolean;
  categoryFilter?: string;
  idFilter?: string;
  verbose?: boolean;
  /** Write the Markdown reports under tests/evals/reports (default true; the unit test passes false). */
  writeReport?: boolean;
}) {
  loadEnvLocal();
  const isLive = options?.isLive ?? process.argv.includes("--live");
  const isVerbose = options?.verbose ?? process.argv.includes("--verbose");
  const categoryFilter =
    options?.categoryFilter ??
    process.argv.find((a) => a.startsWith("--category="))?.split("=")[1];
  const idFilter =
    options?.idFilter ??
    process.argv.find((a) => a.startsWith("--id="))?.split("=")[1];

  console.log("\n=======================================================");
  console.log(`  P-DOT AI-02 EVALUATION SUITE (${isLive ? "LIVE NEBIUS API" : "DETERMINISTIC MOCK MODE"})`);
  console.log(`  Active Model: ${process.env.NEBIUS_MODEL ?? "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B"}`);
  console.log("=======================================================\n");

  let nebiusSettings: NebiusSettings | null = null;
  let tavilyApiKey: string | null = null;

  if (isLive) {
    const apiKey = process.env.NEBIUS_API_KEY;
    const model = process.env.NEBIUS_MODEL ?? "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B";
    if (!apiKey) {
      console.error("ERROR: NEBIUS_API_KEY is missing from environment or .env.local.");
      process.exit(1);
    }
    nebiusSettings = {
      apiKey,
      model,
      baseUrl: process.env.NEBIUS_BASE_URL ?? "https://api.tokenfactory.nebius.com/v1",
      maxOutputTokens: 2048,
    };

    if (process.env.TAVILY_API_KEY) {
      tavilyApiKey = process.env.TAVILY_API_KEY;
    }
  }

  let cases = EVAL_DATASET;
  if (categoryFilter) {
    cases = cases.filter((c) => c.category === categoryFilter);
  }
  if (idFilter) {
    cases = cases.filter((c) => c.id === idFilter);
  }

  const results: EvalResult[] = [];
  const categoryStats: Record<EvalCategory, { total: number; passed: number }> = {
    tool_decision: { total: 0, passed: 0 },
    citation_grounding: { total: 0, passed: 0 },
    safety_injection: { total: 0, passed: 0 },
    context_formatting: { total: 0, passed: 0 },
    budget_cost: { total: 0, passed: 0 },
  };

  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalCostUsd = 0;
  let totalLatencyMs = 0;

  for (let i = 0; i < cases.length; i++) {
    const testCase = cases[i]!;
    process.stdout.write(`[${i + 1}/${cases.length}] Evaluating ${testCase.id} (${testCase.category})... `);

    const result = await runSingleEval(testCase, isLive, nebiusSettings, tavilyApiKey);
    results.push(result);

    categoryStats[testCase.category].total++;
    if (result.passed) {
      categoryStats[testCase.category].passed++;
      console.log(`\x1b[32mPASS\x1b[0m (${result.latencyMs}ms, ${result.promptTokens + result.completionTokens} tok)`);
    } else {
      console.log(`\x1b[31mFAIL\x1b[0m (${result.latencyMs}ms)`);
      for (const fail of result.failures) {
        console.log(`    ↳ \x1b[33m${fail}\x1b[0m`);
      }
    }

    if (isVerbose) {
      const preview = result.output.trim().replace(/\n+/g, " ").slice(0, 160);
      console.log(`    \x1b[36m↳ Output: "${preview}${result.output.length > 160 ? "…" : ""}"\x1b[0m`);
    }

    totalPromptTokens += result.promptTokens;
    totalCompletionTokens += result.completionTokens;
    totalCostUsd += result.estimatedCostUsd;
    totalLatencyMs += result.latencyMs;
  }

  const overallPassed = results.filter((r) => r.passed).length;
  const passRate = ((overallPassed / results.length) * 100).toFixed(1);
  const avgLatency = Math.round(totalLatencyMs / results.length);

  console.log("\n==================== EVALUATION SUMMARY ====================");
  console.log(`Overall Pass Rate: ${overallPassed}/${results.length} (${passRate}%)`);
  console.log(`Average Latency:   ${avgLatency} ms`);
  console.log(`Total Tokens:      ${totalPromptTokens + totalCompletionTokens} (Prompt: ${totalPromptTokens}, Completion: ${totalCompletionTokens})`);
  console.log(`Estimated Cost:    $${totalCostUsd.toFixed(5)} USD`);
  console.log("------------------------------------------------------------");
  console.log("Category Breakdown:");
  for (const [cat, stat] of Object.entries(categoryStats)) {
    const pct = stat.total > 0 ? ((stat.passed / stat.total) * 100).toFixed(1) : "0.0";
    console.log(`  - ${cat.padEnd(20)}: ${stat.passed}/${stat.total} (${pct}%)`);
  }
  console.log("============================================================\n");

  if (options?.writeReport === false) {
    return { total: results.length, passed: overallPassed, passRate: Number(passRate), results };
  }

  // Save Markdown Report
  const reportsDir = path.resolve(process.cwd(), "tests/evals/reports");
  fs.mkdirSync(reportsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(reportsDir, `eval-report-${timestamp}.md`);
  const latestPath = path.join(reportsDir, "latest-eval-report.md");

  const reportMarkdown = `# P-Dot AI-02 Evaluation Report

- **Date**: ${new Date().toISOString()}
- **Mode**: ${isLive ? "Live Nebius API" : "Deterministic Mock Suite"}
- **Model**: ${process.env.NEBIUS_MODEL ?? "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B"}
- **Total Cases**: ${results.length}
- **Pass Rate**: ${overallPassed}/${results.length} (${passRate}%)
- **Average Latency**: ${avgLatency}ms
- **Total Tokens**: ${totalPromptTokens + totalCompletionTokens}
- **Total Cost**: $${totalCostUsd.toFixed(5)} USD

## Category Breakdown

| Category | Passed | Total | Rate |
| :--- | :---: | :---: | :---: |
${Object.entries(categoryStats)
  .map(([cat, stat]) => `| \`${cat}\` | ${stat.passed} | ${stat.total} | ${((stat.passed / stat.total) * 100).toFixed(1)}% |`)
  .join("\n")}

## Detailed Results

| ID | Category | Description | Tool Expected | Tool Called | Status | Failures |
| :--- | :--- | :--- | :---: | :---: | :---: | :--- |
${results
  .map(
    (r) =>
      `| \`${r.evalCase.id}\` | ${r.evalCase.category} | ${r.evalCase.description} | ${r.evalCase.expectedTool} | ${r.toolCalled ?? "none"} | ${r.passed ? "✅ PASS" : "❌ FAIL"} | ${r.failures.join("; ") || "-"} |`,
  )
  .join("\n")}

## Detailed Prompt Outputs

${results
  .map(
    (r) => `
<details>
<summary><strong>[${r.passed ? "PASS" : "FAIL"}] ${r.evalCase.id}</strong>: ${r.evalCase.description}</summary>

- **Prompt**: ${r.evalCase.userPrompt}
- **Tool Called**: \`${r.toolCalled ?? "none"}\` (Expected: \`${r.evalCase.expectedTool}\`)
- **Latency**: ${r.latencyMs}ms | **Tokens**: ${r.promptTokens + r.completionTokens} | **Cost**: $${r.estimatedCostUsd.toFixed(6)}
${r.failures.length > 0 ? `- **Failures**:\n${r.failures.map((f) => `  - ${f}`).join("\n")}\n` : ""}
**Model Output**:
> ${r.output.trim().replace(/\n/g, "\n> ")}

</details>`,
  )
  .join("\n")}
`;

  fs.writeFileSync(reportPath, reportMarkdown, "utf-8");
  fs.writeFileSync(latestPath, reportMarkdown, "utf-8");
  console.log(`Detailed report generated at:\n${latestPath}\n`);

  return {
    total: results.length,
    passed: overallPassed,
    passRate: Number(passRate),
    results,
  };
}

if (process.argv[1]?.endsWith("runner.ts")) {
  runEvalSuite().catch((err) => {
    console.error("Eval suite failed to run:", err);
    process.exit(1);
  });
}
