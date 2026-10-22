import "server-only";
import { z } from "zod";
import type { ToolCall, ToolChoice, ToolDefinition } from "@/server/assistant/tools";
import {
  createAbortScope,
  discardBody,
  kindFromErrorLabel,
  kindFromStatus,
  ProviderError,
  type AbortScope,
  type ProviderName,
} from "../errors";
import { readSseData, SseFormatError } from "./sse";
import { createThinkFilter } from "./think";

// Nebius Token Factory exposes an OpenAI-compatible chat completions API.
// https://api.tokenfactory.nebius.com/docs
// The same client talks to any other OpenAI-compatible server, for example a
// local Ollama (`/v1`), so the production code path is what local tests run.

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  /** Empty for an assistant turn that only calls tools. */
  content: string;
  /** Assistant turns only: the tool calls the model made. */
  tool_calls?: ToolCall[];
  /** Tool turns only: which call this message answers. */
  tool_call_id?: string;
  /** Tool turns only: the tool's name. */
  name?: string;
}

export interface NebiusSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxOutputTokens: number;
  /**
   * Reasoning ("thinking") budget in tokens. When above 0, reasoning is on and
   * Nebius stops it after this many tokens (`thinking_token_budget`, checked on
   * Nano, Super and Ultra on 2026-10-19), so the reply always gets the rest of
   * `maxOutputTokens`. When 0 or unset, reasoning is off.
   */
  thinkingBudgetTokens?: number;
  /** Which provider this server is, for error reports and logs. Default "nebius". */
  provider?: ProviderName;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export type CompletionChunk =
  | { type: "text"; text: string }
  /**
   * Progress without text: the model is reasoning, or a tool call started
   * arriving. Reasoning is never shown or saved. The executor counts it as the
   * first token, so a slow tool-only reply is not timed out or hedged.
   */
  | { type: "reasoning" }
  /** The model asked for tools. Sent once, after every call's arguments arrived. */
  | { type: "tool_calls"; calls: ToolCall[] }
  | { type: "finish"; finishReason: string | null; usage: TokenUsage | null };

export interface StreamOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Whole-request deadline (wall clock). */
  totalTimeoutMs?: number;
  /** Maximum gap between streamed chunks (including time to first byte). */
  idleTimeoutMs?: number;
  /** Function tools the model may call. None: the model can only answer. */
  tools?: ToolDefinition[];
  /** How the model may pick a tool. Sent only with `tools`. */
  toolChoice?: ToolChoice;
}

const chunkSchema = z.object({
  choices: z
    .array(
      z.object({
        // Reasoning arrives in `reasoning` and `reasoning_content`. Those and
        // other delta fields are ignored, so reasoning is never shown or saved.
        delta: z
          .object({
            content: z.string().nullish(),
            reasoning: z.string().nullish(),
            reasoning_content: z.string().nullish(),
            tool_calls: z
              .array(
                z.object({
                  index: z.number().int().nullish(),
                  id: z.string().nullish(),
                  type: z.string().nullish(),
                  function: z
                    .object({ name: z.string().nullish(), arguments: z.string().nullish() })
                    .nullish(),
                }),
              )
              .nullish(),
          })
          .nullish(),
        finish_reason: z.string().nullish(),
      }),
    )
    .nullish(),
  // Checked separately (usageSchema): bad usage must not fail the reply.
  usage: z.unknown().optional(),
  error: z
    .object({
      code: z.union([z.string(), z.number()]).nullish(),
      type: z.string().nullish(),
    })
    .nullish(),
});

// Token counts must be non-negative safe integers. Anything else is treated
// as missing usage, so the spend guard keeps the full hold.
const tokenCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const usageSchema = z.object({ prompt_tokens: tokenCount, completion_tokens: tokenCount });

/** Most tool calls read from one reply; more is a malformed or runaway stream. */
const MAX_TOOL_CALLS = 8;
/** Longest tool arguments string kept (the schemas bound the real values far below this). */
const MAX_TOOL_ARGUMENT_CHARS = 8_192;

/**
 * An error event inside the stream. A numeric code (or a numeric string) is an
 * HTTP status and is kept, so the executor can tell 404 from 503. A known label
 * decides the kind first (for example `insufficient_quota`). Only the code and
 * type are read; the message is never read or logged.
 */
function streamError(
  provider: ProviderName,
  error: { code?: string | number | null; type?: string | null },
): ProviderError {
  const code = typeof error.code === "string" && /^\d{3}$/.test(error.code.trim()) ? Number(error.code) : error.code;
  const status = typeof code === "number" && Number.isInteger(code) && code >= 100 && code <= 599 ? code : undefined;
  const label = `${typeof code === "string" ? code : ""} ${error.type ?? ""}`;
  const kind = kindFromErrorLabel(label) ?? (status !== undefined ? kindFromStatus(status) : "unavailable");
  return new ProviderError(provider, kind, status);
}

const MAX_ERROR_BODY_CHARS = 8_192;

/**
 * `error.code` and `error.type` from a JSON error body, read up to 8 KB. Used
 * only to choose the error kind; the body is never logged or returned.
 */
async function errorBodyLabel(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  try {
    const decoder = new TextDecoder();
    let text = "";
    while (text.length <= MAX_ERROR_BODY_CHARS) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    if (text.length > MAX_ERROR_BODY_CHARS) return "";
    const body: unknown = JSON.parse(text);
    const root = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const error = root.error && typeof root.error === "object" ? (root.error as Record<string, unknown>) : root;
    return [error.code, error.type].filter((value) => typeof value === "string").join(" ");
  } catch {
    return "";
  } finally {
    reader.cancel().catch(() => {});
  }
}

