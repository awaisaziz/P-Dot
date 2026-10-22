import "server-only";
import { z } from "zod";
import { MAX_MEMORY_CHARS, RETRIEVAL_MATCH_COUNT } from "@/lib/limits";
import { WORKSPACE_MODE } from "@/lib/mode";
import type { MemoryRepository } from "@/server/db/memories";
import type { RetrievalRepository } from "@/server/db/retrieval";
import { completeText, type CompletionDeps } from "@/server/assistant/complete";
import type { HistoryMessage } from "@/server/assistant/context";
import type { Embedder } from "@/server/assistant/embed";
import type { RoutingConfig } from "@/server/assistant/tiers";
import type { ChatMessage } from "@/server/providers/model";

// Session summarization (AI-06b): after a conversation, distill lasting facts
// about the user into memory suggestions. Each one is saved as a `proposed`
// memory from the assistant (decision 0009), so the user keeps or discards it
// from the "Remember this?" card; nothing becomes active on its own.

export interface SummarizerDeps extends CompletionDeps {
  routing: RoutingConfig;
  memories: MemoryRepository;
  retrieval: RetrievalRepository;
  embedder: Embedder;
}

export interface SummarizeSessionInput {
  userId: string;
  requestId: string;
  /** The conversation, oldest first. */
  transcript: HistoryMessage[];
  /** The reply the suggestions are shown under. Null when the conversation has none. */
  sourceMessageId: string | null;
  signal: AbortSignal;
  /** Similarity to an active memory at or above which a fact is not suggested again (default 0.85). */
  dedupThreshold?: number;
}

export interface SummarizeSessionResult {
  extractedCount: number;
  createdCount: number;
  skippedCount: number;
}

/** Most facts one summary may suggest. */
export const MAX_EXTRACTED_MEMORIES = 8;

/** Characters of the transcript sent to the model (the end is kept, where the latest facts are). */
const TRANSCRIPT_CHARS = 12_000;

export const MEMORY_EXTRACTION_SYSTEM_PROMPT = `You extract lasting facts about the user from a conversation transcript between the user and an assistant.

Extract only durable, personal facts the user stated about themselves: preferences (tools, food, style), their work (role, projects, stack), personal details (city, time zone, family, pets, diet, hobbies), and constraints or deadlines they gave.

Do not extract: one-off questions or trivia, the assistant's suggestions or code, how the conversation went, anything the user asked to keep private, or any credential, password, key or token.

Write each fact as one short sentence about the user in the third person, for example "Prefers TypeScript strict mode" or "Lives in Toronto". Output only JSON of this shape, with an empty list when there is nothing lasting:
{"memories": [{"content": "..."}]}`;

const extractionSchema = z.object({
  memories: z.array(z.object({ content: z.string().trim().min(3).max(MAX_MEMORY_CHARS) })).max(50),
});

/** Replaces key-, token- and password-like text before anything is stored. */
export function scrubSensitiveData(text: string): string {
  return text
    .replace(/\b(?:sk|ghp|gho|np|sec|sb_secret|sb_publishable)[_-][A-Za-z0-9_-]{16,}\b/gi, "[REDACTED_KEY]")
    .replace(/bearer\s+[A-Za-z0-9_\-.]{20,}/gi, "Bearer [REDACTED_TOKEN]")
    .replace(/(password|passcode|secret|api[_ ]?key|token)\s*[:=]\s*["']?[^\s"']+["']?/gi, "$1: [REDACTED]");
}

/** Lowercase letters and digits only, for near-duplicate text checks. */
function normalized(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * The facts in a model reply: the JSON object, with or without a Markdown
 * fence, parsed and scrubbed. Anything that is not that shape yields nothing.
 */
export function parseExtractedMemories(raw: string): string[] {
  let text = raw.trim();
  if (text.startsWith("```")) text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return [];
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  const parsed = extractionSchema.safeParse(json);
  if (!parsed.success) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of parsed.data.memories) {
    const content = scrubSensitiveData(item.content).trim();
    if (content.length < 3 || content.includes("[REDACTED")) continue;
    const key = normalized(content);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(content);
    if (out.length >= MAX_EXTRACTED_MEMORIES) break;
  }
  return out;
}

