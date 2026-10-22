import "server-only";
import {
  DOCUMENT_CHUNK_CHARS,
  MAX_DOCUMENT_TITLE_CHARS,
  MAX_MEMORY_CHARS,
  RETRIEVAL_MATCH_COUNT,
  SEARCH_EXCERPT_CHARS,
  SEARCH_MAX_RESULTS,
} from "@/lib/limits";
import { MAX_SAFE_URL_CHARS } from "@/lib/safe-url";
import { ConfigError } from "@/lib/supabase-config";
import type { ApiErrorCode } from "@/types/api";
import type { SpendLimit } from "@/server/db/spend";
import type { ChatMessage, TokenUsage } from "@/server/providers/nebius/client";
import {
  costMicroUsd,
  inputTokenBound,
  isValidUsage,
  priceForModel,
  type ModelPrice,
} from "@/server/providers/nebius/pricing";

/** The largest hold the database accepts for one Nebius call ($0.25). */
export const MAX_NEBIUS_HOLD_MICRO_USD = 250_000;

/** Credits for one Tavily search at `basic` depth (the chat's web search). */
export const TAVILY_BASIC_SEARCH_CREDITS = 1;

/** The most credits one Tavily reservation may hold (the SQL refuses more). */
export const TAVILY_MAX_RESERVATION_CREDITS = 2;

export type TavilyDepth = "basic" | "advanced";

/** Credits for one Tavily search: 1 at basic depth, 2 at advanced. */
export function tavilySearchCredits(depth: TavilyDepth): number {
  return depth === "advanced" ? 2 : TAVILY_BASIC_SEARCH_CREDITS;
}

/** The most URLs one extract reservation covers. */
export const TAVILY_EXTRACT_MAX_URLS = 5;

/**
 * Credits for one Tavily extract call: 1 per 5 URLs at basic depth, 2 per 5 at
 * advanced. Throws a RangeError for no URLs, more than 5 URLs or more than 2
 * credits, because one reservation may hold at most 2 credits.
 */
export function tavilyExtractCredits(urlCount: number, depth: TavilyDepth): number {
  if (!Number.isInteger(urlCount) || urlCount < 1 || urlCount > TAVILY_EXTRACT_MAX_URLS) {
    throw new RangeError(`An extract reservation covers 1 to ${TAVILY_EXTRACT_MAX_URLS} URLs`);
  }
  const credits = Math.ceil(urlCount / TAVILY_EXTRACT_MAX_URLS) * (depth === "advanced" ? 2 : 1);
  if (credits > TAVILY_MAX_RESERVATION_CREDITS) throw new RangeError("Too many credits for one reservation");
  return credits;
}

/**
 * Bytes that search results can add to the prompt: each result has a title
 * (200 characters) and an excerpt, with up to 4 UTF-8 bytes per character,
 * a normalized ASCII URL, and the wrapper text.
 */
export const SEARCH_RESULTS_MAX_BYTES =
  SEARCH_MAX_RESULTS * ((200 + SEARCH_EXCERPT_CHARS) * 4 + MAX_SAFE_URL_CHARS + 128) + 512;

/**
 * The most bytes one workflow tool result (<flight_results> or
 * <research_results>) may add to the next prompt. The workflow cuts its block
 * to fit (decision 0015).
 */
export const WORKFLOW_RESULT_MAX_BYTES = 24_576;

/**
 * The most bytes one connector tool result (<connector_results>) may add to
 * the next prompt. One workflow result and three connector results fit under
 * the hold ceiling with a full history on the heavy tier (Ultra, 8,192 output
 * tokens); tests/unit/spend-guard.test.ts checks it.
 */
export const CONNECTOR_RESULT_MAX_BYTES = 12_288;

/**
 * The most bytes one search_documents result may add: every matching chunk
 * and its title at up to 4 UTF-8 bytes per character, and the wrapper text.
 * The room check before the tool runs uses it.
 */
export const DOCUMENT_RESULTS_MAX_BYTES =
  RETRIEVAL_MATCH_COUNT * ((MAX_DOCUMENT_TITLE_CHARS + DOCUMENT_CHUNK_CHARS) * 4 + 64) + 256;

/** The most bytes one search_memories result may add, the same way. */
export const MEMORY_RESULTS_MAX_BYTES = RETRIEVAL_MATCH_COUNT * (MAX_MEMORY_CHARS * 4 + 32) + 256;

