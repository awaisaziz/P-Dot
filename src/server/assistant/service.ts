import "server-only";
import { z } from "zod";
import {
  HISTORY_CHAR_BUDGET,
  HISTORY_MESSAGE_LIMIT,
  MAX_ASSISTANT_CHARS,
  MAX_MEMORY_CHARS,
  RETRIEVAL_MATCH_COUNT,
} from "@/lib/limits";
import { WORKSPACE_MODE } from "@/lib/mode";
import { actionPayloadSchema } from "@/lib/schemas";
import type {
  ActionPayload,
  ApiErrorCode,
  ChatRequest,
  ChatStreamEvent,
  ConversationSummary,
  MessageDTO,
  SourceRef,
  WebSearchStatus,
} from "@/types/api";
import type { FlightResult, MessageResult, MessageResultsPayload, ResearchResult, WorkflowStep } from "@/types/workflows";
import type { GoogleConnector } from "@/server/connectors/google/connector";
import type { ActionProposalRepository } from "@/server/db/action-proposals";
import { limitIds, type ContextRecordRepository } from "@/server/db/context-records";
import type { ConversationRepository } from "@/server/db/conversations";
import type { MemoryRepository } from "@/server/db/memories";
import { fitResultsPayload, MESSAGE_RESULTS_MAX_BYTES, type MessageResultsRepository } from "@/server/db/message-results";
import type { QuotaGate } from "@/server/db/quota";
import type { RetrievalRepository } from "@/server/db/retrieval";
import type { SpendGuard } from "@/server/db/spend";
import type { Logger } from "@/server/log";
import { ProviderError } from "@/server/providers/errors";
import { isValidUsage } from "@/server/providers/nebius/pricing";
import type { ChatMessage, ModelProvider, TokenUsage } from "@/server/providers/model";
import type { WebSearchResult } from "@/server/providers/tavily/client";
import type { CircuitBreaker } from "./breaker";
import { attemptBudget, completeText, extractionPlan, settleQuietly, type NebiusHold } from "./complete";
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
  CONNECTOR_RESULT_MAX_BYTES,
  DOCUMENT_RESULTS_MAX_BYTES,
  MEMORY_RESULTS_MAX_BYTES,
  nebiusHoldMicroUsd,
  NebiusHoldTooLargeError,
  nextHopFits,
  SEARCH_BUDGET_MESSAGE,
  SEARCH_RESULTS_MAX_BYTES,
  TAVILY_BASIC_SEARCH_CREDITS,
  WORKFLOW_RESULT_MAX_BYTES,
} from "./spend";
import type { RoutingConfig } from "./tiers";
import {
  CALENDAR_LIST_EVENTS_TOOL,
  CONNECTOR_TOOL_NAMES,
  DRIVE_READ_FILE_TOOL,
  DRIVE_SEARCH_FILES_TOOL,
  MAX_TOOL_CALLS_PER_HOP,
  MAX_TOOL_HOPS,
  PROPOSE_REMINDER_TOOL,
  PROPOSE_TASK_TOOL,
  SAVE_MEMORY_TOOL,
  SEARCH_DOCUMENTS_TOOL,
  SEARCH_FLIGHTS_TOOL,
  SEARCH_MEMORIES_TOOL,
  TOOLS_MAX_BYTES,
  VERIFIED_RESEARCH_TOOL,
  WEB_EGRESS_TOOL_NAMES,
  WEB_SEARCH_TOOL,
  WORKFLOW_TOOL_NAMES,
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
import { WorkflowAbortedError, type WorkflowContext, type WorkflowTavily } from "./workflows/core";
import { safeTimeZone } from "./workflows/dates";
import { runFlightSearch } from "./workflows/flights";
import { detectFlightIntent } from "./workflows/intent";
import { parseFlightRequest, type FlightRequest } from "./workflows/request";
import { runVerifiedResearch } from "./workflows/research";
import { checkReplyClaims, hasMoneyMention, normalizeForMatch, replyClockTimes } from "./workflows/verify";

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
  /** Tavily for the grounded workflows (decision 0015). Missing or null: no workflow tools. */
  workflowTavily?: WorkflowTavily | null;
  /** Stores each reply's results and steps (table message_results). Optional; a failed write only logs. */
  messageResults?: MessageResultsRepository;
  /**
   * The Google connector for this request, built on first use (decision 0016).
   * Null when connectors are off. Used only while the message's Google chip is on.
   */
  connector?: () => GoogleConnector | null;
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
  /** The user's IANA time zone after checking; UTC when missing or unknown. */
  timeZone: string;
  /** The composer's Google chip for this message (decision 0011 amendment). Off unless the request says on. */
  googleChip: boolean;
  /** A flight search: the search toggle is skipped, so only verified fares reach the answer (decision 0015). */
  flightIntent: boolean;
  /**
   * The trip read from the user's own words when the message names both
   * places and a departure date. The service then runs the flight check
   * itself before the first model call. Null otherwise.
   */
  flightRequest: FlightRequest | null;
  /**
   * The client reads step and result events and honours done.autoActions. Only
   * the new chat screen sends timeZone or connectors; an older tab throws on
   * event types it does not know, so it gets neither.
   */
  streamSteps: boolean;
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

/** Every connector tool, for the hold made before the grant is read. */
const CONNECTOR_TOOLS: ToolDefinition[] = [CALENDAR_LIST_EVENTS_TOOL, DRIVE_SEARCH_FILES_TOOL, DRIVE_READ_FILE_TOOL];

/**
 * Bytes the code-run flight check adds before the first model call: its
 * result at the cap, plus the assistant turn that carries the call (places
 * of at most 80 characters, dates and the passenger count).
 */
const FLIGHT_CHECK_MAX_BYTES = WORKFLOW_RESULT_MAX_BYTES + 2_048;
const FLIGHT_CHECK_CALL_ID = "call_pdot_flight_check";

/** The byte bound of each built-in tool result that can be large, for the room check before it runs. */
const RESULT_MAX_BYTES: Partial<Record<string, number>> = {
  web_search: SEARCH_RESULTS_MAX_BYTES,
  search_documents: DOCUMENT_RESULTS_MAX_BYTES,
  search_memories: MEMORY_RESULTS_MAX_BYTES,
};

/** The failed step when a flight request ends without a flight check and the reply names a price or a time. */
export const NOT_VERIFIED_STEP: WorkflowStep = {
  id: "flights.unverified",
  label: "Not verified: no travel page was read for this reply",
  status: "failed",
};

const ONE_WORKFLOW_TEXT = "Already ran a search for this reply; answer with what you have.";
const NO_ROOM_TEXT = "Not run: this reply has no room for more results.";
const TAINTED_TEXT =
  "Not run: this reply already read outside results, so it cannot search or read accounts again. Answer with what you have.";
const CHIP_OFF_TEXT = "Not run: Google is off for this message. Answer without it; the user can turn Google on in the composer.";
const TAINTED_PROPOSAL_TEXT =
  "Not run: this reply read outside results, so it cannot propose a task or reminder. Tell the user they can ask for it in a new message.";

function isProposalTool(name: string): boolean {
  return name === "propose_task" || name === "propose_reminder";
}

function isWorkflowTool(name: string): name is (typeof WORKFLOW_TOOL_NAMES)[number] {
  return (WORKFLOW_TOOL_NAMES as readonly string[]).includes(name);
}

function isConnectorTool(name: string): name is (typeof CONNECTOR_TOOL_NAMES)[number] {
  return (CONNECTOR_TOOL_NAMES as readonly string[]).includes(name);
}

function isWebEgressTool(name: string): boolean {
  return (WEB_EGRESS_TOOL_NAMES as readonly string[]).includes(name);
}

/** The tools the model may call, given what is wired. Connector tools are added per turn. */
export function availableTools(deps: AssistantDeps): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  if (deps.search) tools.push(WEB_SEARCH_TOOL);
  if (deps.retrieval && deps.embedder) tools.push(SEARCH_DOCUMENTS_TOOL, SEARCH_MEMORIES_TOOL);
  if (deps.memories) tools.push(SAVE_MEMORY_TOOL);
  if (deps.actionProposals) tools.push(PROPOSE_TASK_TOOL, PROPOSE_REMINDER_TOOL);
  if (deps.workflowTavily) tools.push(SEARCH_FLIGHTS_TOOL, VERIFIED_RESEARCH_TOOL);
  return tools;
}

