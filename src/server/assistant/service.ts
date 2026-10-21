import "server-only";
import {
  HISTORY_CHAR_BUDGET,
  HISTORY_MESSAGE_LIMIT,
  MAX_ASSISTANT_CHARS,
  MAX_MEMORY_CHARS,
  RETRIEVAL_MATCH_COUNT,
} from "@/lib/limits";
import { actionPayloadSchema } from "@/lib/schemas";
import type {
  ActionPayload,
  ApiErrorCode,
  ChatRequest,
  ChatStreamEvent,
  ConversationSummary,
  MessageDTO,
  Mode,
  SourceRef,
  WebSearchStatus,
} from "@/types/api";
import type { ActionProposalRepository } from "@/server/db/action-proposals";
import { limitIds, type ContextRecordRepository } from "@/server/db/context-records";
import type { ConversationRepository } from "@/server/db/conversations";
import type { MemoryRepository } from "@/server/db/memories";
import type { QuotaGate } from "@/server/db/quota";
import type { RetrievalRepository } from "@/server/db/retrieval";
import type { SpendGuard } from "@/server/db/spend";
import type { Logger } from "@/server/log";
import { ProviderError } from "@/server/providers/errors";
import { isValidUsage } from "@/server/providers/nebius/pricing";
import type { ChatMessage, ModelProvider, TokenUsage } from "@/server/providers/model";
import type { WebSearchResult } from "@/server/providers/tavily/client";
import type { CircuitBreaker } from "./breaker";
import { attemptBudget, completeText, settleQuietly, type NebiusHold } from "./complete";
import { buildContextWindow, SMART_TITLE_SYSTEM_PROMPT, smartTitleFromText, titleFromMessage, type HistoryMessage } from "./context";
import { EmbeddingBudgetError, type Embedder } from "./embed";
import { publicSearchFailureMessage, toPublicCompletionError } from "./errors";
import { BudgetExhaustedError, EmptyReplyError, executeRouted, newRouteReport, type RouteReport } from "./executor";
import {
  PROMPT_VERSION,
  buildPromptMessages,
  formatDocumentResults,
  formatMemoryResults,
  formatSearchResults,
  type MemoryExcerpt,
} from "./prompt";
import { routeRequest, type RouteDecision } from "./router";
import {
  budgetRefusal,
  nebiusHoldMicroUsd,
  NebiusHoldTooLargeError,
  SEARCH_BUDGET_MESSAGE,
  SEARCH_RESULTS_MAX_BYTES,
  TAVILY_BASIC_SEARCH_CREDITS,
} from "./spend";
import type { RoutingConfig } from "./tiers";
import {
  MAX_TOOL_CALLS_PER_HOP,
  MAX_TOOL_HOPS,
  PROPOSE_REMINDER_TOOL,
  PROPOSE_TASK_TOOL,
  SAVE_MEMORY_TOOL,
  SEARCH_DOCUMENTS_TOOL,
  SEARCH_MEMORIES_TOOL,
  TOOLS_MAX_BYTES,
  WEB_SEARCH_TOOL,
  parseToolArgs,
  proposeReminderArgsSchema,
  proposeTaskArgsSchema,
  saveMemoryArgsSchema,
  searchDocumentsArgsSchema,
  searchMemoriesArgsSchema,
  webSearchArgsSchema,
  type ToolCall,
  type ToolDefinition,
} from "./tools";

export type { NebiusHold } from "./complete";

