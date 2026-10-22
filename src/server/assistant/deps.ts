import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { after } from "next/server";
import { ConfigError } from "@/lib/supabase-config";
import type { AuthContext } from "@/server/auth/session";
import type { AssistantConfig } from "@/server/config";
import { getConnectorConfig } from "@/server/connectors/config";
import { createGoogleConnector, type GoogleConnector } from "@/server/connectors/google/connector";
import { createActionProposalRepository } from "@/server/db/action-proposals";
import { createContextRecordRepository } from "@/server/db/context-records";
import { createConversationRepository } from "@/server/db/conversations";
import { createMemoryRepository } from "@/server/db/memories";
import { createMessageResultsRepository } from "@/server/db/message-results";
import { createQuotaGate } from "@/server/db/quota";
import { createRetrievalRepository } from "@/server/db/retrieval";
import { createSpendGuard, type SpendGuard } from "@/server/db/spend";
import { logEvent, type Logger } from "@/server/log";
import { createNebiusProvider, createOllamaProvider, createRoutedProvider, type ModelProvider } from "@/server/providers/model";
import { LOCAL_MODEL_PREFIX } from "@/server/providers/nebius/pricing";
import { searchWeb } from "@/server/providers/tavily/client";
import { BREAKER_DEFAULTS, createCircuitBreaker } from "./breaker";
import { createBudgetedEmbedder, type Embedder } from "./embed";
import type { AssistantDeps } from "./service";
import { bindTavily } from "./workflows/core";

/**
 * One breaker for each Workers isolate. Best effort: isolates do not share it,
 * and it is lost when the isolate is recycled. It only skips a failing model
 * for a short time; it never sets a limit.
 */
const breaker = createCircuitBreaker(BREAKER_DEFAULTS);

/** Wires the assistant service to real providers for one authenticated request. */
export function createAssistantDeps(auth: AuthContext, config: AssistantConfig): AssistantDeps {
  const tavily = config.tavily;
  const spend = createSpendGuard(auth.supabase, config.spend);
  return {
    repo: createConversationRepository(auth.supabase),
    quota: createQuotaGate(auth.supabase, config.quota.requestsPerWindow, config.quota.windowSeconds),
    spend,
    routing: config.routing,
    search: tavily ? (query, signal) => searchWeb(tavily, query, { signal }) : null,
    provider: createModelProvider(config),
    breaker,
    now: () => new Date(),
    log: logEvent,
    waitUntil: createWaitUntilForRequest(),
    contextRecords: createContextRecordRepository(auth.supabase),
    memories: createMemoryRepository(auth.supabase),
    retrieval: createRetrievalRepository(auth.supabase),
    actionProposals: createActionProposalRepository(auth.supabase),
    embedder: createEmbedder(config, spend),
    smartTitles: true,
    workflowTavily: tavily ? bindTavily(tavily) : null,
    messageResults: createMessageResultsRepository(auth.supabase),
    connector: createConnectorForRequest(auth),
  };
}

/**
 * The Google connector for one request, built on first use and then reused
 * (decision 0016). Null when connectors are not configured. A malformed
 * setting must not break chat: it logs the variable names and gives null.
 */
export function createConnectorForRequest(
  auth: AuthContext,
  env: NodeJS.ProcessEnv = process.env,
  log: Logger = logEvent,
): () => GoogleConnector | null {
  let built: GoogleConnector | null | undefined;
  return () => {
    if (built !== undefined) return built;
    try {
      const config = getConnectorConfig(env);
      built = config ? createGoogleConnector({ supabase: auth.supabase, userId: auth.userId, config }) : null;
    } catch (error) {
      log("warn", "connector_config_invalid", {
        provider: "google",
        names: error instanceof ConfigError ? error.missing.join(",") : undefined,
        errorName: error instanceof ConfigError ? undefined : error instanceof Error ? error.name : "unknown",
      });
      built = null;
    }
    return built;
  };
}

/**
 * Nebius for every model, and the local Ollama for a model with the `ollama/`
 * prefix. Both go through the same client, so a local run exercises the
 * production path.
 */
export function createModelProvider(config: AssistantConfig): ModelProvider {
  return createRoutedProvider({
    nebius: createNebiusProvider(config.nebius),
    ollama: createOllamaProvider(config.ollama),
  });
}

/**
 * Keeps work running after the response ends. On Cloudflare Workers it goes to
 * the request's ctx.waitUntil; elsewhere (Vercel, `next start`) to Next's
 * after(), which hands it to the platform's waitUntil (decision 0017). Outside
 * a request (tests, scripts) neither exists, and the work simply runs.
 */
export function waitUntil(work: Promise<unknown>): void {
  try {
    getCloudflareContext().ctx.waitUntil(work);
    return;
  } catch {
    // Not running in the Workers runtime.
  }
  try {
    after(work);
  } catch {
    // Outside a request scope.
  }
}

/**
 * waitUntil bound to the request that is running now. after() works only in
 * the request's async context, but a streamed reply runs most of its code
 * after the route handler has returned, when the client reads the next chunk.
 * Call this in the route handler, as createAssistantDeps does.
 */
export function createWaitUntilForRequest(): (work: Promise<unknown>) => void {
  const inRequest = AsyncLocalStorage.snapshot();
  return (work) => inRequest(() => waitUntil(work));
}

/**
 * A spend-guarded embedder for one authenticated request. Throws ConfigError
 * (the route answers 503 not_configured) when Nebius is not configured.
 */
export function createEmbedderForRequest(auth: AuthContext, config: AssistantConfig): Embedder {
  return createEmbedder(config, createSpendGuard(auth.supabase, config.spend));
}

/** Nebius embeddings, or the local Ollama model when OLLAMA_EMBEDDING_MODEL is set. */
function createEmbedder(config: AssistantConfig, spend: SpendGuard): Embedder {
  if (config.ollama.embeddingModel) {
    return createBudgetedEmbedder({
      settings: { apiKey: "ollama", baseUrl: config.ollama.baseUrl, model: config.ollama.embeddingModel, provider: "ollama" },
      priceModel: `${LOCAL_MODEL_PREFIX}${config.ollama.embeddingModel}`,
      spend,
    });
  }
  return createBudgetedEmbedder({
    settings: { apiKey: config.nebius.apiKey, baseUrl: config.nebius.baseUrl },
    spend,
  });
}