/** Bytes that search results, tools and memories can add to the first prompt. */
function extraPromptBytes(deps: AssistantDeps, searchWanted: boolean, toolsOffered: boolean): number {
  let bytes = searchWanted ? SEARCH_RESULTS_MAX_BYTES : 0;
  if (toolsOffered) bytes += TOOLS_MAX_BYTES;
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
  const pendingHistory: HistoryMessage[] = recent.map(({ role, content }) => ({ role, content }));
  if (request.action === "send") pendingHistory.push({ role: "user", content: request.message });
  const latest = pendingHistory.at(-1)?.content ?? "";
  const tools = availableTools(deps);
  // A flight search skips the toggle search, so unverified excerpts never reach the answer.
  const flightIntent = tools.includes(SEARCH_FLIGHTS_TOOL) && detectFlightIntent(latest);
  const googleChip = request.connectors?.google === true;
  const timeZone = safeTimeZone(request.timeZone);
  // A clear request is checked by code before the model runs; a vague one is left to the model, which must ask.
  const flightRequest = flightIntent ? parseFlightRequest(latest, deps.now(), timeZone) : null;
  const searchWanted = request.webSearch && deps.search !== null && !flightIntent;
  // The grant is read after the stream starts, so hold as if every connector tool were offered.
  const boundTools = googleChip && deps.connector ? [...tools, ...CONNECTOR_TOOLS] : tools;
  const route = routeRequest({
    message: latest,
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
    tools: boundTools,
    toolHops: MAX_TOOL_HOPS - 1,
    timeZone,
  });
  // The first attempt can run on any model of the tier (the breaker can skip
  // the first one), so hold for the most expensive one.
  let heldMicroUsd: number;
  try {
    heldMicroUsd = Math.max(
      ...plan.models.map((model) =>
        nebiusHoldMicroUsd(
          model,
          promptBound,
          plan.maxOutputTokens,
          extraPromptBytes(deps, searchWanted, boundTools.length > 0) + (flightRequest ? FLIGHT_CHECK_MAX_BYTES : 0),
        ),
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
        existing ?? (await deps.repo.createConversation(userId, titleFromMessage(request.message), WORKSPACE_MODE));
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
        timeZone,
        googleChip,
        flightIntent,
        flightRequest,
        streamSteps: request.timeZone !== undefined || request.connectors !== undefined,
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

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
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
    for await (const event of runChatTurn(deps, turn, signal, holds, settle)) {
      // An older tab fails on event types it does not know; the steps are still saved.
      if (!turn.streamSteps && (event.type === "step" || event.type === "result")) continue;
      yield event;
    }
  } finally {
    // No attempt used the first hold (for example Stop during search): no call was made.
    if (holds.prepaid) settle(holds.prepaid, 0);
    await Promise.all(settles);
  }
}

/** What one tool call produced: the text the model gets back. Events are yielded while it runs. */
interface ToolOutcome {
  text: string;
}

/** Where a tool call runs: its hop, its place in the hop, and the tools that hop offered. */
interface ToolSlot {
  hop: number;
  index: number;
  offered: ReadonlySet<string>;
}

/** What a workflow returns, for both search_flights and verified_research. */
interface WorkflowOutcome {
  toolText: string;
  sources: SourceRef[];
  result: MessageResult | null;
  summaryLine: string | null;
  creditsUsed: number;
}

/** A short status line when the model called a tool without saying why. */
function describeCalls(calls: ToolCall[]): string {
  const names = calls.map((call) => call.function.name);
  if (names.includes("search_flights")) return "Searching for flights…";
  if (names.includes("verified_research")) return "Researching on the web…";
  if (names.includes("calendar_list_events")) return "Reading your calendar…";
  if (names.includes("drive_search_files") || names.includes("drive_read_file")) return "Looking in your Drive…";
  if (names.includes("web_search")) return "Searching the web…";
  if (names.includes("search_documents")) return "Searching your documents…";
  if (names.includes("search_memories")) return "Checking what you asked P-Dot to remember…";
  if (names.includes("save_memory")) return "Suggesting something to remember…";
  if (names.includes("propose_task") || names.includes("propose_reminder")) return "Preparing a suggestion to approve…";
  return "Working…";
}

/** Step lines for the built-in tools when they fail. Counts and fixed words only, never model or page text. */
const FAILED_LABELS: Partial<Record<string, string>> = {
  web_search: "Web search failed",
  search_documents: "Could not search your documents",
  search_memories: "Could not check your memories",
  save_memory: "Could not suggest a memory",
  propose_task: "Could not propose a task",
  propose_reminder: "Could not propose a reminder",
};

/** The running line before a connector read; the connector's own step replaces it (same ID). */
const CONNECTOR_RUNNING_LABELS: Record<(typeof CONNECTOR_TOOL_NAMES)[number], string> = {
  calendar_list_events: "Reading your calendar",
  drive_search_files: "Searching your Drive",
  drive_read_file: "Reading a file from Drive",
};

/** The connector's step ID for a call (src/server/connectors/google/connector.ts uses the same rule). */
function connectorStepId(call: ToolCall): string {
  return `google-${call.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "call"}`;
}

function addUsage(total: TokenUsage | null | undefined, next: TokenUsage | null): TokenUsage | null {
  if (total === null || next === null || !isValidUsage(next)) return null;
  if (total === undefined) return next;
  return { promptTokens: total.promptTokens + next.promptTokens, completionTokens: total.completionTokens + next.completionTokens };
}

/**
 * Clock times (minutes after midnight) of the calendar events and Drive files
 * read in this reply, as written and in the user's zone. Times only, never amounts.
 */
function accountClockMinutes(results: MessageResult[], timeZone: string): Set<number> {
  const stamps: string[] = [];
  for (const result of results) {
    if (result.kind === "calendar") {
      for (const event of result.events) if (!event.allDay) stamps.push(event.start, event.end);
    } else if (result.kind === "drive") {
      for (const file of result.files) if (file.modified) stamps.push(file.modified);
    }
  }
  const minutes = new Set<number>();
  if (stamps.length === 0) return minutes;
  let local: Intl.DateTimeFormat | null;
  try {
    local = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  } catch {
    local = null;
  }
  for (const stamp of stamps) {
    const written = /T([01][0-9]|2[0-3]):([0-5][0-9])/.exec(stamp);
    if (written) minutes.add(Number(written[1]) * 60 + Number(written[2]));
    const at = Date.parse(stamp);
    if (!local || !Number.isFinite(at)) continue;
    const parts = local.formatToParts(new Date(at));
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    if (Number.isInteger(hour) && Number.isInteger(minute)) minutes.add((hour % 24) * 60 + minute);
  }
  return minutes;
}

const rawArgsSchema = z.unknown();

async function* runChatTurn(
  deps: AssistantDeps,
  turn: PreparedTurn,
  signal: AbortSignal,
  holds: { prepaid: NebiusHold | null },
  settle: (hold: NebiusHold, amount: number) => void,
): AsyncGenerator<ChatStreamEvent> {
  const startedAt = Date.now();
  const logBase = { requestId: turn.requestId, route: "chat" };

  // Every step of the turn, latest status per ID, and every verified result (decision 0015).
  const steps = new Map<string, WorkflowStep>();
  const results: MessageResult[] = [];
  const stepEvent = (step: WorkflowStep): ChatStreamEvent => {
    steps.set(step.id, step);
    return { type: "step", step };
  };

  yield {
    type: "start",
    requestId: turn.requestId,
    conversation: turn.conversation,
    userMessage: turn.userMessage,
    route: turn.route,
  };

  // 0. Google tools, only while the chip is on and the grant is active (decision 0011 amendment).
  let connector: GoogleConnector | null = null;
  let connectorTools: ToolDefinition[] = [];
  if (turn.googleChip && deps.connector) {
    try {
      connector = deps.connector();
    } catch {
      deps.log("warn", "connector_unavailable", { ...logBase, provider: "google" });
      connector = null;
    }
    if (connector) {
      const grant = await connector.grant();
      connectorTools = connector.toolsFor(grant);
      if (grant?.status === "needs_reconnect") {
        yield stepEvent({ id: "google.grant", label: "Google needs reconnecting", status: "failed" });
      }
    }
  }

  // 1. Optional web retrieval. Search is never called unless requested, and a
  //    flight search skips it: only the workflow's verified fares may reach the answer.
  let webSearch: WebSearchStatus = "off";
  let toggleResults: WebSearchResult[] = [];
  if (turn.webSearch && !turn.flightIntent) {
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
        toggleResults = await deps.search(turn.userMessage.content, signal);
        webSearch = toggleResults.length > 0 ? "used" : "no_results";
        yield {
          type: "search",
          status: webSearch,
          sources: toSourceRefs(toggleResults),
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
        toggleResults = [];
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
  //    Retrieval passes a null mode: one workspace searches every row (decision 0014).
  const usedMemoryIds = new Set<string>();
  const usedChunkIds = new Set<string>();
  let memories: MemoryExcerpt[] = [];
  if (deps.retrieval && deps.embedder) {
    try {
      const [vector] = await deps.embedder.embed([turn.userMessage.content], signal);
      if (vector) {
        const matches = await deps.retrieval.matchMemories(vector, null, RETRIEVAL_MATCH_COUNT);
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
  const tools = [...availableTools(deps), ...connectorTools];
  const historyWindow = buildContextWindow(turn.history, HISTORY_CHAR_BUDGET);
  const messages: ChatMessage[] = buildPromptMessages({
    history: historyWindow,
    webSearch,
    results: toggleResults,
    now: deps.now(),
    memories,
    tools,
    toolHops: MAX_TOOL_HOPS - 1,
    timeZone: turn.timeZone,
  });
  const plan = deps.routing[turn.route.tier];
  const webSources: WebSearchResult[] = [...toggleResults];
  const seenUrls = new Set(toggleResults.map((result) => result.url));
  // The user's latest message and the one before it: the only words a flight
  // check may take its trip from. Each is read on its own, so a long earlier
  // message never pushes the latest one out.
  const previousUser = [...turn.history.slice(0, -1)].reverse().find((message) => message.role === "user")?.content ?? "";
  const userMessages = [turn.userMessage.content, previousUser].filter(Boolean);

  // Decision 0015: one workflow per reply, and once outside results came back
  // (a workflow or a connector read) the reply is tainted: no web search, flight
  // check or research, and Auto runs nothing for it. A connector read may follow
  // a connector read (it sends nothing outside Google and P-Dot), but not a
  // workflow result: web content never drives an account read.
  let workflowRan = false;
  let tainted = false;
  /** A workflow brought web content into this reply. */
  let readWeb = false;
  let workflowCalls = 0;
  let connectorCalls = 0;
  /** The workflow's code-built summary, the first line of the saved reply. */
  let summaryPrefix = "";

  // An older tab approves proposals in Auto without reading done.autoActions,
  // so a tainted reply proposes nothing there (stopgap until old tabs are gone).
  const proposalsBlocked = () => tainted && !turn.streamSteps;
  /** Tools a tainted reply may no longer call. */
  const blockedByTaint = (name: string) => (tainted && isWebEgressTool(name)) || (readWeb && isConnectorTool(name));

  /** Tool bytes the hop after `hop` can add, for the room check. */
  const nextHopToolBytes = (hop: number) => (hop + 1 < MAX_TOOL_HOPS - 1 ? TOOLS_MAX_BYTES : 0);
  const hasRoom = (hop: number, resultBytes: number) =>
    nextHopFits(plan.models, messages, plan.maxOutputTokens, nextHopToolBytes(hop) + resultBytes);
  /** The step ID of a tool call; the code-run flight check comes before hop 0. */
  const toolStepId = (slot: ToolSlot) => (slot.hop < 0 ? "flights.request" : `tool-${slot.hop}-${slot.index}`);

  /** A failed room check: the next hop would not fit under the hold ceiling, so the tool does not run. */
  function* noRoom(name: string, stepId: string): Generator<ChatStreamEvent, ToolOutcome> {
    deps.log("warn", "tool_not_run", { ...logBase, tool: name, reason: "no_room" });
    yield stepEvent({ id: stepId, label: "Not run: no room for more results in this reply", status: "failed" });
    return { text: NO_ROOM_TEXT };
  }

  /** A refused call: the reason goes back to the model, never to Tavily or Google. */
  function* refuse(name: string, stepId: string): Generator<ChatStreamEvent, ToolOutcome> {
    if (isWorkflowTool(name) && workflowRan) {
      yield stepEvent({ id: stepId, label: "Skipped a second search for this reply", status: "failed" });
      return { text: ONE_WORKFLOW_TEXT };
    }
    if (isConnectorTool(name) && !turn.googleChip) {
      yield stepEvent({ id: stepId, label: "Google is off for this message", status: "failed" });
      return { text: CHIP_OFF_TEXT };
    }
    if (blockedByTaint(name)) return { text: TAINTED_TEXT };
    if (isProposalTool(name) && proposalsBlocked()) {
      yield stepEvent({ id: stepId, label: "Skipped a proposal after reading outside results", status: "failed" });
      return { text: TAINTED_PROPOSAL_TEXT };
    }
    return { text: `The tool "${name}" is not available. Answer without it.` };
  }

  /** Runs search_flights or verified_research, streaming its steps. */
  async function* runWorkflow(call: ToolCall, slot: ToolSlot): AsyncGenerator<ChatStreamEvent, ToolOutcome> {
    const name = call.function.name;
    const stepId = toolStepId(slot);
    if (workflowRan || !slot.offered.has(name) || !deps.workflowTavily) return yield* refuse(name, stepId);
    if (!hasRoom(slot.hop, WORKFLOW_RESULT_MAX_BYTES)) return yield* noRoom(name, stepId);
    const args = parseToolArgs(call, rawArgsSchema);
    if (!args.ok) return { text: args.message };

    // Pages the reply already lists are not read again, so each page keeps one number.
    const tavily = deps.workflowTavily;
    const unseenTavily: WorkflowTavily = {
      search: async (query, options) => (await tavily.search(query, options)).filter((result) => !seenUrls.has(result.url)),
      extract: (urls, options) => tavily.extract(urls, options),
    };
    const ctx: WorkflowContext = {
      requestId: turn.requestId,
      signal,
      now: deps.now(),
      timeZone: turn.timeZone,
      spend: deps.spend,
      provider: deps.provider,
      breaker: deps.breaker,
      random: deps.random,
      log: deps.log,
      waitUntil: deps.waitUntil,
      extractionPlan: extractionPlan(deps.routing),
      tavily: unseenTavily,
      // The workflow numbers its pages after the reply's earlier sources; a reply keeps at most 10.
      firstSourceIndex: webSources.length + 1,
      maxSources: 10 - webSources.length,
      // search_flights runs only for places and a date the user named.
      userMessages,
    };
    const run: AsyncGenerator<WorkflowStep, WorkflowOutcome> =
      name === "search_flights" ? runFlightSearch(ctx, args.value) : runVerifiedResearch(ctx, args.value);
    let outcome: WorkflowOutcome;
    try {
      for (;;) {
        const next = await run.next();
        if (next.done) {
          outcome = next.value;
          break;
        }
        yield stepEvent(next.value);
      }
    } catch (error) {
      // Credits may have been sent before an unexpected failure: no second workflow in this reply.
      if (!signal.aborted && !(error instanceof WorkflowAbortedError)) workflowRan = true;
      throw error;
    }
    // Invalid arguments or a question back to the user read nothing, so the model may call again.
    const ran = outcome.creditsUsed > 0 || outcome.sources.length > 0 || outcome.result !== null;
    if (ran) {
      workflowRan = true;
      tainted = true;
      readWeb = true;
      workflowCalls += 1;
    }
    deps.log("info", "workflow_tool", {
      ...logBase,
      tool: name,
      ran,
      credits: outcome.creditsUsed,
      sources: outcome.sources.length,
      hasResult: outcome.result !== null,
    });

    if (outcome.sources.length > 0) {
      // Kept in the workflow's own numbering, so its [n] match the saved sources.
      webSources.push(...outcome.sources.map(({ title, url }) => ({ title, url, excerpt: "" })));
      for (const source of outcome.sources) seenUrls.add(source.url);
      webSearch = "used";
      yield { type: "search", status: "used", sources: toSourceRefs(webSources) };
    }
    if (outcome.result) {
      results.push(outcome.result);
      yield { type: "result", result: outcome.result };
    }
    if (outcome.summaryLine) summaryPrefix = `${outcome.summaryLine}\n\n`;
    return { text: outcome.toolText };
  }

  /** Runs one Google read. The connector never throws; its outcome is the tool message, step and result. */
  async function* runConnector(call: ToolCall, slot: ToolSlot): AsyncGenerator<ChatStreamEvent, ToolOutcome> {
    const name = call.function.name as (typeof CONNECTOR_TOOL_NAMES)[number];
    const stepId = connectorStepId(call);
    if (!connector || !slot.offered.has(name)) return yield* refuse(name, stepId);
    if (!hasRoom(slot.hop, CONNECTOR_RESULT_MAX_BYTES)) return yield* noRoom(name, stepId);
    tainted = true;
    connectorCalls += 1;
    yield stepEvent({ id: stepId, label: CONNECTOR_RUNNING_LABELS[name], status: "running" });
    const outcome = await connector.run(call, signal);
    if (signal.aborted) throw new WorkflowAbortedError();
    yield stepEvent(outcome.step);
    if (outcome.result) {
      results.push(outcome.result);
      yield { type: "result", result: outcome.result };
    }
    return { text: outcome.text };
  }

  /** Runs one tool call, yielding its events. Never throws except when the client aborted. */
  async function* runTool(call: ToolCall, slot: ToolSlot): AsyncGenerator<ChatStreamEvent, ToolOutcome> {
    const name = call.function.name;
    const stepId = toolStepId(slot);
    try {
      if (isWorkflowTool(name)) return yield* runWorkflow(call, slot);
      if (isConnectorTool(name)) return yield* runConnector(call, slot);
      // Only the tools this hop offered may run (a tainted reply offers no web search).
      if (!slot.offered.has(name) || (isProposalTool(name) && proposalsBlocked())) return yield* refuse(name, stepId);
      // Every tool with a large result checks first that the next hop still fits under the hold ceiling.
      const resultBound = RESULT_MAX_BYTES[name];
      if (resultBound !== undefined && !hasRoom(slot.hop, resultBound)) return yield* noRoom(name, stepId);
      if (name === "web_search" && deps.search) {
        const args = parseToolArgs(call, webSearchArgsSchema);
        if (!args.ok) return { text: args.message };
        const credit = await deps.spend.reserve("tavily", TAVILY_BASIC_SEARCH_CREDITS);
        if (!credit.allowed) {
          deps.log("warn", "spend_limit_reached", { ...logBase, provider: "tavily", limit: credit.limit, stage: "tool" });
          yield stepEvent({ id: stepId, label: "Search limit reached", status: "failed" });
          return {
            text: "Web search is not available right now (search limit reached). Answer from what you know and say the answer is not based on a web search.",
          };
        }
        yield stepEvent({ id: stepId, label: "Searching the web", status: "running" });
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
          yield { type: "search", status: "failed", sources: toSourceRefs(webSources), message: publicSearchFailureMessage(error) };
          yield stepEvent({ id: stepId, label: "Web search failed", status: "failed" });
          return { text: "Web search failed. Answer from what you know and say the answer is not based on a web search." };
        }
        const fresh = found.filter((result) => !seenUrls.has(result.url));
        for (const result of fresh) seenUrls.add(result.url);
        const startIndex = webSources.length + 1;
        webSources.push(...fresh);
        if (webSources.length > 0) webSearch = "used";
        else if (webSearch !== "failed") webSearch = "no_results";
        yield {
          type: "search",
          status: webSources.length > 0 ? "used" : "no_results",
          sources: toSourceRefs(webSources),
          ...(webSources.length === 0 ? { message: "Web search found no usable results." } : {}),
        };
        yield stepEvent({ id: stepId, label: `Searched the web · ${count(found.length, "result", "results")}`, status: "done" });
        return {
          text: found.length > 0 ? formatSearchResults(fresh.length > 0 ? fresh : found, startIndex) : "No web results found for that query.",
        };
      }
      if (name === "search_documents" && deps.retrieval && deps.embedder) {
        const args = parseToolArgs(call, searchDocumentsArgsSchema);
        if (!args.ok) return { text: args.message };
        const [vector] = await deps.embedder.embed([args.value.query], signal);
        if (!vector) {
          yield stepEvent({ id: stepId, label: "Could not search your documents", status: "failed" });
          return { text: "Document search is not available right now." };
        }
        const matches = await deps.retrieval.matchDocumentChunks(vector, null, RETRIEVAL_MATCH_COUNT);
        for (const match of matches) usedChunkIds.add(match.id);
        yield stepEvent({ id: stepId, label: `Searched your documents · ${count(matches.length, "match", "matches")}`, status: "done" });
        if (matches.length === 0) return { text: "No matching text in the user's documents." };
        return { text: formatDocumentResults(matches.map(({ title, content }) => ({ title, content })), webSources.length + 1) };
      }
      if (name === "search_memories" && deps.retrieval && deps.embedder) {
        const args = parseToolArgs(call, searchMemoriesArgsSchema);
        if (!args.ok) return { text: args.message };
        const [vector] = await deps.embedder.embed([args.value.query], signal);
        if (!vector) {
          yield stepEvent({ id: stepId, label: "Could not check your memories", status: "failed" });
          return { text: "Memory search is not available right now." };
        }
        const matches = await deps.retrieval.matchMemories(vector, null, RETRIEVAL_MATCH_COUNT);
        for (const match of matches) usedMemoryIds.add(match.id);
        yield stepEvent({ id: stepId, label: `Checked your memories · ${count(matches.length, "match", "matches")}`, status: "done" });
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
          {
            mode: WORKSPACE_MODE,
            content: args.value.content,
            status: "proposed",
            source: "assistant",
            sourceMessageId: turn.userMessage.id,
          },
          vector,
        );
        yield stepEvent({ id: stepId, label: "Suggested something to remember", status: "done" });
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
          payload = { kind: "create_task", mode: WORKSPACE_MODE, title: args.value.title };
          summary = `Add task: ${args.value.title}`;
        } else {
          const args = parseToolArgs(call, proposeReminderArgsSchema);
          if (!args.ok) return { text: args.message };
          payload = { kind: "create_reminder", mode: WORKSPACE_MODE, title: args.value.title, dueAt: args.value.due_at };
          summary = `Remind: ${args.value.title}`;
        }
        const valid = actionPayloadSchema.safeParse(payload);
        if (!valid.success) return { text: `Invalid proposal: ${valid.error.issues[0]?.message ?? "check the arguments"}.` };
        await deps.actionProposals.createProposal(turn.userId, { conversationId: turn.conversation.id, payload: valid.data, summary });
        yield stepEvent({
          id: stepId,
          label: name === "propose_task" ? "Proposed a task for you to approve" : "Proposed a reminder for you to approve",
          status: "done",
        });
        return {
          text: `Proposed to the user as a card to approve: "${summary}". Tell them it waits for their approval; do not say it is done.`,
        };
      }
      return { text: `The tool "${name}" is not available. Answer without it.` };
    } catch (error) {
      if (signal.aborted || error instanceof WorkflowAbortedError) throw error;
      deps.log("warn", "tool_failed", { ...logBase, tool: name, errorName: error instanceof Error ? error.name : "unknown" });
      yield stepEvent({ id: stepId, label: FAILED_LABELS[name] ?? "A tool could not run", status: "failed" });
      if (error instanceof EmbeddingBudgetError) return { text: "That tool is not available right now (usage limit). Answer without it." };
      return { text: "That tool is temporarily unavailable. Answer without it." };
    }
  }

  const reports: RouteReport[] = [];
  let content = "";
  let prefixChars = 0;
  let truncated = false;
  let finishReason: string | null = null;
  let usage: TokenUsage | null | undefined = undefined;
  let toolCalls = 0;

  // A clear flight request is checked by code before the first model call, as a tool call the
  // model did not make: a model that ignores a forced tool call cannot skip it, and one that
  // gets a vague request cannot fill in a trip. The model then only writes the answer.
  if (turn.flightRequest) {
    const call: ToolCall = {
      id: FLIGHT_CHECK_CALL_ID,
      type: "function",
      function: { name: "search_flights", arguments: JSON.stringify(turn.flightRequest) },
    };
    yield { type: "thought", text: describeCalls([call]) };
    messages.push({ role: "assistant", content: "", tool_calls: [call] });
    toolCalls += 1;
    let outcome: ToolOutcome;
    try {
      outcome = yield* runTool(call, { hop: -1, index: 0, offered: new Set(["search_flights"]) });
    } catch {
      deps.log("info", "chat_client_aborted", { ...logBase, stage: "tool" });
      return;
    }
    messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: outcome.text });
    // The reply's one workflow: the model answers with what it returned.
    workflowRan = true;
  }

  for (let hop = 0; ; hop += 1) {
    // No workflow after a workflow, and no web or account read the taint rules block.
    const hopTools =
      hop < MAX_TOOL_HOPS - 1
        ? tools.filter(
            ({ function: { name } }) =>
              !(workflowRan && isWorkflowTool(name)) && !blockedByTaint(name) && !(isProposalTool(name) && proposalsBlocked()),
          )
        : [];
    const offered = new Set(hopTools.map((tool) => tool.function.name));
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
    // After a workflow, its code-built summary is the first line of the reply.
    content = summaryPrefix;
    prefixChars = summaryPrefix.length;
    if (summaryPrefix) yield { type: "delta", text: summaryPrefix };
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
    messages.push({ role: "assistant", content: hopText.trim(), tool_calls: calls });
    for (const [index, call] of calls.entries()) {
      let outcome: ToolOutcome;
      if (index >= MAX_TOOL_CALLS_PER_HOP) {
        outcome = { text: "Too many tool calls in one turn; this one was not run." };
      } else {
        toolCalls += 1;
        try {
          outcome = yield* runTool(call, { hop, index, offered });
        } catch {
          deps.log("info", "chat_client_aborted", { ...logBase, stage: "tool" });
          return;
        }
      }
      messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: outcome.text });
    }
  }

  const finalReport = reports.at(-1)!;
  if (content.slice(prefixChars).trim().length === 0 || !finalReport.model) {
    deps.log("error", "completion_empty", { ...logBase, finishReason });
    yield {
      type: "error",
      code: "provider_unavailable",
      message: "The assistant returned an empty reply. Please retry.",
      retryable: true,
    };
    return;
  }

  // Code checks the reply too: amounts and times the verified results do not have (decision 0015).
  // Times read from the user's calendar or Drive in this reply are known, not unverified.
  const accountTimes = accountClockMinutes(results, turn.timeZone);
  const unverified = (result: FlightResult | ResearchResult) =>
    checkReplyClaims(content, result).filter((mention) => {
      const times = replyClockTimes(normalizeForMatch(mention));
      return !(times.length > 0 && times.every((time) => accountTimes.has(time.minutes)));
    });
  let researchUnverified = 0;
  const finalResults: MessageResult[] = results.map((result) => {
    if (result.kind === "flights") return { ...result, unverifiedMentions: unverified(result) };
    if (result.kind === "research") {
      const mentions = unverified(result);
      researchUnverified += mentions.length;
      return { ...result, unverifiedMentions: mentions };
    }
    return result;
  });

  // A flight request that ended without a flight check (the model answered in text, or the check
  // was refused) cannot have verified fares: a price or a time in the reply is marked.
  if (turn.flightIntent && !results.some((result) => result.kind === "flights")) {
    const own = normalizeForMatch(content.slice(prefixChars));
    if (hasMoneyMention(own) || replyClockTimes(own).some((time) => !accountTimes.has(time.minutes))) {
      deps.log("warn", "flight_reply_unverified", logBase);
      yield stepEvent(NOT_VERIFIED_STEP);
    }
  }

  // Every step of the turn is kept, so the run panel and its audit trail survive a reload.
  const payload: MessageResultsPayload | null =
    finalResults.length > 0 || steps.size > 0 ? { results: finalResults, steps: [...steps.values()].slice(0, 40) } : null;

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

  // Background writes after the reply, one after the other so their order is fixed.
  let background: Promise<unknown> = Promise.resolve();
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
    background = record;
  }

  // The cards and the run panel survive a reload. An oversized payload is trimmed to fit, not
  // dropped (the flight summary and its unverified mentions always stay). A failed write only logs.
  const resultsRepo = deps.messageResults;
  if (payload && resultsRepo) {
    const fitted = fitResultsPayload(payload, MESSAGE_RESULTS_MAX_BYTES);
    if (fitted.trim) deps.log(fitted.fits ? "info" : "warn", "message_results_trimmed", { ...logBase, ...fitted.trim, fits: fitted.fits });
    const write = background
      .then(() => resultsRepo.insertResults(turn.userId, saved.id, fitted.payload))
      .catch(() => deps.log("warn", "message_results_failed", logBase));
    deps.waitUntil(write);
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
    workflowCalls,
    connectorCalls,
    tainted,
    results: finalResults.length,
    researchUnverified,
    memoriesUsed: usedMemoryIds.size,
    documentChunksUsed: usedChunkIds.size,
    promptTokens: usage?.promptTokens,
    completionTokens: usage?.completionTokens,
  });
  yield {
    type: "done",
    message: payload ? { ...saved, results: payload } : saved,
    truncated: truncated || finishReason === "length",
    autoActions: !tainted,
  };
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
