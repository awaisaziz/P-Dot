import type { ActionProposalRepository, NewActionProposal } from "@/server/db/action-proposals";
import type { ConversationRepository, NewMessage } from "@/server/db/conversations";
import type { MemoryRepository as MemoryStore, NewMemory } from "@/server/db/memories";
import type { DocumentChunkMatch, MemoryMatch, RetrievalRepository } from "@/server/db/retrieval";
import type { QuotaGate } from "@/server/db/quota";
import type { SpendCaps, SpendGuard, SpendLimit, SpendProvider, SpendReservation } from "@/server/db/spend";
import type { AssistantDeps } from "@/server/assistant/service";
import { createCircuitBreaker } from "@/server/assistant/breaker";
import { buildRoutingConfig, type RoutingConfig } from "@/server/assistant/tiers";
import type { ChatMessage, CompletionChunk, ModelCallRequest, ModelProvider } from "@/server/providers/model";
import type { WebSearchResult } from "@/server/providers/tavily/client";
import type {
  ActionPayload,
  ActionProposalDTO,
  ActionStatus,
  ConversationSummary,
  MemoryDTO,
  MemoryStatus,
  MessageDTO,
  Mode,
  TaskDTO,
} from "@/types/api";
import { actionPayloadSchema, actionSummarySchema } from "@/lib/schemas";
import type { TaskRepository } from "@/server/db/tasks";
import type { ContextRecordRepository, NewContextRecord } from "@/server/db/context-records";
import { createBudgetedEmbedder, type Embedder } from "@/server/assistant/embed";
import type { WorkflowTavily } from "@/server/assistant/workflows/core";
import type { GoogleConnector } from "@/server/connectors/google/connector";
import {
  jsonbTextBytes,
  MESSAGE_RESULTS_MAX_BYTES,
  messageResultsPayloadSchema,
  type MessageResultsRepository,
} from "@/server/db/message-results";
import { EMBEDDING_DIMENSIONS } from "@/lib/limits";
import type { MessageResultsPayload } from "@/types/workflows";

interface StoredConversation extends ConversationSummary {
  userId: string;
}

interface StoredMessage extends MessageDTO {
  userId: string;
  conversationId: string;
}

function toDto(message: StoredMessage): MessageDTO {
  const { id, role, content, webSearch, sources, route, createdAt } = message;
  return { id, role, content, webSearch, sources, route, createdAt };
}

/**
 * In-memory repository that mirrors the database's ownership rules (RLS):
 * every read and write is scoped to the given user ID.
 */
export class MemoryRepository implements ConversationRepository {
  conversations: StoredConversation[] = [];
  messages: StoredMessage[] = [];
  private counter = 0;
  failInsertForRole: "user" | "assistant" | null = null;

  private nextId(): string {
    this.counter += 1;
    return `00000000-0000-4000-8000-${String(this.counter).padStart(12, "0")}`;
  }

  private timestamp(): string {
    return new Date(Date.UTC(2026, 9, 14, 12, 0, this.counter)).toISOString();
  }

  async getConversation(userId: string, id: string) {
    const found = this.conversations.find((c) => c.id === id && c.userId === userId);
    return found ? { id: found.id, title: found.title, mode: found.mode, updatedAt: found.updatedAt } : null;
  }

  async listConversations(userId: string, limit: number, mode?: Mode) {
    return this.conversations
      .filter((c) => c.userId === userId && (!mode || c.mode === mode))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map(({ id, title, mode: m, updatedAt }) => ({ id, title, mode: m, updatedAt }));
  }

  async createConversation(userId: string, title: string, mode: Mode = "personal") {
    const conversation = { id: this.nextId(), title, mode, updatedAt: this.timestamp(), userId };
    this.conversations.push(conversation);
    return { id: conversation.id, title, mode, updatedAt: conversation.updatedAt };
  }

  async renameConversation(userId: string, id: string, title: string) {
    const found = this.conversations.find((c) => c.id === id && c.userId === userId);
    if (!found) return null;
    found.title = title;
    return { id: found.id, title: found.title, mode: found.mode, updatedAt: found.updatedAt };
  }

