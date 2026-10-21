import "server-only";
import { z } from "zod";
import { ConfigError } from "@/lib/supabase-config";
import { MODEL_TIERS, type ModelTier } from "@/lib/routing";
import { buildRoutingConfig, DEFAULT_CHAINS, type RoutingConfig } from "@/server/assistant/tiers";
import type { SpendCaps, SpendProvider } from "@/server/db/spend";
import { isLocalModel, priceForModel } from "@/server/providers/nebius/pricing";

// Server-only configuration. Values are read per call (not at import time) so
// `next build` works without secrets and misconfiguration fails the request
// that needs it with a clear, secret-free error.

export interface AssistantConfig {
  nebius: {
    apiKey: string;
    baseUrl: string;
  };
  /**
   * The local Ollama server (OpenAI-compatible `/v1`) that stands in for Nebius
   * in local runs. A model chain names a local model as `ollama/<model>`.
   * `embeddingModel` is set to embed locally; null keeps embeddings on Nebius.
   */
  ollama: {
    baseUrl: string;
    embeddingModel: string | null;
  };
  /** Model tiers: chains, output limits and timing (docs/decisions/0007-model-routing.md). */
  routing: RoutingConfig;
  /** Null when TAVILY_API_KEY is not set; search requests then report failure. */
  tavily: { apiKey: string } | null;
  quota: {
    requestsPerWindow: number;
    windowSeconds: number;
  };
  /**
   * Global spend caps, shared by all users. Nebius: micro-dollars, day and all-time.
   * Tavily: credits, day and calendar month (UTC).
   */
  spend: Record<SpendProvider, SpendCaps>;
}

const MICRO_USD_PER_USD = 1_000_000;

// The bounds match the hard limits in the reserve_provider_spend database function.
const usd = (min: number, max: number, fallback: number) => z.coerce.number().min(min).max(max).default(fallback);
const credits = (max: number, fallback: number) => z.coerce.number().int().min(1).max(max).default(fallback);

const outputTokens = (fallback: number) => z.coerce.number().int().min(64).max(8192).default(fallback);

const MODEL_ID = /^[A-Za-z0-9._:/-]{1,200}$/;

/**
 * A comma-separated list of 1 to 4 model IDs, tried in order. Every model must
 * have a price in the price table (the spend guard refuses unpriced models), so
 * an unpriced model is a config error, not a model the chain skips. A local
 * `ollama/` model is priced at zero.
 */
function modelChain(fallback: string[]) {
  return z
    .string()
    .transform((value) => value.split(",").map((model) => model.trim()).filter(Boolean))
    .refine((models) => models.length >= 1 && models.length <= 4)
    .refine((models) => new Set(models).size === models.length)
    .refine((models) => models.every((model) => MODEL_ID.test(model) && priceForModel(model) !== null))
    .default(fallback);
}

function chainEnvName(tier: ModelTier): string {
  return `NEBIUS_${tier.toUpperCase()}_MODELS`;
}

const assistantEnvSchema = z.object({
  NEBIUS_API_KEY: z.string().trim().min(1).optional(),
  NEBIUS_BASE_URL: z.url().default("https://api.tokenfactory.nebius.com/v1"),
  OLLAMA_BASE_URL: z.url().default("http://127.0.0.1:11434/v1"),
  OLLAMA_EMBEDDING_MODEL: z.string().trim().regex(MODEL_ID).optional(),
  NEBIUS_FAST_MODELS: modelChain(DEFAULT_CHAINS.fast),
  NEBIUS_STANDARD_MODELS: modelChain(DEFAULT_CHAINS.standard),
  NEBIUS_HEAVY_MODELS: modelChain(DEFAULT_CHAINS.heavy),
  NEBIUS_VISION_MODELS: modelChain(DEFAULT_CHAINS.vision),
  NEBIUS_MAX_OUTPUT_TOKENS: outputTokens(1024),
  NEBIUS_STANDARD_MAX_OUTPUT_TOKENS: outputTokens(2048),
  NEBIUS_HEAVY_MAX_OUTPUT_TOKENS: outputTokens(4096),
  NEBIUS_HEAVY_THINKING_BUDGET: z.coerce.number().int().min(0).max(4096).default(1024),
  NEBIUS_HEDGE_AFTER_MS: z.coerce.number().int().min(0).max(10_000).default(1500),
  NEBIUS_FIRST_TOKEN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).optional(),
  TAVILY_API_KEY: z.string().trim().optional(),
  CHAT_REQUESTS_PER_WINDOW: z.coerce.number().int().min(1).max(10_000).default(30),
  CHAT_WINDOW_SECONDS: z.coerce.number().int().min(60).max(2_678_400).default(3600),
  NEBIUS_DAILY_CAP_USD: usd(0.01, 100, 1),
  NEBIUS_TOTAL_CAP_USD: usd(0.01, 1000, 20),
  NEBIUS_USER_DAILY_CAP_USD: usd(0.01, 0.5, 0.25),
  TAVILY_DAILY_CREDITS: credits(1000, 40),
  TAVILY_MONTHLY_CREDITS: credits(20_000, 800),
  TAVILY_USER_DAILY_CREDITS: credits(20, 10),
});

const ROUTING_ENV_NAMES = [
  "NEBIUS_FAST_MODELS",
  "NEBIUS_STANDARD_MODELS",
  "NEBIUS_HEAVY_MODELS",
  "NEBIUS_VISION_MODELS",
  "NEBIUS_MAX_OUTPUT_TOKENS",
  "NEBIUS_STANDARD_MAX_OUTPUT_TOKENS",
  "NEBIUS_HEAVY_MAX_OUTPUT_TOKENS",
  "NEBIUS_HEAVY_THINKING_BUDGET",
  "NEBIUS_HEDGE_AFTER_MS",
  "NEBIUS_FIRST_TOKEN_TIMEOUT_MS",
] as const;