/** Asks the fast tier for lasting facts in the transcript. Empty for a trivial exchange or a failed call. */
export async function extractSessionMemories(
  deps: SummarizerDeps,
  input: Pick<SummarizeSessionInput, "requestId" | "transcript" | "signal">,
): Promise<string[]> {
  const userMessages = input.transcript.filter((message) => message.role === "user");
  if (userMessages.length === 0) return [];
  if (userMessages.length === 1 && userMessages[0]!.content.trim().length < 15) return [];

  const text = input.transcript
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`)
    .join("\n\n");
  const messages: ChatMessage[] = [
    { role: "system", content: MEMORY_EXTRACTION_SYSTEM_PROMPT },
    { role: "user", content: `<transcript>\n${text.slice(-TRANSCRIPT_CHARS)}\n</transcript>` },
  ];
  try {
    const completion = await completeText(deps, {
      requestId: input.requestId,
      plan: deps.routing.fast,
      messages,
      signal: input.signal,
      maxChars: 6_000,
    });
    return parseExtractedMemories(completion.text);
  } catch (error) {
    if (input.signal.aborted) throw error;
    deps.log("warn", "session_summary_failed", {
      requestId: input.requestId,
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return [];
  }
}

/**
 * Saves each fact as a `proposed` memory unless the user already has it: an
 * active memory at least `dedupThreshold` similar, or a suggestion with the
 * same text that still waits. A fact whose vector cannot be made is saved
 * without one (it is not searchable until it is edited). Both checks look at
 * every memory whatever its stored mode (decision 0014).
 */
export async function proposeSessionMemories(
  deps: Pick<SummarizerDeps, "memories" | "retrieval" | "embedder" | "log">,
  input: Omit<SummarizeSessionInput, "transcript"> & { facts: string[] },
): Promise<{ createdCount: number; skippedCount: number }> {
  const threshold = input.dedupThreshold ?? 0.85;
  let createdCount = 0;
  let skippedCount = 0;
  const waiting = new Set(
    (await deps.memories.listMemories(input.userId, "proposed", 200)).map((memory) => normalized(memory.content)),
  );
  for (const fact of input.facts) {
    if (waiting.has(normalized(fact))) {
      skippedCount += 1;
      continue;
    }
    let vector: number[] | null = null;
    try {
      vector = (await deps.embedder.embed([fact], input.signal))[0] ?? null;
    } catch (error) {
      if (input.signal.aborted) throw error;
      deps.log("warn", "memory_embedding_failed", {
        requestId: input.requestId,
        errorName: error instanceof Error ? error.name : "unknown",
      });
    }
    if (vector) {
      const matches = await deps.retrieval.matchMemories(vector, null, Math.min(3, RETRIEVAL_MATCH_COUNT));
      if (matches.some((match) => match.similarity >= threshold)) {
        skippedCount += 1;
        continue;
      }
    }
    await deps.memories.createMemory(
      input.userId,
      { mode: WORKSPACE_MODE, content: fact, status: "proposed", source: "assistant", sourceMessageId: input.sourceMessageId },
      vector,
    );
    waiting.add(normalized(fact));
    createdCount += 1;
  }
  return { createdCount, skippedCount };
}

/** Extracts the facts and saves the new ones as suggestions. */
export async function summarizeSession(deps: SummarizerDeps, input: SummarizeSessionInput): Promise<SummarizeSessionResult> {
  const facts = await extractSessionMemories(deps, input);
  if (facts.length === 0) return { extractedCount: 0, createdCount: 0, skippedCount: 0 };
  const { createdCount, skippedCount } = await proposeSessionMemories(deps, { ...input, facts });
  deps.log("info", "session_summarized", {
    requestId: input.requestId,
    extractedCount: facts.length,
    createdCount,
    skippedCount,
  });
  return { extractedCount: facts.length, createdCount, skippedCount };
}