  async deleteConversation(userId: string, id: string) {
    const before = this.conversations.length;
    this.conversations = this.conversations.filter((c) => !(c.id === id && c.userId === userId));
    const deleted = this.conversations.length < before;
    if (deleted) this.messages = this.messages.filter((m) => m.conversationId !== id);
    return deleted;
  }

  async listRecentMessages(userId: string, conversationId: string, limit: number) {
    return this.messages
      .filter((m) => m.conversationId === conversationId && m.userId === userId)
      .slice(-limit)
      .map(toDto);
  }

  async insertMessage(userId: string, message: NewMessage) {
    if (this.failInsertForRole === message.role) throw new Error("insert failed");
    const owner = this.conversations.find((c) => c.id === message.conversationId);
    if (!owner || owner.userId !== userId) throw new Error("RLS: conversation not owned by user");
    const stored: StoredMessage = {
      id: this.nextId(),
      role: message.role,
      content: message.content,
      webSearch: message.webSearch ?? "off",
      sources: message.sources ?? [],
      route: message.role === "assistant" ? (message.route ?? null) : null,
      createdAt: this.timestamp(),
      userId,
      conversationId: message.conversationId,
    };
    this.messages.push(stored);
    owner.updatedAt = stored.createdAt;
    return toDto(stored);
  }
}

/** In-memory task store with the same per-user scoping as RLS. */
export class MemoryTasks implements TaskRepository {
  tasks: (TaskDTO & { userId: string })[] = [];
  private counter = 0;

  private dto({ userId: _userId, ...task }: TaskDTO & { userId: string }): TaskDTO {
    void _userId;
    return task;
  }

  async listTasks(userId: string, limit: number, mode?: Mode) {
    return this.tasks
      .filter((t) => t.userId === userId && (!mode || t.mode === mode))
      .slice(0, limit)
      .map((t) => this.dto(t));
  }

  async createTask(userId: string, mode: Mode, title: string) {
    this.counter += 1;
    const task = {
      id: `10000000-0000-4000-8000-${String(this.counter).padStart(12, "0")}`,
      mode,
      title,
      done: false,
      createdAt: new Date(Date.UTC(2026, 9, 16, 9, 0, this.counter)).toISOString(),
      userId,
    };
    this.tasks.push(task);
    return this.dto(task);
  }

  async updateTask(userId: string, id: string, changes: { title?: string; done?: boolean }) {
    const task = this.tasks.find((t) => t.id === id && t.userId === userId);
    if (!task) return null;
    Object.assign(task, changes);
    return this.dto(task);
  }

  async deleteTask(userId: string, id: string) {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((t) => !(t.id === id && t.userId === userId));
    return this.tasks.length < before;
  }
}

/** In-memory memories (decision 0009), scoped to the user like RLS. Vectors are kept for the retrieval fake. */
export class FakeMemories implements MemoryStore {
  memories: (MemoryDTO & { userId: string; embedding: number[] | null })[] = [];
  private counter = 0;

  private dto({ userId: _userId, embedding: _embedding, ...memory }: (typeof this.memories)[number]): MemoryDTO {
    void _userId;
    void _embedding;
    return memory;
  }

  async listMemories(userId: string, status: MemoryStatus | undefined, limit: number, mode?: Mode) {
    return this.memories
      .filter((m) => m.userId === userId && (!mode || m.mode === mode) && (!status || m.status === status))
      .slice(-limit)
      .reverse()
      .map((m) => this.dto(m));
  }

  async getMemory(userId: string, id: string) {
    const found = this.memories.find((m) => m.id === id && m.userId === userId);
    return found ? this.dto(found) : null;
  }

