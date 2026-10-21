// Rules for scripts/check-worker-env.mjs. Kept apart from the command so tests can import them.
//
// Allow list, not a block list: a name-based block list always misses some secret
// (PGPASSWORD, POSTGRES_URL, ...). Only these names may have a value in the Worker
// bundle env file. None of them is a secret. To add a name, it must not be a secret.
export const ALLOWED_NAMES = new Set([
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SITE_URL",
  "NEBIUS_BASE_URL",
  // No longer read (model routing replaced it). Kept so an old .env file does not stop a deploy.
  "NEBIUS_MODEL",
  "NEBIUS_MAX_OUTPUT_TOKENS",
  "NEBIUS_FAST_MODELS",
  "NEBIUS_STANDARD_MODELS",
  "NEBIUS_HEAVY_MODELS",
  "NEBIUS_VISION_MODELS",
  "NEBIUS_STANDARD_MAX_OUTPUT_TOKENS",
  "NEBIUS_HEAVY_MAX_OUTPUT_TOKENS",
  "NEBIUS_HEAVY_THINKING_BUDGET",
  "NEBIUS_HEDGE_AFTER_MS",
  "NEBIUS_FIRST_TOKEN_TIMEOUT_MS",
  // Local simulation only (an Ollama server address and model name; not secrets).
  "OLLAMA_BASE_URL",
  "OLLAMA_EMBEDDING_MODEL",
  "CHAT_REQUESTS_PER_WINDOW",
  "CHAT_WINDOW_SECONDS",
  "NEBIUS_DAILY_CAP_USD",
  "NEBIUS_TOTAL_CAP_USD",
  "NEBIUS_USER_DAILY_CAP_USD",
  "TAVILY_DAILY_CREDITS",
  "TAVILY_MONTHLY_CREDITS",
  "TAVILY_USER_DAILY_CREDITS",
]);

/** Returns "mode.NAME" for each variable that has a value but is not allowed. Names only, never values. */
export function findBakedSecrets(envByMode) {
  const found = [];
  for (const [mode, vars] of Object.entries(envByMode)) {
    if (!vars || typeof vars !== "object") continue;
    for (const [name, value] of Object.entries(vars)) {
      if (ALLOWED_NAMES.has(name)) continue;
      if (typeof value === "string" && value.trim() !== "") found.push(`${mode}.${name}`);
    }
  }
  return found;
}
