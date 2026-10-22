import { describe, expect, it } from "vitest";
import { createCircuitBreaker } from "@/server/assistant/breaker";
import type { ChatMessage, CompletionChunk, ModelProvider } from "@/server/providers/model";
import {
  MEMORY_EXTRACTION_SYSTEM_PROMPT,
  parseExtractedMemories,
  scrubSensitiveData,
  summarizeSession,
  type SummarizerDeps,
} from "@/server/memory/summarizer";
import { FakeMemories, FakeRetrieval, FakeSpend, testEmbedder, testRouting } from "../support/fakes";

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function summarizer(reply: string | (() => AsyncIterable<CompletionChunk>)) {
  const spend = new FakeSpend();
  const memories = new FakeMemories();
  const retrieval = new FakeRetrieval();
  const prompts: ChatMessage[][] = [];
  const logs: string[] = [];
  const provider: ModelProvider = {
    name: "nebius",
    stream: (request) => {
      prompts.push(request.messages);
      if (typeof reply === "function") return reply();
      return (async function* () {
        yield { type: "text" as const, text: reply };
        yield { type: "finish" as const, finishReason: "stop", usage: { promptTokens: 100, completionTokens: 20 } };
      })();
    },
  };
  const deps: SummarizerDeps = {
    spend,
    provider,
    breaker: createCircuitBreaker({ threshold: 3, cooldownMs: 30_000 }),
    random: () => 0,
    log: (_level, event) => {
      logs.push(event);
    },
    waitUntil: () => {},
    routing: testRouting(),
    memories,
    retrieval,
    embedder: testEmbedder(spend),
  };
  return { deps, spend, memories, retrieval, prompts, logs };
}

const transcript = [
  { role: "user" as const, content: "I just moved to Toronto and I prefer TypeScript strict mode for everything." },
  { role: "assistant" as const, content: "Welcome to Toronto! Strict mode is a good default." },
  { role: "user" as const, content: "Also I am allergic to peanuts, keep that in mind for recipes." },
  { role: "assistant" as const, content: "Noted for recipes." },
];

describe("parseExtractedMemories", () => {
  it("reads the JSON object, with or without a code fence, and drops duplicates and empty items", () => {
    const json = '{"memories":[{"content":"Lives in Toronto"},{"content":"lives in toronto"},{"content":"Allergic to peanuts"}]}';
    expect(parseExtractedMemories(json)).toEqual(["Lives in Toronto", "Allergic to peanuts"]);
    expect(parseExtractedMemories("```json\n" + json + "\n```")).toEqual(["Lives in Toronto", "Allergic to peanuts"]);
    expect(parseExtractedMemories("Sure! " + json + " Hope this helps.")).toEqual(["Lives in Toronto", "Allergic to peanuts"]);
  });

  it("yields nothing for text that is not the expected shape", () => {
    expect(parseExtractedMemories("")).toEqual([]);
    expect(parseExtractedMemories("The user lives in Toronto.")).toEqual([]);
    expect(parseExtractedMemories('{"memories": "none"}')).toEqual([]);
    expect(parseExtractedMemories('{"memories": []}')).toEqual([]);
  });

  it("never keeps a fact that holds a key, token or password", () => {
    expect(scrubSensitiveData("Uses key sk-demo-abcdefghijklmnopqrstuvwxyz12")).toContain("[REDACTED_KEY]");
    expect(scrubSensitiveData("password: hunter2hunter2")).toBe("password: [REDACTED]");
    expect(
      parseExtractedMemories('{"memories":[{"content":"API key sk-abcdefghijklmnopqrstuvwxyz1234"},{"content":"Lives in Toronto"}]}'),
    ).toEqual(["Lives in Toronto"]);
  });
});

describe("summarizeSession", () => {
  it("asks the fast tier for facts and saves each new one as a proposed memory with a vector", async () => {
    const { deps, memories, prompts, spend } = summarizer(
      '{"memories":[{"content":"Lives in Toronto"},{"content":"Prefers TypeScript strict mode"},{"content":"Allergic to peanuts"}]}',
    );
    const result = await summarizeSession(deps, {
      userId: ALICE,
      requestId: "req-sum",
      transcript,
      sourceMessageId: "11111111-1111-4111-8111-111111111111",
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ extractedCount: 3, createdCount: 3, skippedCount: 0 });
    expect(prompts[0]![0]).toEqual({ role: "system", content: MEMORY_EXTRACTION_SYSTEM_PROMPT });
    expect(prompts[0]![1]!.content).toContain("<transcript>");
    expect(prompts[0]![1]!.content).toContain("allergic to peanuts");
    expect(memories.memories.map((m) => m.content)).toEqual(["Lives in Toronto", "Prefers TypeScript strict mode", "Allergic to peanuts"]);
    // Saved with WORKSPACE_MODE (decision 0014).
    expect(memories.memories[0]).toMatchObject({
      userId: ALICE,
      mode: "personal",
      status: "proposed",
      source: "assistant",
      sourceMessageId: "11111111-1111-4111-8111-111111111111",
    });
    expect(memories.memories.every((m) => m.embedding?.length === 1024)).toBe(true);
    // One model hold and one embedding hold for each fact, all settled.
    expect(spend.reservations.every((r) => r.settled !== null)).toBe(true);
    expect(spend.reservations).toHaveLength(4);
  });

  it("skips a fact the user already has (a close active memory or a waiting suggestion)", async () => {
    const { deps, memories, retrieval } = summarizer('{"memories":[{"content":"Lives in Toronto"},{"content":"Allergic to peanuts"}]}');
    retrieval.memoryMatches = [{ id: "mem-1", content: "Lives in Toronto, Canada", similarity: 0.91 }];
    await memories.createMemory(ALICE, { mode: "personal", content: "Allergic to peanuts!", status: "proposed", source: "assistant", sourceMessageId: null }, null);

    const result = await summarizeSession(deps, {
      userId: ALICE,
      requestId: "req-sum",
      transcript,
      sourceMessageId: null,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ extractedCount: 2, createdCount: 0, skippedCount: 2 });
    expect(memories.memories).toHaveLength(1);
  });

  it("extracts nothing from a greeting and saves nothing when the model fails", async () => {
    const greeting = summarizer('{"memories":[{"content":"Said hello"}]}');
    const nothing = await summarizeSession(greeting.deps, {
      userId: ALICE,
      requestId: "r",
      transcript: [{ role: "user", content: "hi" }, { role: "assistant", content: "Hello!" }],
      sourceMessageId: null,
      signal: new AbortController().signal,
    });
    expect(nothing).toEqual({ extractedCount: 0, createdCount: 0, skippedCount: 0 });
    expect(greeting.prompts).toHaveLength(0);

    const failing = summarizer(() =>
      (async function* () {
        yield { type: "text" as const, text: "partial" };
        throw new Error("boom");
      })(),
    );
    const failed = await summarizeSession(failing.deps, {
      userId: ALICE,
      requestId: "r",
      transcript,
      sourceMessageId: null,
      signal: new AbortController().signal,
    });
    expect(failed).toEqual({ extractedCount: 0, createdCount: 0, skippedCount: 0 });
    expect(failing.memories.memories).toHaveLength(0);
    expect(failing.logs).toContain("session_summary_failed");
  });
});