  async createMemory(userId: string, memory: NewMemory, embedding: number[] | null) {
    this.counter += 1;
    const stored = {
      id: `20000000-0000-4000-8000-${String(this.counter).padStart(12, "0")}`,
      mode: memory.mode,
      content: memory.content,
      status: memory.status,
      source: memory.source,
      sourceMessageId: memory.sourceMessageId,
      createdAt: new Date(Date.UTC(2026, 9, 20, 9, 0, this.counter)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 9, 20, 9, 0, this.counter)).toISOString(),
      userId,
      embedding,
    };
    this.memories.push(stored);
    return this.dto(stored);
  }

  async updateMemory(
    userId: string,
    id: string,
    changes: { content?: string; mode?: Mode; status?: MemoryStatus },
    embedding?: number[] | null,
    ifContent?: string,
  ) {
    const found = this.memories.find((m) => m.id === id && m.userId === userId);
    if (!found || (ifContent !== undefined && found.content !== ifContent)) return null;
    Object.assign(found, changes);
    if (embedding !== undefined) found.embedding = embedding;
    return this.dto(found);
  }

  async setEmbeddingIfContent(userId: string, id: string, content: string, embedding: number[]) {
    const found = this.memories.find((m) => m.id === id && m.userId === userId && m.content === content);
    if (!found) return false;
    found.embedding = embedding;
    return true;
  }

  async deleteMemory(userId: string, id: string) {
    const before = this.memories.length;
    this.memories = this.memories.filter((m) => !(m.id === id && m.userId === userId));
    return this.memories.length < before;
  }
}

/** Similarity search fake: returns what a test scripted, and records the queries. */
export class FakeRetrieval implements RetrievalRepository {
  memoryMatches: MemoryMatch[] = [];
  chunkMatches: DocumentChunkMatch[] = [];
  calls: { kind: "memories" | "chunks"; mode: Mode | null; count: number }[] = [];

  async matchMemories(_vector: number[], mode: Mode | null, count: number) {
    this.calls.push({ kind: "memories", mode, count });
    return this.memoryMatches.slice(0, count);
  }

  async matchDocumentChunks(_vector: number[], mode: Mode | null, count: number) {
    this.calls.push({ kind: "chunks", mode, count });
    return this.chunkMatches.slice(0, count);
  }
}

/** In-memory action proposals (decision 0009). Inserts only; decisions are not modelled. */
export class FakeProposals implements ActionProposalRepository {
  proposals: (ActionProposalDTO & { userId: string })[] = [];
  private counter = 0;

  async createProposal(userId: string, proposal: NewActionProposal) {
    const payload: ActionPayload = actionPayloadSchema.parse(proposal.payload);
    const summary = actionSummarySchema.parse(proposal.summary);
    this.counter += 1;
    const stored = {
      id: `30000000-0000-4000-8000-${String(this.counter).padStart(12, "0")}`,
      conversationId: proposal.conversationId,
      payload,
      summary,
      status: "proposed" as ActionStatus,
      result: null,
      createdAt: new Date(Date.UTC(2026, 9, 20, 10, 0, this.counter)).toISOString(),
      decidedAt: null,
      verified: false,
      userId,
    };
    this.proposals.push(stored);
    const { userId: _userId, ...dto } = stored;
    void _userId;
    return dto;
  }

  async listProposals(userId: string, status: ActionStatus | undefined, limit: number) {
    return this.proposals
      .filter((p) => p.userId === userId && (!status || p.status === status))
      .slice(0, limit)
      .map(({ userId: _userId, ...dto }) => {
        void _userId;
        return dto;
      });
  }

  async decide(): Promise<never> {
    throw new Error("not modelled");
  }
}

/** The default caps from config, in micro-dollars (Nebius) and credits (Tavily). */
export const TEST_SPEND_CAPS: Record<SpendProvider, SpendCaps> = {
  nebius: { day: 1_000_000, period: 20_000_000, userDay: 250_000 },
  tavily: { day: 40, period: 800, userDay: 10 },
};

/**
 * In-memory spend guard with the database's rules: a reservation holds its
 * amount, and settle can give back part of it once.
 */
export class FakeSpend implements SpendGuard {
  reservations: { id: string; provider: SpendProvider; held: number; settled: number | null }[] = [];
  refuse: Partial<Record<SpendProvider, SpendLimit>> = {};
  failReserve = false;

  async reserve(provider: SpendProvider, amount: number): Promise<SpendReservation> {
    if (this.failReserve) throw new Error("reserve failed");
    const limit = this.refuse[provider];
    if (limit) return { allowed: false, limit };
    const id = `res-${this.reservations.length + 1}`;
    this.reservations.push({ id, provider, held: amount, settled: null });
    return { allowed: true, id };
  }