function thinkingFields(budget: number): Record<string, unknown> {
  if (budget <= 0) return { chat_template_kwargs: { enable_thinking: false } };
  return { chat_template_kwargs: { enable_thinking: true }, thinking_token_budget: budget };
}

/** `Retry-After` in milliseconds (seconds or an HTTP date), or undefined. */
export function parseRetryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function networkError(provider: ProviderName, scope: AbortScope, parent?: AbortSignal): ProviderError {
  if (parent?.aborted) return new ProviderError(provider, "aborted");
  if (scope.timedOut()) return new ProviderError(provider, "timeout");
  return new ProviderError(provider, "unavailable");
}

interface PartialToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Streams a chat completion. Yields text chunks (and text-less `reasoning`
 * progress chunks, one when each tool call starts), then any tool calls, then a
 * single `finish` chunk. Throws ProviderError on HTTP errors, in-stream
 * errors, timeouts, malformed data, or a stream that ends without completing.
 */
export async function* streamChatCompletion(
  settings: NebiusSettings,
  messages: ChatMessage[],
  options: StreamOptions = {},
): AsyncGenerator<CompletionChunk> {
  const provider = settings.provider ?? "nebius";
  const fetchImpl = options.fetchImpl ?? fetch;
  const scope = createAbortScope({
    totalMs: options.totalTimeoutMs ?? 55_000,
    idleMs: options.idleTimeoutMs ?? 25_000,
    parent: options.signal,
  });

  try {
    let response: Response;
    const body: Record<string, unknown> = {
      model: settings.model,
      messages,
      max_tokens: settings.maxOutputTokens,
      stream: true,
      // Token usage arrives in a last chunk with no choices. The spend guard needs it.
      stream_options: { include_usage: true },
      // Turns reasoning off (or on) for Nemotron and other models whose chat template
      // reads this flag. Reasoning tokens cost money and count against max_tokens, so
      // without a budget they could leave no room for the reply.
      ...thinkingFields(settings.thinkingBudgetTokens ?? 0),
    };
    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
      if (options.toolChoice) body.tool_choice = options.toolChoice;
    }
    try {
      response = await fetchImpl(`${settings.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${settings.apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        signal: scope.signal,
      });
    } catch {
      throw networkError(provider, scope, options.signal);
    }

    if (!response.ok) {
      const label = await errorBodyLabel(response);
      await discardBody(response);
      const kind = kindFromErrorLabel(label) ?? kindFromStatus(response.status);
      throw new ProviderError(provider, kind, response.status, {
        retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
      });
    }
    if (!response.body) throw new ProviderError(provider, "bad_response");
    scope.touch();

    let completed = false;
    let finishReason: string | null = null;
    let usage: TokenUsage | null = null;
    const think = createThinkFilter();
    // Tool calls arrive in pieces, keyed by their index. They are yielded once complete.
    const toolCalls = new Map<number, PartialToolCall>();

    try {
      for await (const data of readSseData(response.body, scope.signal)) {
        scope.touch();
        if (data.trim() === "[DONE]") {
          completed = true;
          break;
        }

        let chunk: z.infer<typeof chunkSchema>;
        try {
          chunk = chunkSchema.parse(JSON.parse(data));
        } catch {
          throw new ProviderError(provider, "bad_response");
        }
        if (chunk.error) throw streamError(provider, chunk.error);
        if (chunk.usage !== undefined && chunk.usage !== null) {
          const parsed = usageSchema.safeParse(chunk.usage);
          usage = parsed.success
            ? { promptTokens: parsed.data.prompt_tokens, completionTokens: parsed.data.completion_tokens }
            : null;
        }
        for (const choice of chunk.choices ?? []) {
          const text = choice.delta?.content ? think.push(choice.delta.content) : "";
          if (text) yield { type: "text", text };
          else if (choice.delta?.content || choice.delta?.reasoning || choice.delta?.reasoning_content) {
            yield { type: "reasoning" };
          }
          for (const piece of choice.delta?.tool_calls ?? []) {
            const index = piece.index ?? toolCalls.size;
            const call = toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
            const started = !toolCalls.has(index);
            if (started) {
              if (toolCalls.size >= MAX_TOOL_CALLS) throw new ProviderError(provider, "bad_response");
              toolCalls.set(index, call);
            }
            if (piece.id) call.id = piece.id;
            if (piece.function?.name) call.name += piece.function.name;
            if (piece.function?.arguments) {
              call.arguments += piece.function.arguments;
              if (call.arguments.length > MAX_TOOL_ARGUMENT_CHARS) throw new ProviderError(provider, "bad_response");
            }
            // A tool call started: the model is answering, even though no text comes.
            if (started) yield { type: "reasoning" };
          }
          if (choice.finish_reason) finishReason = choice.finish_reason;
        }
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (error instanceof SseFormatError) throw new ProviderError(provider, "bad_response");
      throw networkError(provider, scope, options.signal);
    }

    // A stream that stops without [DONE] or a finish reason was cut off.
    if (!completed && finishReason === null) {
      throw networkError(provider, scope, options.signal);
    }
    const rest = think.flush();
    if (rest) yield { type: "text", text: rest };
    if (toolCalls.size > 0) {
      const calls: ToolCall[] = [...toolCalls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, call]) => ({
          id: call.id || `call_${index}`,
          type: "function" as const,
          function: { name: call.name, arguments: call.arguments },
        }))
        .filter((call) => call.function.name.length > 0);
      if (calls.length > 0) yield { type: "tool_calls", calls };
    }
    yield { type: "finish", finishReason, usage };
  } finally {
    scope.dispose();
  }
}
