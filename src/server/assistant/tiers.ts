import "server-only";
import type { ModelTier } from "@/lib/routing";

// Model tiers: which models each tier tries, in order, and its limits.
// Model chains and output limits come from config (src/server/config.ts);
// the timing numbers are here. See docs/decisions/0007-model-routing.md.

export const LIGHTNING = "nvidia/Nemotron-3_5-Lightning";
export const NANO = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B";
export const SUPER = "nvidia/nemotron-3-super-120b-a12b";
export const ULTRA = "nvidia/Nemotron-3-Ultra-550b-a55b";
export const SUPER_VL = "nvidia/Nemotron-3.5-Super-VL";

export interface TierPlan {
  tier: ModelTier;
  /** Models to try, in order. The first one is the tier's normal choice. */
  models: string[];
  maxOutputTokens: number;
  /** Reasoning budget in tokens; 0 turns reasoning off. Part of `maxOutputTokens`. */
  thinkingBudgetTokens: number;
  /** An attempt that sends no token in this time is stopped, and the next one starts. */
  firstTokenTimeoutMs: number;
  /** One deadline for the whole reply, across all attempts. */
  deadlineMs: number;
  /** Start one parallel attempt on the next model after this delay. Null: never. */
  hedgeAfterMs: number | null;
  /** Tries on one model before the next model (only for errors that can be retried). */
  triesPerModel: number;
  /** All attempts for one reply, hedge included. Limits cost and spend holds. */
  maxAttempts: number;
}

export type RoutingConfig = Record<ModelTier, TierPlan>;

/** Retry timing shared by all tiers. */
export const RETRY_POLICY = {
  /** Full-jitter exponential backoff: a random wait from 0 to min(max, base × 2^(try − 1)). */
  backoffBaseMs: 200,
  backoffMaxMs: 2_000,
  /** A longer `Retry-After` moves on to the next model instead of waiting. */
  retryAfterMaxMs: 2_000,
  /** No new attempt starts with less than this left before the deadline. */
  minAttemptMs: 1_000,
} as const;

export const DEFAULT_CHAINS: Record<ModelTier, string[]> = {
  fast: [LIGHTNING, NANO, SUPER],
  standard: [SUPER, LIGHTNING],
  heavy: [ULTRA, SUPER],
  vision: [SUPER_VL],
};

export interface RoutingSettings {
  chains: Record<ModelTier, string[]>;
  /** Output limit for the fast and vision tiers. */
  maxOutputTokens: number;
  standardMaxOutputTokens: number;
  heavyMaxOutputTokens: number;
  heavyThinkingBudgetTokens: number;
  /** 0 turns hedging off. */
  hedgeAfterMs: number;
  /**
   * Replaces every tier's first-token timeout. For local models (Ollama), which
   * load into memory on the first call and answer more slowly than Nebius.
   * Undefined keeps the production numbers below.
   */
  firstTokenTimeoutMs?: number;
}

export function buildRoutingConfig(settings: RoutingSettings): RoutingConfig {
  const hedge = settings.hedgeAfterMs > 0 ? settings.hedgeAfterMs : null;
  const firstToken = (production: number) => settings.firstTokenTimeoutMs ?? production;
  return {
    fast: {
      tier: "fast",
      models: settings.chains.fast,
      maxOutputTokens: settings.maxOutputTokens,
      thinkingBudgetTokens: 0,
      firstTokenTimeoutMs: firstToken(5_000),
      deadlineMs: 60_000,
      hedgeAfterMs: hedge,
      triesPerModel: 2,
      maxAttempts: 4,
    },
    standard: {
      tier: "standard",
      models: settings.chains.standard,
      maxOutputTokens: settings.standardMaxOutputTokens,
      thinkingBudgetTokens: 0,
      firstTokenTimeoutMs: firstToken(10_000),
      deadlineMs: 90_000,
      hedgeAfterMs: null,
      triesPerModel: 2,
      maxAttempts: 3,
    },
    heavy: {
      tier: "heavy",
      models: settings.chains.heavy,
      maxOutputTokens: settings.heavyMaxOutputTokens,
      thinkingBudgetTokens: settings.heavyThinkingBudgetTokens,
      // With reasoning on, reasoning tokens count as the first token.
      firstTokenTimeoutMs: firstToken(15_000),
      deadlineMs: 150_000,
      hedgeAfterMs: null,
      triesPerModel: 2,
      maxAttempts: 3,
    },
    vision: {
      tier: "vision",
      models: settings.chains.vision,
      maxOutputTokens: settings.maxOutputTokens,
      thinkingBudgetTokens: 0,
      firstTokenTimeoutMs: firstToken(10_000),
      deadlineMs: 60_000,
      hedgeAfterMs: null,
      triesPerModel: 2,
      maxAttempts: 2,
    },
  };
}