  async settle(id: string, amount: number) {
    const reservation = this.reservations.find((r) => r.id === id);
    if (!reservation || reservation.settled !== null) throw new Error("nothing to settle");
    if (amount < 0 || amount > reservation.held) throw new Error("invalid amount");
    reservation.settled = amount;
  }

  /** What stays counted for a provider: settled amounts, or the hold if not settled. */
  counted(provider: SpendProvider): number {
    return this.reservations
      .filter((r) => r.provider === provider)
      .reduce((sum, r) => sum + (r.settled ?? r.held), 0);
  }
}

/** In-memory "what was sent" records, scoped to the user like RLS. */
export class FakeContextRecords implements ContextRecordRepository {
  records: (NewContextRecord & { userId: string })[] = [];

  async insertContextRecord(userId: string, record: NewContextRecord) {
    this.records.push({ ...record, userId });
  }

  async getContextRecord(userId: string, messageId: string) {
    const found = this.records.find((r) => r.userId === userId && r.messageId === messageId);
    if (!found) return null;
    const { userId: _userId, memoryIds, documentChunkIds, ...record } = found;
    void _userId;
    return {
      ...record,
      memories: memoryIds.map((id) => ({ id, content: null })),
      documentChunks: documentChunkIds.map((id) => ({ id, documentId: null, title: null })),
      createdAt: "2026-10-14T12:00:00.000Z",
    };
  }
}

/**
 * In-memory message_results, scoped to the user like RLS, with the real
 * repository's checks: the strict payload schema, the 32 KB cap, nothing
 * stored for an empty payload, and one row per message (the primary key).
 */
export class FakeMessageResults implements MessageResultsRepository {
  rows: { userId: string; messageId: string; payload: MessageResultsPayload }[] = [];

  async insertResults(userId: string, messageId: string, payload: MessageResultsPayload) {
    const parsed = messageResultsPayloadSchema.safeParse(payload);
    if (!parsed.success) throw new Error("invalid results payload");
    if (parsed.data.results.length === 0 && parsed.data.steps.length === 0) return;
    if (jsonbTextBytes(parsed.data) > MESSAGE_RESULTS_MAX_BYTES) throw new Error("results payload too large");
    if (this.rows.some((row) => row.messageId === messageId)) throw new Error("duplicate key");
    this.rows.push({ userId, messageId, payload: parsed.data });
  }

  async listForMessages(userId: string, messageIds: string[]) {
    return new Map(
      this.rows
        .filter((row) => row.userId === userId && messageIds.includes(row.messageId))
        .map((row) => [row.messageId, row.payload] as const),
    );
  }
}

/**
 * A fake embeddings endpoint: one vector for each input, with token usage.
 * `calls` counts the requests, so a test can prove that no embedding was paid for.
 */
