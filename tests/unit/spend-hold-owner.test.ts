import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

// One owner for "worst-case hold for a Nebius call". A second copy of the hold
// math reduced a required hold before (PR #6, 0dce68a), so other files must call the owner.

const ROOT = join(__dirname, "..", "..");
const OWNER = "src/server/assistant/spend.ts";
const PRICING = "src/server/providers/nebius/pricing.ts";
const FIX =
  `Only ${OWNER} may compute a Nebius hold. Use nebiusHoldMicroUsd (chat) or ` +
  "nebiusEmbeddingHoldMicroUsd (embeddings) for the hold, and nebiusSettleMicroUsd for the settle. " +
  "They refuse a hold above the ceiling with NebiusHoldTooLargeError and never reduce it.";

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

describe("Nebius hold owner", () => {
  it("is the only file that uses the hold ceiling or prices a hold", () => {
    // Forward slashes on every platform, so the owner paths above match on Windows too.
    const files = sourceFiles(join(ROOT, "src")).map((path) => relative(ROOT, path).split(sep).join("/"));
    expect(files).toContain(OWNER);

    expect(files).toContain(PRICING);

    const offenders: string[] = [];
    for (const file of files) {
      if (file === OWNER) continue;
      let code = withoutComments(readFileSync(join(ROOT, file), "utf8"));
      // pricing.ts may declare costMicroUsd. Any other use there is a second hold owner.
      if (file === PRICING) code = code.replace(/export function costMicroUsd\(/, "");
      if (/\bMAX_NEBIUS_HOLD_MICRO_USD\b/.test(code)) offenders.push(`${file}: MAX_NEBIUS_HOLD_MICRO_USD`);
      if (/\bcostMicroUsd\b/.test(code)) offenders.push(`${file}: costMicroUsd`);
      if (/\b250_?000\b/.test(code)) offenders.push(`${file}: the ceiling as a number`);
    }
    expect(offenders, `${offenders.join("\n")}\n${FIX}`).toEqual([]);
  });
});
