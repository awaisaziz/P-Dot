import "server-only";
import { z } from "zod";
import { SEARCH_EXCERPT_CHARS, SEARCH_MAX_RESULTS, SEARCH_QUERY_CHARS } from "@/lib/limits";
import { toSafeHttpUrl } from "@/lib/safe-url";
import { createAbortScope, discardBody, kindFromStatus, ProviderError } from "../errors";

// https://docs.tavily.com/documentation/api-reference/endpoint/search
// https://docs.tavily.com/documentation/api-reference/endpoint/extract

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const TAVILY_EXTRACT_URL = "https://api.tavily.com/extract";

/**
 * A Tavily API key, or keyless access (development only, decision 0015): the
 * keyless header and no Authorization header. Config never allows keyless in
 * production.
 */
export type TavilySettings = { apiKey: string; keyless?: undefined } | { keyless: true; apiKey?: undefined };

export interface WebSearchResult {
  title: string;
  url: string;
  /** Untrusted text retrieved from the web page. */
  excerpt: string;
}

export interface SearchOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResults?: number;
}

const responseSchema = z.object({
  results: z.array(
    z.object({
      title: z.string().nullish(),
      url: z.string(),
      content: z.string().nullish(),
    }),
  ),
});

function clean(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars - 1).trimEnd()}…` : collapsed;
}

function headers(settings: TavilySettings): Record<string, string> {
  if (settings.keyless) return { "Content-Type": "application/json", "X-Tavily-Access-Mode": "keyless" };
  return { Authorization: `Bearer ${settings.apiKey}`, "Content-Type": "application/json" };
}

/** POSTs a JSON body and returns the parsed JSON. Maps every failure to a ProviderError. */
async function postJson(
  url: string,
  settings: TavilySettings,
  body: Record<string, unknown>,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch; timeoutMs: number },
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const scope = createAbortScope({ totalMs: options.timeoutMs, parent: options.signal });
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: headers(settings),
        body: JSON.stringify(body),
        signal: scope.signal,
      });
    } catch {
      if (options.signal?.aborted) throw new ProviderError("tavily", "aborted");
      throw new ProviderError("tavily", scope.timedOut() ? "timeout" : "unavailable");
    }

    if (!response.ok) {
      await discardBody(response);
      throw new ProviderError("tavily", kindFromStatus(response.status), response.status);
    }

    try {
      return await response.json();
    } catch {
      if (options.signal?.aborted) throw new ProviderError("tavily", "aborted");
      if (scope.timedOut()) throw new ProviderError("tavily", "timeout");
      throw new ProviderError("tavily", "bad_response");
    }
  } finally {
    scope.dispose();
  }
}

export async function searchWeb(
  settings: TavilySettings,
  query: string,
  options: SearchOptions = {},
): Promise<WebSearchResult[]> {
  const maxResults = Math.min(options.maxResults ?? SEARCH_MAX_RESULTS, SEARCH_MAX_RESULTS);
  const json = await postJson(
    TAVILY_SEARCH_URL,
    settings,
    {
      query: clean(query, SEARCH_QUERY_CHARS),
      search_depth: "basic",
      max_results: maxResults,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
    },
    { signal: options.signal, fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs ?? 10_000 },
  );
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) throw new ProviderError("tavily", "bad_response");

  const seen = new Set<string>();
  const results: WebSearchResult[] = [];
  for (const item of parsed.data.results) {
    const url = toSafeHttpUrl(item.url);
    if (!url || seen.has(url)) continue;
    const excerpt = clean(item.content ?? "", SEARCH_EXCERPT_CHARS);
    if (!excerpt) continue;
    seen.add(url);
    results.push({
      title: clean(item.title || new URL(url).hostname, 200),
      url,
      excerpt,
    });
    if (results.length >= maxResults) break;
  }
  return results;
}

// ---------------------------------------------------------------------------
// Grounded workflows (decision 0015): a search with more options, and extract.
// ---------------------------------------------------------------------------

export type TavilyDepth = "basic" | "advanced";

/** Most results one detailed search returns. */
export const DETAILED_SEARCH_MAX_RESULTS = 10;
/** Most domains sent in include_domains or exclude_domains. */
const MAX_DOMAINS = 30;
const MAX_DOMAIN_CHARS = 100;

export interface DetailedSearchResult extends WebSearchResult {
  /** Tavily's relevance score from 0 to 1 (0 when it sent none). Relevance, not accuracy. */
  score: number;
  /** Tavily's estimate of the page's publication date, as it sent it. */
  publishedDate?: string;
}

export interface DetailedSearchOptions {
  depth?: TavilyDepth;
  /** At most DETAILED_SEARCH_MAX_RESULTS. */
  maxResults?: number;
  includeDomains?: string[];
  /** "prefer" ranks the domains first; "restrict" keeps only them. Sent only with includeDomains. */
  includeDomainsMode?: "prefer" | "restrict";
  excludeDomains?: string[];
  timeRange?: "day" | "week" | "month" | "year";
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Called with usage.credits when Tavily reports it (metadata for logs). */
  onUsage?: (credits: number) => void;
}

const usageSchema = z.object({ credits: z.number().int().min(0).max(1_000) });

const detailedResponseSchema = z.object({
  results: z.array(
    z.object({
      title: z.string().nullish(),
      url: z.string(),
      content: z.string().nullish(),
      score: z.number().nullish(),
      published_date: z.string().nullish(),
    }),
  ),
  usage: z.unknown().optional(),
});

function domainList(domains: string[] | undefined): string[] {
  const cleaned = (domains ?? []).map((d) => d.trim().toLowerCase()).filter((d) => d.length > 0 && d.length <= MAX_DOMAIN_CHARS);
  return [...new Set(cleaned)].slice(0, MAX_DOMAINS);
}

function reportUsage(usage: unknown, onUsage: ((credits: number) => void) | undefined): void {
  const parsed = usageSchema.safeParse(usage);
  if (parsed.success && onUsage) onUsage(parsed.data.credits);
}

/**
 * A search with depth, domain and time filters, scores and publication dates.
 * Same safety as searchWeb: safe http(s) URLs only, no duplicates, capped
 * titles and excerpts. Excerpts keep Tavily's "[...]" chunk separators.
 */
export async function searchWebDetailed(
  settings: TavilySettings,
  query: string,
  options: DetailedSearchOptions = {},
): Promise<DetailedSearchResult[]> {
  const maxResults = Math.max(1, Math.min(options.maxResults ?? SEARCH_MAX_RESULTS, DETAILED_SEARCH_MAX_RESULTS));
  const body: Record<string, unknown> = {
    query: clean(query, SEARCH_QUERY_CHARS),
    search_depth: options.depth ?? "basic",
    max_results: maxResults,
    include_answer: false,
    include_raw_content: false,
    include_images: false,
    include_published_date: true,
    include_usage: true,
  };
  const include = domainList(options.includeDomains);
  if (include.length > 0) {
    body.include_domains = include;
    // Tavily answers 400 when the mode comes without include_domains.
    if (options.includeDomainsMode) body.include_domains_mode = options.includeDomainsMode;
  }
  const exclude = domainList(options.excludeDomains);
  if (exclude.length > 0) body.exclude_domains = exclude;
  if (options.timeRange) body.time_range = options.timeRange;

  const json = await postJson(TAVILY_SEARCH_URL, settings, body, {
    signal: options.signal,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs ?? 10_000,
  });
  const parsed = detailedResponseSchema.safeParse(json);
  if (!parsed.success) throw new ProviderError("tavily", "bad_response");
  reportUsage(parsed.data.usage, options.onUsage);

  const seen = new Set<string>();
  const results: DetailedSearchResult[] = [];
  for (const item of parsed.data.results) {
    const url = toSafeHttpUrl(item.url);
    if (!url || seen.has(url)) continue;
    const excerpt = clean(item.content ?? "", SEARCH_EXCERPT_CHARS);
    if (!excerpt) continue;
    seen.add(url);
    const score = typeof item.score === "number" && Number.isFinite(item.score) ? Math.min(1, Math.max(0, item.score)) : 0;
    const publishedDate = item.published_date ? clean(item.published_date, 64) : "";
    results.push({
      title: clean(item.title || new URL(url).hostname, 200),
      url,
      excerpt,
      score,
      ...(publishedDate ? { publishedDate } : {}),
    });
    if (results.length >= maxResults) break;
  }
  return results;
}

/** Most URLs one extract call takes here (1 basic credit). */
export const EXTRACT_MAX_URLS = 5;
/** Longest chunk kept, in characters. */
export const EXTRACT_CHUNK_MAX_CHARS = 800;
/** Most chunks kept for one page. */
export const EXTRACT_MAX_CHUNKS_PER_SOURCE = 3;
/** Most characters kept over all pages of one extract call. */
export const EXTRACT_TOTAL_MAX_CHARS = EXTRACT_MAX_URLS * EXTRACT_MAX_CHUNKS_PER_SOURCE * EXTRACT_CHUNK_MAX_CHARS;

export interface ExtractOptions {
  /** Reranks the page's chunks; the most relevant come back. */
  query: string;
  /** 1 to 3. */
  chunksPerSource?: number;
  depth?: "basic";
  /** Default 30 s. */
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  onUsage?: (credits: number) => void;
}

export interface ExtractedPage {
  url: string;
  /** Untrusted page text, Tavily's reranked chunks, each at most EXTRACT_CHUNK_MAX_CHARS. */
  chunks: string[];
}

export interface ExtractResult {
  pages: ExtractedPage[];
  /** Requested URLs that came back with no usable text. */
  failed: string[];
}

const extractResponseSchema = z.object({
  results: z.array(z.object({ url: z.string(), raw_content: z.string().nullish() })),
  failed_results: z.array(z.object({ url: z.string() })).nullish(),
  usage: z.unknown().optional(),
});

/** Cuts text to at most `max` UTF-16 units without splitting a surrogate pair. */
function cutChars(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/** Splits Tavily's reranked content on its "[...]" separator into trimmed, capped chunks. */
export function splitChunks(rawContent: string, maxChunks: number): string[] {
  return rawContent
    .split("[...]")
    .map((chunk) => chunk.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim())
    .map((chunk) => cutChars(chunk, EXTRACT_CHUNK_MAX_CHARS).trim())
    .filter((chunk) => chunk.length > 0)
    .slice(0, maxChunks);
}

/**
 * Reads up to EXTRACT_MAX_URLS pages with one extract call (basic depth), with
 * the chunks most relevant to `query`. Only requested URLs come back; any
 * requested URL without text is listed in `failed`. Throws ProviderError.
 */
export async function extractPages(
  settings: TavilySettings,
  urls: string[],
  options: ExtractOptions,
): Promise<ExtractResult> {
  const requested = [...new Set(urls.map((url) => toSafeHttpUrl(url)).filter((url): url is string => url !== null))];
  if (requested.length === 0) return { pages: [], failed: [] };
  if (requested.length > EXTRACT_MAX_URLS) throw new RangeError(`extract takes at most ${EXTRACT_MAX_URLS} URLs`);
  const asked = Number.isFinite(options.chunksPerSource) ? Math.trunc(options.chunksPerSource!) : EXTRACT_MAX_CHUNKS_PER_SOURCE;
  const chunksPerSource = Math.min(EXTRACT_MAX_CHUNKS_PER_SOURCE, Math.max(1, asked));
  const timeoutMs = options.timeoutMs ?? 30_000;

  const json = await postJson(
    TAVILY_EXTRACT_URL,
    settings,
    {
      urls: requested,
      query: clean(options.query, SEARCH_QUERY_CHARS),
      chunks_per_source: chunksPerSource,
      extract_depth: options.depth ?? "basic",
      format: "markdown",
      include_images: false,
      include_favicon: false,
      include_usage: true,
      // Tavily's own limit, a little under ours, so it answers with what it has.
      timeout: Math.min(60, Math.max(1, Math.floor(timeoutMs / 1000) - 5)),
    },
    { signal: options.signal, fetchImpl: options.fetchImpl, timeoutMs },
  );
  const parsed = extractResponseSchema.safeParse(json);
  if (!parsed.success) throw new ProviderError("tavily", "bad_response");
  reportUsage(parsed.data.usage, options.onUsage);

  const wanted = new Set(requested);
  const byUrl = new Map<string, string[]>();
  let total = 0;
  for (const item of parsed.data.results) {
    const url = toSafeHttpUrl(item.url);
    if (!url || !wanted.has(url) || byUrl.has(url)) continue;
    const chunks: string[] = [];
    for (const chunk of splitChunks(item.raw_content ?? "", chunksPerSource)) {
      const room = EXTRACT_TOTAL_MAX_CHARS - total;
      if (room <= 0) break;
      const kept = cutChars(chunk, room).trim();
      if (!kept) break;
      chunks.push(kept);
      total += kept.length;
    }
    if (chunks.length > 0) byUrl.set(url, chunks);
  }
  // Keep the order the caller asked for; Tavily's order is not guaranteed.
  const pages = requested.flatMap((url) => {
    const chunks = byUrl.get(url);
    return chunks ? [{ url, chunks }] : [];
  });
  return { pages, failed: requested.filter((url) => !byUrl.has(url)) };
}