export interface AssistantDeps {
  repo: ConversationRepository;
  quota: QuotaGate;
  /** Global spend caps for paid providers, shared by all users. */
  spend: SpendGuard;
  /** Model tiers: chains, limits and timing. Each attempt is priced for its model. */
  routing: RoutingConfig;
  /** Null when web search is not configured on this server. */
  search: ((query: string, signal: AbortSignal) => Promise<WebSearchResult[]>) | null;
  /** The model provider used by the executor for every attempt. */
  provider: ModelProvider;
  /** Soft per-model circuit breaker (isolate memory, best effort). */
  breaker: CircuitBreaker;
  /** Random number from 0 to 1 for backoff jitter (tests replace it). */
  random?: () => number;
  now: () => Date;
  log: Logger;
  /** Keeps work (the spend settle) running after the client disconnects. */
  waitUntil: (work: Promise<unknown>) => void;
  /**
   * Stores "what was sent" for each saved reply (decision 0009). Optional:
   * without it, no record is written. A failed write never fails the reply.
   */
  contextRecords?: ContextRecordRepository;
  /**
   * The tool loop's data (decision 0009). Each one is optional: a tool is
   * offered to the model only when what it needs is wired. `embedder` is the
   * spend-guarded embedder for retrieval queries and new memory vectors.
   */
  memories?: MemoryRepository;
  retrieval?: RetrievalRepository;
  actionProposals?: ActionProposalRepository;
  embedder?: Embedder;
  /** Name a new conversation from its first exchange with one short fast-tier call. */
  smartTitles?: boolean;
}

export interface PreparedTurn {
  requestId: string;
  userId: string;
  conversation: ConversationSummary;
  userMessage: MessageDTO;
  /** Chronological history ending with `userMessage`. */
  history: HistoryMessage[];
  webSearch: boolean;
  /** True when search was requested but the Tavily budget refused it. */
  searchBudgetExhausted: boolean;
  /** The tier for this reply and why the router chose it. */
  route: RouteDecision;
  /** Held before streaming. It pays for the first attempt, on any model of the tier. */
  nebiusHold: NebiusHold;
}

export type PrepareResult =
  | { ok: true; turn: PreparedTurn }
  | {
      ok: false;
      status: number;
      code: ApiErrorCode;
      message: string;
      headers?: Record<string, string>;
    };

/** Bytes the retrieved memories can add to the system message, for the worst-case hold. */
const MEMORY_CONTEXT_MAX_BYTES = RETRIEVAL_MATCH_COUNT * (MAX_MEMORY_CHARS * 4 + 64) + 512;

/** The tools the model may call, given what is wired. */
export function availableTools(deps: AssistantDeps): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  if (deps.search) tools.push(WEB_SEARCH_TOOL);
  if (deps.retrieval && deps.embedder) tools.push(SEARCH_DOCUMENTS_TOOL, SEARCH_MEMORIES_TOOL);
  if (deps.memories) tools.push(SAVE_MEMORY_TOOL);
  if (deps.actionProposals) tools.push(PROPOSE_TASK_TOOL, PROPOSE_REMINDER_TOOL);
  return tools;
}

/** Bytes that search results, tools and memories can add to the first prompt. */
function extraPromptBytes(deps: AssistantDeps, searchWanted: boolean): number {
  let bytes = searchWanted ? SEARCH_RESULTS_MAX_BYTES : 0;
  if (availableTools(deps).length > 0) bytes += TOOLS_MAX_BYTES;
  if (deps.retrieval && deps.embedder) bytes += MEMORY_CONTEXT_MAX_BYTES;
  return bytes;
}

/**
 * Everything that must succeed before the response stream starts: ownership
 * check, retry precondition, usage quota, global spend caps, and saving the
 * user's message.
 * `userId` must come from the verified session, never from the request body.
 */
