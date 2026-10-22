import { createCircuitBreaker } from "@/server/assistant/breaker";
import { extractionPlan } from "@/server/assistant/complete";
import { buildRoutingConfig, LIGHTNING, SUPER } from "@/server/assistant/tiers";
import { bindTavily, type WorkflowContext } from "@/server/assistant/workflows/core";
import type { LogFields, LogLevel } from "@/server/log";
import { ProviderError } from "@/server/providers/errors";
import type { CompletionChunk, ModelCallRequest, ModelProvider, TokenUsage } from "@/server/providers/model";
import type { MessageResultsPayload, WorkflowStep } from "@/types/workflows";
import { FakeSpend } from "./fakes";

// Fakes for the grounded workflows (decision 0015): a model provider that
// answers from a script, a Tavily fetch that answers /search and /extract with
// raw JSON (so the real adapters run), and a WorkflowContext builder. Labelled
// as fakes: nothing here calls a real service.

/** What a scripted model call returns: chunks, or an error thrown before any chunk. */
export type ScriptedReply = CompletionChunk[] | ProviderError;

/** A provider whose replies come from a function of the request. Records every request. */
export class ScriptedProvider implements ModelProvider {
  readonly name = "nebius" as const;
  requests: ModelCallRequest[] = [];

  constructor(private readonly reply: (request: ModelCallRequest, index: number) => ScriptedReply) {}

  stream(request: ModelCallRequest, signal: AbortSignal): AsyncIterable<CompletionChunk> {
    this.requests.push(request);
    const reply = this.reply(request, this.requests.length - 1);
    return (async function* () {
      if (reply instanceof ProviderError) throw reply;
      for (const chunk of reply) {
        if (signal.aborted) throw new ProviderError("nebius", "aborted");
        yield chunk;
      }
    })();
  }
}

const USAGE: TokenUsage = { promptTokens: 1_000, completionTokens: 200 };

/** A forced tool call answer, as the executor sees it. */
export function toolReply(name: string, args: unknown, options: { finishReason?: string; usage?: TokenUsage | null } = {}): CompletionChunk[] {
  return [
    { type: "reasoning" },
    { type: "tool_calls", calls: [{ id: "call_x", type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } }] },
    { type: "finish", finishReason: options.finishReason ?? "tool_calls", usage: options.usage === undefined ? USAGE : options.usage },
  ];
}

/** A text answer (Ollama ignores tool_choice). */
export function textReply(text: string, finishReason = "stop"): CompletionChunk[] {
  return [
    { type: "text", text },
    { type: "finish", finishReason, usage: USAGE },
  ];
}

export interface FakeSearchResult {
  url: string;
  title?: string;
  content?: string;
  score?: number;
  published_date?: string;
}

export interface TavilyScript {
  /** Raw /search results for a request body (Tavily's JSON shape). Throw or return a Response to fail. */
  search?: (body: Record<string, unknown>, index: number) => FakeSearchResult[] | Response;
  /** Raw /extract raw_content by URL; a URL that is missing comes back in failed_results. */
  pages?: Record<string, string>;
  /** Replaces the /extract answer. */
  extract?: (body: Record<string, unknown>) => Response;
  /** Credits reported in usage. */
  credits?: { search?: number; extract?: number };
}

export interface TavilyCall {
  endpoint: "search" | "extract";
  body: Record<string, unknown>;
  headers: Headers;
}

/** A fetch that answers Tavily's /search and /extract from a script. Records every call. */
export function fakeTavilyFetch(script: TavilyScript) {
  const calls: TavilyCall[] = [];
  let searches = 0;
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (url.endsWith("/search")) {
      calls.push({ endpoint: "search", body, headers: new Headers(init?.headers) });
      const answer = script.search ? script.search(body, searches++) : [];
      if (answer instanceof Response) return answer;
      return Response.json({ query: body.query, results: answer, usage: { credits: script.credits?.search ?? 1 } });
    }
    if (url.endsWith("/extract")) {
      calls.push({ endpoint: "extract", body, headers: new Headers(init?.headers) });
      if (script.extract) return script.extract(body);
      const urls = body.urls as string[];
      const pages = script.pages ?? {};
      return Response.json({
        results: urls.filter((u) => pages[u] !== undefined).map((u) => ({ url: u, raw_content: pages[u] })),
        failed_results: urls.filter((u) => pages[u] === undefined).map((u) => ({ url: u, error: "Failed to fetch url" })),
        usage: { credits: script.credits?.extract ?? 1 },
      });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl: fetchImpl as typeof fetch, calls };
}

export const WORKFLOW_ROUTING = buildRoutingConfig({
  chains: { fast: [LIGHTNING], standard: [SUPER, LIGHTNING], heavy: [SUPER], vision: [SUPER] },
  maxOutputTokens: 1024,
  standardMaxOutputTokens: 2048,
  heavyMaxOutputTokens: 4096,
  heavyThinkingBudgetTokens: 1024,
  hedgeAfterMs: 1500,
});

