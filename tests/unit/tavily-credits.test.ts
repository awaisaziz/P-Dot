import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  TAVILY_BASIC_SEARCH_CREDITS,
  TAVILY_MAX_RESERVATION_CREDITS,
  tavilyExtractCredits,
  tavilySearchCredits,
} from "@/server/assistant/spend";

// spend.ts is the only owner of Tavily credit prices (decision 0015, "Credits").

describe("Tavily credit prices", () => {
  it("prices a search by depth", () => {
    expect(tavilySearchCredits("basic")).toBe(1);
    expect(tavilySearchCredits("basic")).toBe(TAVILY_BASIC_SEARCH_CREDITS);
    expect(tavilySearchCredits("advanced")).toBe(2);
  });

  it("prices an extract at 1 credit per 5 URLs (basic) and 2 (advanced)", () => {
    for (const urls of [1, 2, 3, 4, 5]) {
      expect(tavilyExtractCredits(urls, "basic")).toBe(1);
      expect(tavilyExtractCredits(urls, "advanced")).toBe(2);
    }
  });

  it("refuses more than 5 URLs, no URLs, or a reservation above 2 credits", () => {
    expect(() => tavilyExtractCredits(6, "basic")).toThrow(RangeError);
    expect(() => tavilyExtractCredits(10, "advanced")).toThrow(RangeError);
    expect(() => tavilyExtractCredits(0, "basic")).toThrow(RangeError);
    expect(() => tavilyExtractCredits(2.5, "basic")).toThrow(RangeError);
    expect(TAVILY_MAX_RESERVATION_CREDITS).toBe(2);
    expect(tavilySearchCredits("advanced")).toBeLessThanOrEqual(TAVILY_MAX_RESERVATION_CREDITS);
  });
});

// Level 3: a test that reads the source and fails on a copy of the price.

const ROOT = join(__dirname, "..", "..");
const OWNER = "src/server/assistant/spend.ts";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|mjs)$/.test(entry.name) ? [path] : [];
  });
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** reserve("tavily", 1), reserve('tavily', 2.0), reserve(\n "tavily",\n (1)) ... */
const LITERAL_TAVILY_RESERVE = /\.reserve\(\s*(["'`])tavily\1\s*,\s*[-+(\s]*[0-9]/;

describe("Tavily credit owner", () => {
  it("finds a literal amount, so the check below can fail", () => {
    expect(LITERAL_TAVILY_RESERVE.test('await deps.spend.reserve("tavily", 1);')).toBe(true);
    expect(LITERAL_TAVILY_RESERVE.test("spend.reserve(\n  'tavily',\n  2,\n)")).toBe(true);
    expect(LITERAL_TAVILY_RESERVE.test("spend.reserve(`tavily`, (1))")).toBe(true);
    expect(LITERAL_TAVILY_RESERVE.test('spend.reserve("tavily", TAVILY_BASIC_SEARCH_CREDITS)')).toBe(false);
    expect(LITERAL_TAVILY_RESERVE.test('spend.reserve("tavily", tavilySearchCredits("basic"))')).toBe(false);
    expect(LITERAL_TAVILY_RESERVE.test('spend.reserve("nebius", 1)')).toBe(false);
  });

  it("is the only file that passes a number as the amount of a Tavily reservation", () => {
    const files = sourceFiles(join(ROOT, "src")).map((path) => relative(ROOT, path).split(sep).join("/"));
    expect(files).toContain(OWNER);
    const offenders = files.filter(
      (file) => file !== OWNER && LITERAL_TAVILY_RESERVE.test(withoutComments(readFileSync(join(ROOT, file), "utf8"))),
    );
    expect(
      offenders,
      `${offenders.join("\n")}\nOnly ${OWNER} prices Tavily credits. Use tavilySearchCredits, tavilyExtractCredits or TAVILY_BASIC_SEARCH_CREDITS.`,
    ).toEqual([]);
  });
});