export function fakeEmbeddingFetch() {
  const state = { calls: 0 };
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
    state.calls += 1;
    const input = (JSON.parse(String(init?.body)) as { input: string[] }).input;
    const data = input.map((_text, index) => ({ index, embedding: Array<number>(EMBEDDING_DIMENSIONS).fill(0.5) }));
    return new Response(JSON.stringify({ data, usage: { prompt_tokens: input.length * 8 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetchImpl: fetchImpl as typeof fetch, state };
}

/** The real budgeted embedder, on a fake endpoint and the given spend guard. */
export function testEmbedder(spend: SpendGuard, fetchImpl: typeof fetch = fakeEmbeddingFetch().fetchImpl): Embedder {
  return createBudgetedEmbedder({ settings: { apiKey: "test-key", baseUrl: "https://nebius.test/v1" }, spend, fetchImpl });
}

export class FakeQuota implements QuotaGate {
  calls = 0;
  constructor(private readonly allow = true) {}
  async consume() {
    this.calls += 1;
    return { allowed: this.allow, resetsAt: new Date(Date.UTC(2026, 9, 14, 13, 0, 0)) };
  }
}

/** Routing where every tier uses one model with 1,024 output tokens and no hedge. */
export function testRouting(model = "nvidia/nemotron-3-super-120b-a12b") {
  return buildRoutingConfig({
    chains: { fast: [model], standard: [model], heavy: [model], vision: [model] },
    maxOutputTokens: 1024,
    standardMaxOutputTokens: 1024,
    heavyMaxOutputTokens: 1024,
    heavyThinkingBudgetTokens: 0,
    hedgeAfterMs: 0,
  });
}

export interface FakeDepsOptions {
  repo?: MemoryRepository;
  quota?: FakeQuota;
  spend?: FakeSpend;
  /** Every tier uses only this model (default: Super), so prices stay simple in tests. */
  model?: string;
  search?: ((query: string, signal: AbortSignal) => Promise<WebSearchResult[]>) | null;
  /** The reply, or a function that gets the messages, the signal and the whole request (with its tools). */
  reply?:
    | string[]
    | ((messages: ChatMessage[], signal: AbortSignal, request: ModelCallRequest) => AsyncIterable<CompletionChunk>);
  /** Replaces the simple reply provider (for routing tests). */
  provider?: ModelProvider;
  routing?: RoutingConfig;
  contextRecords?: ContextRecordRepository;
  /** The tool loop's data. Each one is offered to the model only when set. */
  memories?: FakeMemories;
  retrieval?: FakeRetrieval;
  actionProposals?: FakeProposals;
  embedder?: Embedder;
  smartTitles?: boolean;
  /** Grounded workflows (decision 0015): Tavily bound to a fake fetch. */
  workflowTavily?: WorkflowTavily | null;
  messageResults?: MessageResultsRepository;
  /** The Google connector for the request (decision 0016). */
  connector?: () => GoogleConnector | null;
}

export function fakeDeps(options: FakeDepsOptions = {}) {
  const prompts: ChatMessage[][] = [];
  const calls: ModelCallRequest[] = [];
  const model = options.model ?? "nvidia/nemotron-3-super-120b-a12b";
  const searches: string[] = [];
  const logs: { level: string; event: string; fields: Record<string, unknown> }[] = [];
  const waited: Promise<unknown>[] = [];
  const reply = options.reply ?? ["Hello", " there."];

  const deps: AssistantDeps = {
    repo: options.repo ?? new MemoryRepository(),
    quota: options.quota ?? new FakeQuota(),
    spend: options.spend ?? new FakeSpend(),
    routing: options.routing ?? testRouting(model),
    search:
      options.search === null
        ? null
        : async (query, signal) => {
            searches.push(query);
            return options.search ? options.search(query, signal) : [];
          },
    provider: options.provider ?? {
      name: "nebius",
      stream: (request, signal) => {
        calls.push(request);
        prompts.push(request.messages);
        if (typeof reply === "function") return reply(request.messages, signal, request);
        return (async function* () {
          for (const text of reply) yield { type: "text" as const, text };
          yield { type: "finish" as const, finishReason: "stop", usage: { promptTokens: 10, completionTokens: 2 } };
        })();
      },
    },
    ...(options.contextRecords ? { contextRecords: options.contextRecords } : {}),
    ...(options.memories ? { memories: options.memories } : {}),
    ...(options.retrieval ? { retrieval: options.retrieval } : {}),
    ...(options.actionProposals ? { actionProposals: options.actionProposals } : {}),
    ...(options.embedder ? { embedder: options.embedder } : {}),
    ...(options.smartTitles ? { smartTitles: true } : {}),
    ...(options.workflowTavily ? { workflowTavily: options.workflowTavily } : {}),
    ...(options.messageResults ? { messageResults: options.messageResults } : {}),
    ...(options.connector ? { connector: options.connector } : {}),
    breaker: createCircuitBreaker({ threshold: 3, cooldownMs: 30_000 }),
    random: () => 0,
    now: () => new Date(Date.UTC(2026, 9, 14, 12, 30, 0)),
    log: (level, event, fields = {}) => {
      logs.push({ level, event, fields });
    },
    waitUntil: (work) => {
      waited.push(work);
    },
  };
  return { deps, prompts, calls, searches, logs, waited };
}