export interface WorkflowHarness {
  ctx: WorkflowContext;
  spend: FakeSpend;
  logs: { level: LogLevel; event: string; fields: LogFields }[];
  waited: Promise<unknown>[];
  tavilyCalls: TavilyCall[];
  controller: AbortController;
}

/** A WorkflowContext with fakes: Tavily through the real adapters, a scripted model, FakeSpend. */
export function workflowHarness(options: {
  provider: ModelProvider;
  tavily?: TavilyScript | null;
  spend?: FakeSpend;
  now?: Date;
  timeZone?: string;
  firstSourceIndex?: number;
  maxSources?: number;
}): WorkflowHarness {
  const spend = options.spend ?? new FakeSpend();
  const logs: WorkflowHarness["logs"] = [];
  const waited: Promise<unknown>[] = [];
  const controller = new AbortController();
  const fake = options.tavily === null ? null : fakeTavilyFetch(options.tavily ?? {});
  const ctx: WorkflowContext = {
    requestId: "req-wf",
    signal: controller.signal,
    now: options.now ?? new Date(Date.UTC(2026, 9, 21, 12, 0, 0)),
    timeZone: options.timeZone ?? "Europe/London",
    spend,
    provider: options.provider,
    breaker: createCircuitBreaker({ threshold: 3, cooldownMs: 30_000 }),
    random: () => 0,
    log: (level, event, fields = {}) => {
      logs.push({ level, event, fields });
    },
    waitUntil: (work) => {
      waited.push(work);
    },
    extractionPlan: extractionPlan(WORKFLOW_ROUTING),
    tavily: fake ? bindTavily({ apiKey: "tvly-test" }, fake.fetchImpl) : null,
    firstSourceIndex: options.firstSourceIndex ?? 1,
    maxSources: options.maxSources ?? 5,
  };
  return { ctx, spend, logs, waited, tavilyCalls: fake?.calls ?? [], controller };
}

/** Runs a workflow generator to the end. Returns the steps it yielded and its result. */
export async function drain<T>(run: AsyncGenerator<WorkflowStep, T>): Promise<{ steps: WorkflowStep[]; result: T }> {
  const steps: WorkflowStep[] = [];
  for (;;) {
    const next = await run.next();
    if (next.done) return { steps, result: next.value };
    steps.push(next.value);
  }
}

/** A payload with every result kind, for the message_results tests. */
export const SAMPLE_RESULTS_PAYLOAD: MessageResultsPayload = {
  results: [
    {
      kind: "flights",
      trip: {
        originLabel: "London (all airports)",
        destinationLabel: "New York (all airports)",
        departDate: "2026-11-12",
        passengers: 1,
        line: "London (all airports) to New York (all airports) · one way · Thu 12 Nov 2026 · 1 adult",
      },
      options: [
        {
          airline: "British Airways",
          priceText: "£412",
          amount: 412,
          currency: "GBP",
          basis: ["from"],
          departs: "08:05",
          quote: "British Airways from £412 on Thu 12 Nov",
          source: 1,
        },
      ],
      typical: [],
      dropped: { wrong_direction: 1 },
      links: [{ label: "Check live fares on Google Flights", url: "https://www.google.com/travel/flights?q=Flights+from+London+to+New+York" }],
      sources: [
        { n: 1, title: "Flights", url: "https://www.britishairways.com/x", domain: "britishairways.com", retrievedAt: "2026-10-21T12:00:00.000Z", freshness: "Seen 5 minutes ago" },
      ],
      summary: "1 fare quoted on 1 page for Thu 12 Nov 2026; lowest quoted £412 on britishairways.com. Confirm on the links.",
      unverifiedMentions: ["$299"],
      retrievedAt: "2026-10-21T12:00:00.000Z",
    },
    {
      kind: "research",
      question: "q",
      claims: [{ claim: "c", quote: "the quote", source: 2, paraphrased: false }],
      dropped: {},
      sources: [],
      summary: "1 statement quoted from 1 page.",
      retrievedAt: "2026-10-21T12:00:00.000Z",
    },
    {
      kind: "calendar",
      events: [{ title: "Standup", start: "2026-10-22T09:00:00+01:00", end: "2026-10-22T09:15:00+01:00", allDay: false, calendar: "Work", fromOthers: true }],
      window: { start: "2026-10-22T00:00:00+01:00", end: "2026-10-23T00:00:00+01:00" },
    },
    { kind: "drive", files: [{ id: "abcdefghij12", name: "Plan", kind: "doc" }], read: { id: "abcdefghij12", name: "Plan", chars: 10, totalChars: 10, truncated: false } },
  ],
  steps: [
    { id: "flights.search", label: "Searched the web for LON to NYC on 12 Nov · 4 results", status: "done" },
    { id: "flights.verify", label: "Verified 1 of 2 fares", status: "partial", detail: "1 dropped: wrong direction 1" },
  ],
};