/** The model's price. A model without a price is a configuration error: it is never called. */
function requirePrice(model: string): ModelPrice {
  const price = priceForModel(model);
  if (!price) throw new ConfigError(["NEBIUS_MODEL"]);
  return price;
}

/**
 * The worst-case cost of one Nebius call is above the largest hold the
 * database accepts. The call is refused before anything is reserved or sent,
 * because a smaller hold would not cover its real cost.
 */
export class NebiusHoldTooLargeError extends Error {
  constructor() {
    super("refused: the worst-case cost is too large for one spend hold");
    this.name = "NebiusHoldTooLargeError";
  }
}

function requireHold(price: ModelPrice, worstCase: TokenUsage): number {
  const hold = Math.max(1, costMicroUsd(price, worstCase));
  if (hold > MAX_NEBIUS_HOLD_MICRO_USD) throw new NebiusHoldTooLargeError();
  return hold;
}

/** Bytes an embedding request can add for each text, on top of its own UTF-8 bytes. */
const EMBEDDING_BYTES_PER_TEXT = 16;

/**
 * Worst-case cost of one embedding batch: every UTF-8 byte is one token, plus
 * a small overhead for each text. Throws NebiusHoldTooLargeError above the
 * ceiling and ConfigError for a model without a price.
 */
export function nebiusEmbeddingHoldMicroUsd(model: string, texts: string[]): number {
  const encoder = new TextEncoder();
  const bytes = texts.reduce((sum, t) => sum + encoder.encode(t).length + EMBEDDING_BYTES_PER_TEXT, 0);
  return requireHold(requirePrice(model), { promptTokens: bytes, completionTokens: 0 });
}

/**
 * Worst-case cost of one Nebius call, in micro-dollars: every input byte as a
 * token, plus the full output token limit, at the model's price. Throws a
 * ConfigError for a model that has no price and NebiusHoldTooLargeError above
 * the ceiling, before any provider call.
 */
export function nebiusHoldMicroUsd(
  model: string,
  messages: ChatMessage[],
  maxOutputTokens: number,
  extraInputBytes = 0,
): number {
  return requireHold(requirePrice(model), {
    promptTokens: inputTokenBound(messages, extraInputBytes),
    completionTokens: maxOutputTokens,
  });
}

/**
 * True when the next call's worst-case hold, for the most expensive of
 * `models`, still fits under the ceiling with `extraBytes` more input (for
 * example the tool results that are about to be added). False instead of
 * NebiusHoldTooLargeError, so a tool can answer "not run: context full"
 * before it calls anything. Throws ConfigError for a model without a price.
 */
export function nextHopFits(
  models: string[],
  messages: ChatMessage[],
  maxOutputTokens: number,
  extraBytes: number,
): boolean {
  try {
    for (const model of models) nebiusHoldMicroUsd(model, messages, maxOutputTokens, extraBytes);
    return true;
  } catch (error) {
    if (error instanceof NebiusHoldTooLargeError) return false;
    throw error;
  }
}

/**
 * The amount to settle for a Nebius call. With valid usage, the real cost.
 * Without usage (error, stop, disconnect) or with invalid usage, the full
 * hold: a safe estimate, never zero. Never more than the hold, because settle
 * can only give back.
 */
export function nebiusSettleMicroUsd(model: string, heldMicroUsd: number, usage: TokenUsage | null): number {
  const price = priceForModel(model);
  if (!usage || !price || !isValidUsage(usage)) return heldMicroUsd;
  return Math.min(heldMicroUsd, costMicroUsd(price, usage));
}

export interface BudgetRefusal {
  status: number;
  code: ApiErrorCode;
  message: string;
  headers?: Record<string, string>;
}

function secondsToNextUtcDay(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/** The response when the Nebius budget refuses a chat request. */
export function budgetRefusal(limit: SpendLimit, now: Date): BudgetRefusal {
  if (limit === "period") {
    return {
      status: 503,
      code: "budget_exhausted",
      message: "P-Dot has reached its total usage limit. Try again later.",
    };
  }
  return {
    status: 429,
    code: "budget_exhausted",
    message:
      limit === "user"
        ? "You have reached your daily usage limit. Try again tomorrow."
        : "P-Dot has reached its daily usage limit. Try again tomorrow.",
    headers: { "Retry-After": String(secondsToNextUtcDay(now)) },
  };
}

export const SEARCH_BUDGET_MESSAGE =
  "Web search was not used because P-Dot has reached its search limit for now, so this answer is not based on web sources.";