export async function prepareChatTurn(
  deps: AssistantDeps,
  input: { userId: string; requestId: string; request: ChatRequest },
): Promise<PrepareResult> {
  const { userId, requestId, request } = input;

  let existing: ConversationSummary | null = null;
  let recent: MessageDTO[] = [];
  if (request.conversationId) {
    existing = await deps.repo.getConversation(userId, request.conversationId);
    if (!existing) {
      return { ok: false, status: 404, code: "not_found", message: "Conversation not found." };
    }
    recent = await deps.repo.listRecentMessages(userId, existing.id, HISTORY_MESSAGE_LIMIT);
  }

  if (request.action === "retry" && recent.at(-1)?.role !== "user") {
    return {
      ok: false,
      status: 409,
      code: "conflict",
      message: "There is no unanswered message to retry.",
    };
  }

  const decision = await deps.quota.consume();
  if (!decision.allowed) {
    const seconds = Math.max(1, Math.ceil((decision.resetsAt.getTime() - deps.now().getTime()) / 1000));
    return {
      ok: false,
      status: 429,
      code: "rate_limited",
      message: "You have reached your request limit for now. Please try again later.",
      headers: { "Retry-After": String(seconds) },
    };
  }

  // Global spend caps, after the per-user quota and before any paid call.
  // The hold is the worst case for the prompt this turn will send.
  const mode = existing?.mode ?? (request.action === "send" ? (request.mode ?? "personal") : "personal");
  const pendingHistory: HistoryMessage[] = recent.map(({ role, content }) => ({ role, content }));
  if (request.action === "send") pendingHistory.push({ role: "user", content: request.message });
  const searchWanted = request.webSearch && deps.search !== null;
  const route = routeRequest({
    message: pendingHistory.at(-1)?.content ?? "",
    historyChars: pendingHistory.slice(0, -1).reduce((sum, message) => sum + message.content.length, 0),
    webSearch: request.webSearch,
    effort: request.effort ?? "auto",
  });
  const plan = deps.routing[route.tier];
  const promptBound = buildPromptMessages({
    history: buildContextWindow(pendingHistory, HISTORY_CHAR_BUDGET),
    webSearch: request.webSearch ? "failed" : "off",
    results: [],
    now: deps.now(),
    mode,
  });
  // The first attempt can run on any model of the tier (the breaker can skip
  // the first one), so hold for the most expensive one.
  let heldMicroUsd: number;
  try {
    heldMicroUsd = Math.max(
      ...plan.models.map((model) =>
        nebiusHoldMicroUsd(model, promptBound, plan.maxOutputTokens, extraPromptBytes(deps, searchWanted)),
      ),
    );
  } catch (error) {
    if (!(error instanceof NebiusHoldTooLargeError)) throw error;
    deps.log("warn", "spend_hold_too_large", { requestId, route: "chat", tier: route.tier });
    return {
      ok: false,
      status: 413,
      code: "payload_too_large",
      message: "This request is too large to answer. Start a new conversation or turn off web search.",
    };
  }
  const nebius = await deps.spend.reserve("nebius", heldMicroUsd);
  if (!nebius.allowed) {
    deps.log("warn", "spend_limit_reached", { requestId, route: "chat", provider: "nebius", limit: nebius.limit });
    return { ok: false, ...budgetRefusal(nebius.limit, deps.now()) };
  }
  const nebiusHold: NebiusHold = { reservationId: nebius.id, heldMicroUsd };

  let tavilyReservation: string | null = null;
  try {
    let searchBudgetExhausted = false;
    if (searchWanted) {
      const tavily = await deps.spend.reserve("tavily", TAVILY_BASIC_SEARCH_CREDITS);
      if (tavily.allowed) {
        tavilyReservation = tavily.id;
      } else {
        searchBudgetExhausted = true;
        deps.log("warn", "spend_limit_reached", { requestId, route: "chat", provider: "tavily", limit: tavily.limit });
      }
    }

    let conversation: ConversationSummary;
    let userMessage: MessageDTO;
    if (request.action === "send") {
      conversation =
        existing ?? (await deps.repo.createConversation(userId, titleFromMessage(request.message), mode));
      userMessage = await deps.repo.insertMessage(userId, {
        conversationId: conversation.id,
        role: "user",
        content: request.message,
      });
      recent = [...recent, userMessage];
    } else {
      // Retry: both were verified above.
      conversation = existing!;
      userMessage = recent.at(-1)!;
    }

    return {
      ok: true,
      turn: {
        requestId,
        userId,
        conversation: { ...conversation, updatedAt: userMessage.createdAt },
        userMessage,
        history: recent.map(({ role, content }) => ({ role, content })),
        webSearch: request.webSearch,
        searchBudgetExhausted,
        route,
        nebiusHold,
      },
    };
  } catch (error) {
    // No paid call will happen: give the holds back (best effort; a hold that
    // is not given back stays counted, which is the safe side).
    await settleQuietly(deps, requestId, "nebius", nebiusHold.reservationId, 0);
    if (tavilyReservation) await settleQuietly(deps, requestId, "tavily", tavilyReservation, 0);
    throw error;
  }
}

