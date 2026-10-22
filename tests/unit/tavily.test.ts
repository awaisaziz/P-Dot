import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SEARCH_EXCERPT_CHARS, SEARCH_QUERY_CHARS } from "@/lib/limits";
import { ConfigError } from "@/lib/supabase-config";
import { getAssistantConfig } from "@/server/config";
import { ProviderError } from "@/server/providers/errors";
import {
  EXTRACT_CHUNK_MAX_CHARS,
  EXTRACT_MAX_CHUNKS_PER_SOURCE,
  EXTRACT_TOTAL_MAX_CHARS,
  extractPages,
  searchWeb,
  searchWebDetailed,
  splitChunks,
} from "@/server/providers/tavily/client";

const settings = { apiKey: "tvly-test" };

function jsonFetch(body: unknown, status = 200) {
  return vi.fn<typeof fetch>(async () => Response.json(body, { status }));
}

describe("searchWeb", () => {
  it("sends a bounded basic search with the API key as a bearer token", async () => {
    const fetchImpl = jsonFetch({ results: [] });
    await searchWeb(settings, `  ${"q".repeat(SEARCH_QUERY_CHARS + 50)}  `, { fetchImpl });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.tavily.com/search");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer tvly-test");
    const body = JSON.parse(String(init?.body));
    expect(body.query.length).toBeLessThanOrEqual(SEARCH_QUERY_CHARS);
    expect(body).toMatchObject({ search_depth: "basic", max_results: 5, include_answer: false, include_raw_content: false });
  });

  it("keeps only safe, unique http(s) results and truncates excerpts", async () => {
    const fetchImpl = jsonFetch({
      results: [
        { title: "Good", url: "https://example.com/a", content: "x".repeat(SEARCH_EXCERPT_CHARS + 100), score: 0.9 },
        { title: "Duplicate", url: "https://example.com/a", content: "dup" },
        { title: "Script", url: "javascript:alert(1)", content: "bad" },
        { title: "", url: "http://untitled.example/", content: "  spaced\n\n out  " },
        { title: "Empty", url: "https://empty.example/", content: "" },
      ],
    });
    const results = await searchWeb(settings, "query", { fetchImpl });

    expect(results.map((r) => r.url)).toEqual(["https://example.com/a", "http://untitled.example/"]);
    expect(results[0]!.excerpt.length).toBeLessThanOrEqual(SEARCH_EXCERPT_CHARS);
    expect(results[1]).toEqual({ title: "untitled.example", url: "http://untitled.example/", excerpt: "spaced out" });
  });

  it.each([
    [401, "auth"],
    [429, "rate_limited"],
    [432, "quota"],
    [500, "unavailable"],
  ])("maps HTTP %i to %s", async (status, kind) => {
    const error = await searchWeb(settings, "q", { fetchImpl: jsonFetch({ detail: "x" }, status) }).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ provider: "tavily", kind, status });
  });

  it("rejects responses that do not match the documented shape", async () => {
    const error = await searchWeb(settings, "q", { fetchImpl: jsonFetch({ unexpected: true }) }).catch((e) => e);
    expect(error).toMatchObject({ kind: "bad_response" });
  });

  it("times out", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const error = await searchWeb(settings, "q", { fetchImpl, timeoutMs: 20 }).catch((e) => e);
    expect(error).toMatchObject({ kind: "timeout" });
  });

  it("uses keyless access with the keyless header and no Authorization header", async () => {
    const fetchImpl = jsonFetch({ results: [] });
    await searchWeb({ keyless: true }, "q", { fetchImpl });
    const headers = new Headers(fetchImpl.mock.calls[0]![1]?.headers);
    expect(headers.get("X-Tavily-Access-Mode")).toBe("keyless");
    expect(headers.get("Authorization")).toBeNull();
  });
});