/** The reply needs this many tokens after the reasoning budget. */
const MIN_ANSWER_TOKENS = 512;

const SPEND_ENV_NAMES = [
  "NEBIUS_DAILY_CAP_USD",
  "NEBIUS_TOTAL_CAP_USD",
  "NEBIUS_USER_DAILY_CAP_USD",
  "TAVILY_DAILY_CREDITS",
  "TAVILY_MONTHLY_CREDITS",
  "TAVILY_USER_DAILY_CREDITS",
] as const;

function blankToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

export function getAssistantConfig(env: NodeJS.ProcessEnv = process.env): AssistantConfig {
  const parsed = assistantEnvSchema.safeParse({
    NEBIUS_API_KEY: blankToUndefined(env.NEBIUS_API_KEY),
    NEBIUS_BASE_URL: blankToUndefined(env.NEBIUS_BASE_URL),
    OLLAMA_BASE_URL: blankToUndefined(env.OLLAMA_BASE_URL),
    OLLAMA_EMBEDDING_MODEL: blankToUndefined(env.OLLAMA_EMBEDDING_MODEL),
    ...Object.fromEntries(ROUTING_ENV_NAMES.map((name) => [name, blankToUndefined(env[name])])),
    TAVILY_API_KEY: blankToUndefined(env.TAVILY_API_KEY),
    CHAT_REQUESTS_PER_WINDOW: blankToUndefined(env.CHAT_REQUESTS_PER_WINDOW),
    CHAT_WINDOW_SECONDS: blankToUndefined(env.CHAT_WINDOW_SECONDS),
    ...Object.fromEntries(SPEND_ENV_NAMES.map((name) => [name, blankToUndefined(env[name])])),
  });
  if (!parsed.success) {
    // Report variable names only, never values.
    const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
    throw new ConfigError(names);
  }
  const e = parsed.data;
  if (e.NEBIUS_HEAVY_MAX_OUTPUT_TOKENS - e.NEBIUS_HEAVY_THINKING_BUDGET < MIN_ANSWER_TOKENS) {
    // The reasoning budget must leave room for a visible reply.
    throw new ConfigError(["NEBIUS_HEAVY_THINKING_BUDGET"]);
  }
  const chains: Record<ModelTier, string[]> = {
    fast: e.NEBIUS_FAST_MODELS,
    standard: e.NEBIUS_STANDARD_MODELS,
    heavy: e.NEBIUS_HEAVY_MODELS,
    vision: e.NEBIUS_VISION_MODELS,
  };
  for (const tier of MODEL_TIERS) if (chains[tier].length === 0) throw new ConfigError([chainEnvName(tier)]);
  // The Nebius key may be left out only when nothing would call Nebius: every
  // chain is local and embeddings are local too.
  const allLocal = MODEL_TIERS.every((tier) => chains[tier].every(isLocalModel));
  if (!e.NEBIUS_API_KEY && !(allLocal && e.OLLAMA_EMBEDDING_MODEL)) throw new ConfigError(["NEBIUS_API_KEY"]);
  return {
    nebius: {
      apiKey: e.NEBIUS_API_KEY ?? "",
      baseUrl: e.NEBIUS_BASE_URL.replace(/\/+$/, ""),
    },
    ollama: {
      baseUrl: e.OLLAMA_BASE_URL.replace(/\/+$/, ""),
      embeddingModel: e.OLLAMA_EMBEDDING_MODEL ?? null,
    },
    routing: buildRoutingConfig({
      chains,
      maxOutputTokens: e.NEBIUS_MAX_OUTPUT_TOKENS,
      standardMaxOutputTokens: e.NEBIUS_STANDARD_MAX_OUTPUT_TOKENS,
      heavyMaxOutputTokens: e.NEBIUS_HEAVY_MAX_OUTPUT_TOKENS,
      heavyThinkingBudgetTokens: e.NEBIUS_HEAVY_THINKING_BUDGET,
      hedgeAfterMs: e.NEBIUS_HEDGE_AFTER_MS,
      firstTokenTimeoutMs: e.NEBIUS_FIRST_TOKEN_TIMEOUT_MS,
    }),
    tavily: e.TAVILY_API_KEY ? { apiKey: e.TAVILY_API_KEY } : null,
    quota: {
      requestsPerWindow: e.CHAT_REQUESTS_PER_WINDOW,
      windowSeconds: e.CHAT_WINDOW_SECONDS,
    },
    spend: {
      nebius: spendCaps(
        Math.round(e.NEBIUS_DAILY_CAP_USD * MICRO_USD_PER_USD),
        Math.round(e.NEBIUS_TOTAL_CAP_USD * MICRO_USD_PER_USD),
        Math.round(e.NEBIUS_USER_DAILY_CAP_USD * MICRO_USD_PER_USD),
      ),
      tavily: spendCaps(e.TAVILY_DAILY_CREDITS, e.TAVILY_MONTHLY_CREDITS, e.TAVILY_USER_DAILY_CREDITS),
    },
  };
}

/** The per-user cap can never be more than the cap for all users. */
function spendCaps(day: number, period: number, userDay: number): SpendCaps {
  return { day, period, userDay: Math.min(userDay, day) };
}

/** Public base URL used in auth emails (verification and password recovery). */
export function getSiteUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = blankToUndefined(env.SITE_URL);
  if (explicit) return explicit.replace(/\/+$/, "");
  return "http://localhost:3000";
}