function toSourceRefs(results: WebSearchResult[]): SourceRef[] {
  return results.map(({ title, url }) => ({ title, url }));
}

/** Normalizes citation brackets and no-break spaces some models emit. */
function normalizeReplyText(text: string): string {
  return text.replace(/[  ]/g, " ").replace(/【([0-9]+)】/g, "[$1]");
}

/**
 * Runs retrieval (if requested) and inference, streaming events to the client.
 * The assistant reply is persisted only when it completes. Never throws:
 * failures become a final `error` event. Every Nebius hold is settled, also
 * when the client stops or disconnects.
 */
export async function* streamChatTurn(
  deps: AssistantDeps,
  turn: PreparedTurn,
  signal: AbortSignal,
): AsyncGenerator<ChatStreamEvent> {
  const settles: Promise<void>[] = [];
  const holds = { prepaid: turn.nebiusHold as NebiusHold | null };
  const settle = (hold: NebiusHold, amount: number) => {
    const settling = settleQuietly(deps, turn.requestId, "nebius", hold.reservationId, amount);
    deps.waitUntil(settling);
    settles.push(settling);
  };
  try {
    yield* runChatTurn(deps, turn, signal, holds, settle);
  } finally {
    // No attempt used the first hold (for example Stop during search): no call was made.
    if (holds.prepaid) settle(holds.prepaid, 0);
    await Promise.all(settles);
  }
}

/** What one tool call produced: the text for the model, and an event for the client. */
interface ToolOutcome {
  text: string;
  event?: ChatStreamEvent;
}

/** A short status line when the model called a tool without saying why. */
function describeCalls(calls: ToolCall[]): string {
  const names = calls.map((call) => call.function.name);
  if (names.includes("web_search")) return "Searching the web…";
  if (names.includes("search_documents")) return "Searching your documents…";
  if (names.includes("search_memories")) return "Checking what you asked P-Dot to remember…";
  if (names.includes("save_memory")) return "Suggesting something to remember…";
  if (names.includes("propose_task") || names.includes("propose_reminder")) return "Preparing a suggestion to approve…";
  return "Working…";
}

function addUsage(total: TokenUsage | null | undefined, next: TokenUsage | null): TokenUsage | null {
  if (total === null || next === null || !isValidUsage(next)) return null;
  if (total === undefined) return next;
  return { promptTokens: total.promptTokens + next.promptTokens, completionTokens: total.completionTokens + next.completionTokens };
}