describe("searchWebDetailed", () => {
  it("sends depth, domains, time range, published dates and usage, and nothing it was not asked for", async () => {
    const fetchImpl = jsonFetch({ results: [] });
    await searchWebDetailed(settings, "flights London to New York", {
      depth: "advanced",
      maxResults: 50,
      includeDomains: ["rome2rio.com", " Google.com/travel/flights ", "rome2rio.com", ""],
      includeDomainsMode: "prefer",
      excludeDomains: ["kayak.com"],
      timeRange: "month",
      fetchImpl,
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.tavily.com/search");
    expect(JSON.parse(String(init?.body))).toEqual({
      query: "flights London to New York",
      search_depth: "advanced",
      max_results: 10,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      include_published_date: true,
      include_usage: true,
      include_domains: ["rome2rio.com", "google.com/travel/flights"],
      include_domains_mode: "prefer",
      exclude_domains: ["kayak.com"],
      time_range: "month",
    });
    // The mode is never sent without domains (Tavily answers 400).
    await searchWebDetailed(settings, "q", { includeDomainsMode: "prefer", fetchImpl });
    const second = JSON.parse(String(fetchImpl.mock.calls[1]![1]?.body));
    expect(second).not.toHaveProperty("include_domains_mode");
    expect(second).not.toHaveProperty("include_domains");
    expect(second).toMatchObject({ search_depth: "basic", max_results: 5 });
  });

  it("keeps safe unique results with scores and dates, and reports usage", async () => {
    const usage: number[] = [];
    const fetchImpl = jsonFetch({
      results: [
        { title: "A", url: "https://a.example/x", content: "one [...] two", score: 0.91, published_date: "Mon, 10 Aug 2026 10:00:00 GMT" },
        { title: "A again", url: "https://a.example/x", content: "dup", score: 0.99 },
        { title: "Bad", url: "javascript:alert(1)", content: "x", score: 0.9 },
        { title: "", url: "https://b.example/", content: "x".repeat(SEARCH_EXCERPT_CHARS + 10), score: 7 },
        { title: "No score", url: "https://c.example/", content: "c" },
        { title: "Empty", url: "https://d.example/", content: "  " },
      ],
      usage: { credits: 2 },
    });
    const results = await searchWebDetailed(settings, "q", { fetchImpl, onUsage: (c) => usage.push(c) });
    expect(results.map((r) => [r.url, r.score])).toEqual([
      ["https://a.example/x", 0.91],
      ["https://b.example/", 1],
      ["https://c.example/", 0],
    ]);
    expect(results[0]).toMatchObject({ excerpt: "one [...] two", publishedDate: "Mon, 10 Aug 2026 10:00:00 GMT" });
    expect(results[1]!.title).toBe("b.example");
    expect(results[1]!.excerpt.length).toBeLessThanOrEqual(SEARCH_EXCERPT_CHARS);
    expect(results[2]).not.toHaveProperty("publishedDate");
    expect(usage).toEqual([2]);
  });

  it.each([
    [401, "auth"],
    [429, "rate_limited"],
    [432, "quota"],
    [433, "quota"],
    [400, "invalid_request"],
    [502, "unavailable"],
  ])("maps HTTP %i to %s", async (status, kind) => {
    const error = await searchWebDetailed(settings, "q", { fetchImpl: jsonFetch({ detail: "secret" }, status) }).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ provider: "tavily", kind, status });
    expect(String(error.message)).not.toContain("secret");
  });

  it("rejects an unexpected shape and sends keyless access without a key", async () => {
    expect(await searchWebDetailed(settings, "q", { fetchImpl: jsonFetch({ results: "no" }) }).catch((e) => e)).toMatchObject({
      kind: "bad_response",
    });
    const fetchImpl = jsonFetch({ results: [] });
    await searchWebDetailed({ keyless: true }, "q", { fetchImpl });
    const headers = new Headers(fetchImpl.mock.calls[0]![1]?.headers);
    expect(headers.get("X-Tavily-Access-Mode")).toBe("keyless");
    expect(headers.has("Authorization")).toBe(false);
  });
});

