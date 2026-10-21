import "server-only";
import type { ChatMessage, TokenUsage } from "./client";

// Nebius Token Factory prices, from GET /v1/models?verbose=true (checked 2026-10-19).
// A price of X USD per million tokens is X micro-dollars per token. The table
// stores nano-dollars per token (1,000 nano = 1 micro) so the math stays in integers.

export interface ModelPrice {
  inputNanoUsdPerToken: number;
  outputNanoUsdPerToken: number;
}

const PRICES: Readonly<Record<string, ModelPrice>> = {
  "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B": { inputNanoUsdPerToken: 60, outputNanoUsdPerToken: 240 },
  "nvidia/Nemotron-3_5-Lightning": { inputNanoUsdPerToken: 60, outputNanoUsdPerToken: 240 },
  "nvidia/nemotron-3-super-120b-a12b": { inputNanoUsdPerToken: 300, outputNanoUsdPerToken: 900 },
  "nvidia/Nemotron-3.5-Super-VL": { inputNanoUsdPerToken: 300, outputNanoUsdPerToken: 900 },
  "nvidia/Nemotron-3-Ultra-550b-a55b": { inputNanoUsdPerToken: 1000, outputNanoUsdPerToken: 3000 },
  "Qwen/Qwen3-Embedding-8B": { inputNanoUsdPerToken: 10, outputNanoUsdPerToken: 0 },
};

/**
 * Models with this prefix run on the local Ollama server (local simulation of
 * the Nebius path). They cost nothing, so their price is zero; the spend guard
 * still holds the minimum one micro-dollar for each call, so every call is
 * counted and settled like a paid one.
 */
export const LOCAL_MODEL_PREFIX = "ollama/";

const LOCAL_PRICE: ModelPrice = { inputNanoUsdPerToken: 0, outputNanoUsdPerToken: 0 };

export function isLocalModel(model: string): boolean {
  return model.startsWith(LOCAL_MODEL_PREFIX) && model.length > LOCAL_MODEL_PREFIX.length;
}

/**
 * The price of a model, or null when the model is not in the table. There is
 * no fallback price: some Nebius models cost much more than any model here,
 * so a model without a price must not be used. Local `ollama/` models are free.
 */
export function priceForModel(model: string): ModelPrice | null {
  if (isLocalModel(model)) return LOCAL_PRICE;
  return Object.hasOwn(PRICES, model) ? (PRICES[model] ?? null) : null;
}

/** True when both token counts are non-negative safe integers. */
export function isValidUsage(usage: TokenUsage): boolean {
  return [usage.promptTokens, usage.completionTokens].every((n) => Number.isSafeInteger(n) && n >= 0);
}

/**
 * Cost in micro-dollars, rounded up. Completion tokens include any reasoning
 * tokens. Throws on invalid usage: callers must treat that as missing usage.
 */
export function costMicroUsd(price: ModelPrice, usage: TokenUsage): number {
  if (!isValidUsage(usage)) throw new RangeError("Invalid token usage");
  const nano = usage.promptTokens * price.inputNanoUsdPerToken + usage.completionTokens * price.outputNanoUsdPerToken;
  return Math.ceil(nano / 1000);
}

/** Tokens added by the chat template around each message and the whole prompt (generous). */
const TOKENS_PER_MESSAGE = 16;
const TOKENS_PER_PROMPT = 64;

/**
 * An upper bound on the input tokens of a prompt. Byte-level tokenizers never
 * make more tokens than there are UTF-8 bytes, so the byte count is a safe
 * bound for any text, including emoji and other multi-byte characters. Tool
 * calls in assistant turns count with their arguments.
 */
export function inputTokenBound(messages: ChatMessage[], extraBytes = 0): number {
  const encoder = new TextEncoder();
  let bytes = extraBytes;
  for (const message of messages) {
    bytes += encoder.encode(message.content).length;
    for (const call of message.tool_calls ?? []) {
      bytes += encoder.encode(call.function.name).length + encoder.encode(call.function.arguments).length + 32;
    }
  }
  return bytes + messages.length * TOKENS_PER_MESSAGE + TOKENS_PER_PROMPT;
}