async function* runChatTurn(
  deps: AssistantDeps,
  turn: PreparedTurn,
  signal: AbortSignal,
  holds: { prepaid: NebiusHold | null },
  settle: (hold: NebiusHold, amount: number) => void,
): AsyncGenerator<ChatStreamEvent> {
  const startedAt = Date.now();
  const logBase = { requestId: turn.requestId, route: "chat" };
  const mode: Mode = turn.conversation.mode;

  yield {
    type: "start",
    requestId: turn.requestId,
    conversation: turn.conversation,
    userMessage: turn.userMessage,
    route: turn.route,
  };

  // 1. Optional web retrieval. Search is never called unless requested.
  let webSearch: WebSearchStatus = "off";
  let results: WebSearchResult[] = [];
  if (turn.webSearch) {
    if (turn.searchBudgetExhausted) {
      webSearch = "failed";
      yield { type: "search", status: "failed", sources: [], message: SEARCH_BUDGET_MESSAGE };
    } else if (!deps.search) {
      webSearch = "failed";
      yield {
        type: "search",
        status: "failed",
        sources: [],
        message: "Web search is not configured on this server, so this answer is not based on web sources.",
      };
    } else {
      try {
        results = await deps.search(turn.userMessage.content, signal);
        webSearch = results.length > 0 ? "used" : "no_results";
        yield {
          type: "search",
          status: webSearch,
          sources: toSourceRefs(results),
          ...(webSearch === "no_results"
            ? { message: "Web search found no usable results, so this answer is not based on web sources." }
            : {}),
        };
      } catch (error) {
        if (signal.aborted) {
          deps.log("info", "chat_client_aborted", { ...logBase, stage: "search" });
          return;
        }
        webSearch = "failed";
        results = [];
        deps.log("warn", "search_failed", {
          ...logBase,
          kind: error instanceof ProviderError ? error.kind : "unknown",
          status: error instanceof ProviderError ? error.status : undefined,
        });
        yield { type: "search", status: "failed", sources: [], message: publicSearchFailureMessage(error) };
      }
    }
  }

  // 2. Memories that match the message, for the system prompt (IDs go to the context record).
  const usedMemoryIds = new Set<string>();
  const usedChunkIds = new Set<string>();
  let memories: MemoryExcerpt[] = [];
  if (deps.retrieval && deps.embedder) {
    try {
      const [vector] = await deps.embedder.embed([turn.userMessage.content], signal);
      if (vector) {
        const matches = await deps.retrieval.matchMemories(vector, mode, RETRIEVAL_MATCH_COUNT);
        memories = matches.map(({ content }) => ({ content }));
        for (const match of matches) usedMemoryIds.add(match.id);
      }
    } catch (error) {
      if (signal.aborted) {
        deps.log("info", "chat_client_aborted", { ...logBase, stage: "memory_retrieval" });
        return;
      }
      deps.log("warn", "memory_retrieval_failed", { ...logBase, errorName: error instanceof Error ? error.name : "unknown" });
    }
  }

  // 3. Inference over a bounded context window, on the routed tier, with the tool loop.
  const tools = availableTools(deps);
  const historyWindow = buildContextWindow(turn.history, HISTORY_CHAR_BUDGET);
  const messages: ChatMessage[] = buildPromptMessages({
    history: historyWindow,
    webSearch,
    results,
    now: deps.now(),
    mode,
    memories,
    tools,
    toolHops: MAX_TOOL_HOPS - 1,
  });
  const plan = deps.routing[turn.route.tier];
  const webSources: WebSearchResult[] = [...results];
  const seenUrls = new Set(results.map((result) => result.url));

  /** Runs one tool call. Never throws except when the client aborted. */
  async function runTool(call: ToolCall): Promise<ToolOutcome> {
    const name = call.function.name;
    try {
      if (name === "web_search" && deps.search) {
        const args = parseToolArgs(call, webSearchArgsSchema);
        if (!args.ok) return { text: args.message };
        const credit = await deps.spend.reserve("tavily", TAVILY_BASIC_SEARCH_CREDITS);
        if (!credit.allowed) {
          deps.log("warn", "spend_limit_reached", { ...logBase, provider: "tavily", limit: credit.limit, stage: "tool" });
          return {
            text: "Web search is not available right now (search limit reached). Answer from what you know and say the answer is not based on a web search.",
          };
        }
        let found: WebSearchResult[];
        try {
          found = await deps.search(args.value.query, signal);
        } catch (error) {
          if (signal.aborted) throw error;
          deps.log("warn", "search_failed", {
            ...logBase,
            stage: "tool",
            kind: error instanceof ProviderError ? error.kind : "unknown",
            status: error instanceof ProviderError ? error.status : undefined,
          });
          if (webSearch === "off") webSearch = "failed";
          return {
            text: "Web search failed. Answer from what you know and say the answer is not based on a web search.",
            event: { type: "search", status: "failed", sources: toSourceRefs(webSources), message: publicSearchFailureMessage(error) },
          };
        }
        const fresh = found.filter((result) => !seenUrls.has(result.url));
        for (const result of fresh) seenUrls.add(result.url);
        const startIndex = webSources.length + 1;
        webSources.push(...fresh);
        if (webSources.length > 0) webSearch = "used";
        else if (webSearch !== "failed") webSearch = "no_results";
        return {
          text: found.length > 0 ? formatSearchResults(fresh.length > 0 ? fresh : found, startIndex) : "No web results found for that query.",
          event: {
            type: "search",
            status: webSources.length > 0 ? "used" : "no_results",
            sources: toSourceRefs(webSources),
            ...(webSources.length === 0 ? { message: "Web search found no usable results." } : {}),
          },
        };
      }
      if (name === "search_documents" && deps.retrieval && deps.embedder) {
        const args = parseToolArgs(call, searchDocumentsArgsSchema);
        if (!args.ok) return { text: args.message };
        const [vector] = await deps.embedder.embed([args.value.query], signal);
        if (!vector) return { text: "Document search is not available right now." };
        const matches = await deps.retrieval.matchDocumentChunks(vector, mode, RETRIEVAL_MATCH_COUNT);
        for (const match of matches) usedChunkIds.add(match.id);
        if (matches.length === 0) return { text: "No matching text in the user's documents." };
        return { text: formatDocumentResults(matches.map(({ title, content }) => ({ title, content })), webSources.length + 1) };
      }
      if (name === "search_memories" && deps.retrieval && deps.embedder) {
        const args = parseToolArgs(call, searchMemoriesArgsSchema);
        if (!args.ok) return { text: args.message };
        const [vector] = await deps.embedder.embed([args.value.query], signal);
        if (!vector) return { text: "Memory search is not available right now." };
        const matches = await deps.retrieval.matchMemories(vector, mode, RETRIEVAL_MATCH_COUNT);
        for (const match of matches) usedMemoryIds.add(match.id);
        if (matches.length === 0) return { text: "No matching memories." };
        return { text: formatMemoryResults(matches.map(({ content }) => ({ content }))) };
      }
      if (name === "save_memory" && deps.memories) {
        const args = parseToolArgs(call, saveMemoryArgsSchema);
        if (!args.ok) return { text: args.message };
        let vector: number[] | null = null;
        if (deps.embedder) {
          try {
            vector = (await deps.embedder.embed([args.value.content], signal))[0] ?? null;
          } catch (error) {
            if (signal.aborted) throw error;
            deps.log("warn", "memory_embedding_failed", { ...logBase, errorName: error instanceof Error ? error.name : "unknown" });
          }
        }
        await deps.memories.createMemory(
          turn.userId,
          { mode, content: args.value.content, status: "proposed", source: "assistant", sourceMessageId: turn.userMessage.id },
          vector,
        );
        return {
          text: "Suggested to the user as something to remember. They will see a card to keep or discard it. Tell them you suggested it; do not say it is saved.",
        };
      }
      if ((name === "propose_task" || name === "propose_reminder") && deps.actionProposals) {
        let payload: ActionPayload;
        let summary: string;
        if (name === "propose_task") {
          const args = parseToolArgs(call, proposeTaskArgsSchema);
          if (!args.ok) return { text: args.message };
          payload = { kind: "create_task", mode, title: args.value.title };
          summary = `Add task: ${args.value.title}`;
        } else {
          const args = parseToolArgs(call, proposeReminderArgsSchema);
          if (!args.ok) return { text: args.message };
          payload = { kind: "create_reminder", mode, title: args.value.title, dueAt: args.value.due_at };
          summary = `Remind: ${args.value.title}`;
        }
        const valid = actionPayloadSchema.safeParse(payload);
        if (!valid.success) return { text: `Invalid proposal: ${valid.error.issues[0]?.message ?? "check the arguments"}.` };
        await deps.actionProposals.createProposal(turn.userId, { conversationId: turn.conversation.id, payload: valid.data, summary });
        return {
          text: `Proposed to the user as a card to approve: "${summary}". Tell them it waits for their approval; do not say it is done.`,
        };
      }
      return { text: `The tool "${name}" is not available. Answer without it.` };
    } catch (error) {
      if (signal.aborted) throw error;
      deps.log("warn", "tool_failed", { ...logBase, tool: name, errorName: error instanceof Error ? error.name : "unknown" });
      if (error instanceof EmbeddingBudgetError) return { text: "That tool is not available right now (usage limit). Answer without it." };
      return { text: "That tool is temporarily unavailable. Answer without it." };
    }
  }

  const reports: RouteReport[] = [];
  let content = "";
  let truncated = false;
  let finishReason: string | null = null;
  let usage: TokenUsage | null | undefined = undefined;
  let toolCalls = 0;
  for (let hop = 0; ; hop += 1) {
    const hopTools = hop < MAX_TOOL_HOPS - 1 ? tools : [];
    const report = newRouteReport(plan.tier);
    reports.push(report);
    const budget = attemptBudget(deps, {
      requestId: turn.requestId,
      plan,
      messages,
      extraInputBytes: hopTools.length > 0 ? TOOLS_MAX_BYTES : 0,
      holds,
      settle,
      logFields: { hop },
    });
    let hopText = "";
    let calls: ToolCall[] = [];
    try {
      for await (const chunk of executeRouted({
        plan,
        messages,
        provider: deps.provider,
        budget,
        breaker: deps.breaker,
        signal,
        report,
        random: deps.random,
        ...(hopTools.length > 0 ? { tools: hopTools, toolChoice: "auto" as const } : {}),
      })) {
        if (chunk.type === "finish") {
          finishReason = chunk.finishReason;
          usage = addUsage(usage, chunk.usage);
          continue;
        }
        if (chunk.type === "tool_calls") {
          calls = chunk.calls;
          continue;
        }
        const room = MAX_ASSISTANT_CHARS - content.length;
        const text = normalizeReplyText(chunk.text).slice(0, room);
        if (text) {
          content += text;
          hopText += text;
          yield { type: "delta", text };
        }
        if (content.length >= MAX_ASSISTANT_CHARS) {
          truncated = true;
          break;
        }
      }
    } catch (error) {
      logRoute(deps, logBase, turn.route, report, hop);
      if (signal.aborted) {
        deps.log("info", "chat_client_aborted", { ...logBase, stage: "completion" });
        return;
      }
      if (error instanceof BudgetExhaustedError) {
        yield { type: "error", code: "budget_exhausted", message: budgetRefusal(error.limit, deps.now()).message, retryable: false };
        return;
      }
      if (error instanceof EmptyReplyError) {
        deps.log("error", "completion_empty", { ...logBase, finishReason });
        yield {
          type: "error",
          code: "provider_unavailable",
          message: "The assistant returned an empty reply. Please retry.",
          retryable: true,
        };
        return;
      }
      const publicError = toPublicCompletionError(error);
      deps.log("error", "completion_failed", {
        ...logBase,
        kind: error instanceof ProviderError ? error.kind : "unknown",
        status: error instanceof ProviderError ? error.status : undefined,
        durationMs: Date.now() - startedAt,
      });
      yield { type: "error", ...publicError };
      return;
    }
    logRoute(deps, logBase, turn.route, report, hop);

    if (signal.aborted) {
      deps.log("info", "chat_client_aborted", { ...logBase, stage: "completion" });
      return;
    }
    if (calls.length === 0 || truncated || hopTools.length === 0) break;

    // The model asked for tools. What it said so far was its plan, not the reply.
    yield { type: "thought", text: hopText.trim() || describeCalls(calls) };
    content = "";
    messages.push({ role: "assistant", content: hopText.trim(), tool_calls: calls });
    for (const [index, call] of calls.entries()) {
      let outcome: ToolOutcome;
      if (index >= MAX_TOOL_CALLS_PER_HOP) {
        outcome = { text: "Too many tool calls in one turn; this one was not run." };
      } else {
        toolCalls += 1;
        try {
          outcome = await runTool(call);
        } catch {
          deps.log("info", "chat_client_aborted", { ...logBase, stage: "tool" });
          return;
        }
      }
      if (outcome.event) yield outcome.event;
      messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: outcome.text });
    }
  }

  const finalReport = reports.at(-1)!;
  if (content.trim().length === 0 || !finalReport.model) {
    deps.log("error", "completion_empty", { ...logBase, finishReason });
    yield {
      type: "error",
      code: "provider_unavailable",
      message: "The assistant returned an empty reply. Please retry.",
      retryable: true,
    };
    return;
  }

  // 4. Persist the completed reply with its search outcome, sources and route.
  const sources = webSearch === "used" ? toSourceRefs(webSources).slice(0, 10) : [];
  let saved: MessageDTO;
  try {
    saved = await deps.repo.insertMessage(turn.userId, {
      conversationId: turn.conversation.id,
      role: "assistant",
      content,
      webSearch,
      sources,
      route: {
        model: finalReport.model,
        tier: plan.tier,
        reason: turn.route.reason,
        fallback: reports.some((report) => report.fallback),
      },
    });
  } catch {
    deps.log("error", "assistant_message_save_failed", logBase);
    yield {
      type: "error",
      code: "internal_error",
      message: "The reply could not be saved. Please retry.",
      retryable: true,
    };
    return;
  }

  if (deps.contextRecords) {
    const validUsage = usage && isValidUsage(usage) ? usage : null;
    const record = deps.contextRecords
      .insertContextRecord(turn.userId, {
        messageId: saved.id,
        model: finalReport.model,
        historyMessageCount: historyWindow.length,
        historyChars: historyWindow.reduce((sum, m) => sum + m.content.length, 0),
        memoryIds: limitIds([...usedMemoryIds]),
        documentChunkIds: limitIds([...usedChunkIds]),
        webSourceCount: sources.length,
        promptVersion: PROMPT_VERSION,
        inputTokens: validUsage?.promptTokens ?? null,
        outputTokens: validUsage?.completionTokens ?? null,
      })
      .catch(() => deps.log("warn", "context_record_failed", logBase));
    deps.waitUntil(record);
  }

  // 5. A first exchange names the conversation (one short fast-tier call, with its own hold).
  if (deps.smartTitles && turn.history.length === 1 && !signal.aborted) {
    try {
      const completion = await completeText(deps, {
        requestId: turn.requestId,
        plan: deps.routing.fast,
        messages: [
          { role: "system", content: SMART_TITLE_SYSTEM_PROMPT },
          { role: "user", content: turn.userMessage.content.slice(0, 1000) },
        ],
        signal,
        maxChars: 200,
      });
      const title = smartTitleFromText(completion.text);
      if (title && title !== turn.conversation.title) {
        const renamed = await deps.repo.renameConversation(turn.userId, turn.conversation.id, title);
        if (renamed) yield { type: "title", title };
      }
    } catch (error) {
      if (signal.aborted) return;
      deps.log("warn", "smart_title_failed", { ...logBase, errorName: error instanceof Error ? error.name : "unknown" });
    }
  }

  deps.log("info", "chat_completed", {
    ...logBase,
    durationMs: Date.now() - startedAt,
    webSearch,
    sourceCount: sources.length,
    finishReason,
    model: finalReport.model,
    tier: plan.tier,
    hops: reports.length,
    toolCalls,
    memoriesUsed: usedMemoryIds.size,
    documentChunksUsed: usedChunkIds.size,
    promptTokens: usage?.promptTokens,
    completionTokens: usage?.completionTokens,
  });
  yield { type: "done", message: saved, truncated: truncated || finishReason === "length" };
}

/** One metadata-only log line for each routed call. No prompt or reply text. */
function logRoute(
  deps: AssistantDeps,
  logBase: { requestId: string; route: string },
  route: RouteDecision,
  report: RouteReport,
  hop: number,
): void {
  deps.log(report.outcome === "ok" || report.outcome === "stopped" ? "info" : "warn", "model_route", {
    ...logBase,
    hop,
    tier: report.tier,
    reason: route.reason,
    modelsTried: report.modelsTried.join(">"),
    attempts: report.attempts,
    hedgeFired: report.hedgeFired,
    hedgeWon: report.hedgeWon,
    breakerSkips: report.breakerSkips,
    model: report.model,
    fallback: report.fallback,
    firstTokenMs: report.firstTokenMs,
    totalMs: report.totalMs,
    outcome: report.outcome,
  });
}
