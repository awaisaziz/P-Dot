import "server-only";
import type { ToolChoice, ToolDefinition } from "@/server/assistant/tools";
import type { ProviderName } from "./errors";
import { streamChatCompletion, type ChatMessage, type CompletionChunk } from "./nebius/client";
import { isLocalModel, LOCAL_MODEL_PREFIX } from "./nebius/pricing";

export type { ChatMessage, CompletionChunk, TokenUsage } from "./nebius/client";

/** One call to one model. The executor builds one for each attempt. */
export interface ModelCallRequest {
  model: string;
  messages: ChatMessage[];
  maxOutputTokens: number;
  /** Reasoning token budget; 0 turns reasoning off. */
  thinkingBudgetTokens: number;
  /** Wall-clock limit for this call (the request deadline that is left). */
  timeoutMs: number;
  /** Function tools the model may call in this attempt. */
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
}

/**
 * A streaming chat model provider. The executor (src/server/assistant/executor.ts)
 * uses only this interface, so retries, fallbacks and hedging do not depend on
 * one provider. Errors must be ProviderError; an aborted `signal` must end the
 * stream.
 */
export interface ModelProvider {
  readonly name: ProviderName;
  stream(request: ModelCallRequest, signal: AbortSignal): AsyncIterable<CompletionChunk>;
}

export function createNebiusProvider(
  settings: { apiKey: string; baseUrl: string },
  options: { fetchImpl?: typeof fetch } = {},
): ModelProvider {
  return {
    name: "nebius",
    stream: (request, signal) =>
      streamChatCompletion(
        {
          apiKey: settings.apiKey,
          baseUrl: settings.baseUrl,
          model: request.model,
          maxOutputTokens: request.maxOutputTokens,
          thinkingBudgetTokens: request.thinkingBudgetTokens,
        },
        request.messages,
        {
          signal,
          totalTimeoutMs: request.timeoutMs,
          fetchImpl: options.fetchImpl,
          tools: request.tools,
          toolChoice: request.toolChoice,
        },
      ),
  };
}

/**
 * A local Ollama server through its OpenAI-compatible API (`/v1`). It is a
 * stand-in for Nebius in local runs: the same client, routing, spend guard
 * and tool loop run, so what works here works in production. Model IDs carry
 * the `ollama/` prefix in configuration (for example `ollama/qwen3-vl:2b-instruct`);
 * the prefix is removed before the call. Ollama needs no key, but the client
 * always sends one, so a placeholder is used.
 */
export function createOllamaProvider(
  settings: { baseUrl: string },
  options: { fetchImpl?: typeof fetch } = {},
): ModelProvider {
  return {
    name: "ollama",
    stream: (request, signal) =>
      streamChatCompletion(
        {
          apiKey: "ollama",
          baseUrl: settings.baseUrl,
          model: request.model.startsWith(LOCAL_MODEL_PREFIX) ? request.model.slice(LOCAL_MODEL_PREFIX.length) : request.model,
          maxOutputTokens: request.maxOutputTokens,
          // Ollama's OpenAI endpoint has no thinking budget; the flag is ignored there.
          thinkingBudgetTokens: 0,
          provider: "ollama",
        },
        request.messages,
        {
          signal,
          totalTimeoutMs: request.timeoutMs,
          fetchImpl: options.fetchImpl,
          tools: request.tools,
          toolChoice: request.toolChoice,
        },
      ),
  };
}

/**
 * Sends each attempt to Nebius, or to the local Ollama for a model with the
 * `ollama/` prefix. A model chain can mix both, so one tier can run locally
 * while another stays on Nebius.
 */
export function createRoutedProvider(providers: { nebius: ModelProvider; ollama: ModelProvider }): ModelProvider {
  return {
    name: "nebius",
    stream: (request, signal) =>
      (isLocalModel(request.model) ? providers.ollama : providers.nebius).stream(request, signal),
  };
}