describe("extractPages", () => {
  const urls = ["https://a.example/route", "https://b.example/fares", "https://c.example/x"];

  it("sends one basic extract with the query and chunk count, and splits chunks on [...]", async () => {
    const usage: number[] = [];
    const fetchImpl = jsonFetch({
      results: [
        { url: "https://b.example/fares", raw_content: "## Fares\n\nBA  £412\t from London [...]   [...] second   chunk [...] third [...] fourth" },
        { url: "https://a.example/route", raw_content: `${"y".repeat(EXTRACT_CHUNK_MAX_CHARS + 50)} [...] short` },
        { url: "https://not-asked.example/", raw_content: "should be ignored" },
      ],
      failed_results: [{ url: "https://c.example/x", error: "Failed to fetch url" }],
      usage: { credits: 1 },
    });
    const result = await extractPages(settings, [...urls, urls[0]!], {
      query: "London to New York fares",
      chunksPerSource: 3,
      fetchImpl,
      onUsage: (c) => usage.push(c),
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.tavily.com/extract");
    expect(JSON.parse(String(init?.body))).toEqual({
      urls,
      query: "London to New York fares",
      chunks_per_source: 3,
      extract_depth: "basic",
      format: "markdown",
      include_images: false,
      include_favicon: false,
      include_usage: true,
      timeout: 25,
    });
    // The caller's order, only requested URLs, at most 3 chunks a page, each capped.
    expect(result.pages.map((p) => p.url)).toEqual(["https://a.example/route", "https://b.example/fares"]);
    expect(result.pages[1]!.chunks).toEqual(["## Fares\n\nBA £412 from London", "second chunk", "third"]);
    expect(result.pages[0]!.chunks[0]!.length).toBe(EXTRACT_CHUNK_MAX_CHARS);
    expect(result.failed).toEqual(["https://c.example/x"]);
    expect(usage).toEqual([1]);
  });

  it("caps the total text over all pages", async () => {
    const many = ["https://1.example/", "https://2.example/", "https://3.example/", "https://4.example/", "https://5.example/"];
    const big = Array(EXTRACT_MAX_CHUNKS_PER_SOURCE + 2).fill("z".repeat(EXTRACT_CHUNK_MAX_CHARS)).join(" [...] ");
    const fetchImpl = jsonFetch({ results: many.map((u) => ({ url: u, raw_content: big })) });
    const result = await extractPages(settings, many, { query: "q", chunksPerSource: 9, fetchImpl });
    const total = result.pages.reduce((sum, p) => sum + p.chunks.reduce((s, c) => s + c.length, 0), 0);
    expect(total).toBeLessThanOrEqual(EXTRACT_TOTAL_MAX_CHARS);
    expect(result.pages.every((p) => p.chunks.length <= EXTRACT_MAX_CHUNKS_PER_SOURCE)).toBe(true);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)).chunks_per_source).toBe(3);
  });

  it("refuses more than five URLs, skips unsafe ones and sends nothing for none", async () => {
    const fetchImpl = jsonFetch({ results: [] });
    await expect(
      extractPages(settings, ["https://1.e/", "https://2.e/", "https://3.e/", "https://4.e/", "https://5.e/", "https://6.e/"], { query: "q", fetchImpl }),
    ).rejects.toThrow(RangeError);
    expect(await extractPages(settings, ["javascript:alert(1)", "ftp://x/"], { query: "q", fetchImpl })).toEqual({ pages: [], failed: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps errors like searchWeb and uses keyless headers", async () => {
    for (const [status, kind] of [
      [401, "auth"],
      [432, "quota"],
      [500, "unavailable"],
    ] as const) {
      const error = await extractPages(settings, urls, { query: "q", fetchImpl: jsonFetch({ detail: "x" }, status) }).catch((e) => e);
      expect(error).toMatchObject({ provider: "tavily", kind, status });
    }
    expect(await extractPages(settings, urls, { query: "q", fetchImpl: jsonFetch({ nope: 1 }) }).catch((e) => e)).toMatchObject({
      kind: "bad_response",
    });
    const fetchImpl = jsonFetch({ results: [] });
    await extractPages({ keyless: true }, urls, { query: "q", fetchImpl });
    const headers = new Headers(fetchImpl.mock.calls[0]![1]?.headers);
    expect(headers.get("X-Tavily-Access-Mode")).toBe("keyless");
    expect(headers.has("Authorization")).toBe(false);
  });

  it("times out after its own deadline (30 s by default) and splits plain content", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    expect(await extractPages(settings, urls, { query: "q", fetchImpl, timeoutMs: 20 }).catch((e) => e)).toMatchObject({ kind: "timeout" });
    expect(splitChunks("a [...] [...] b", 3)).toEqual(["a", "b"]);
  });
});

describe("TAVILY_KEYLESS in config", () => {
  const base = { NEBIUS_API_KEY: "k", NODE_ENV: "test" as const };

  it("turns on keyless access only without a key and outside production", () => {
    expect(getAssistantConfig({ ...base, TAVILY_KEYLESS: "true" }).tavily).toEqual({ keyless: true });
    expect(getAssistantConfig({ ...base, TAVILY_KEYLESS: "1" }).tavily).toEqual({ keyless: true });
    expect(getAssistantConfig({ ...base, TAVILY_KEYLESS: "false" }).tavily).toBeNull();
    expect(getAssistantConfig(base).tavily).toBeNull();
    // A key always wins.
    expect(getAssistantConfig({ ...base, TAVILY_API_KEY: "tvly-x", TAVILY_KEYLESS: "true" }).tavily).toEqual({ apiKey: "tvly-x" });
    // Never in production, and not even read there.
    expect(getAssistantConfig({ ...base, NODE_ENV: "production", TAVILY_KEYLESS: "true" }).tavily).toBeNull();
    expect(getAssistantConfig({ ...base, NODE_ENV: "production", TAVILY_KEYLESS: "maybe" }).tavily).toBeNull();
  });

  it("names the variable for a value it cannot read", () => {
    try {
      getAssistantConfig({ ...base, TAVILY_KEYLESS: "maybe" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).missing).toEqual(["TAVILY_KEYLESS"]);
    }
  });

  it("is not on the Worker allow list", async () => {
    const source = readFileSync(join(__dirname, "..", "..", "scripts", "worker-env-rules.mjs"), "utf8");
    expect(source).not.toContain("TAVILY_KEYLESS");
  });
});
