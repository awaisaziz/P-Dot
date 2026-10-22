import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The root layout imports chat.css and then pages.css on every page, so a
// class both define is styled by whichever loads last. pages.css once gave
// the chat's starter grid the Today list's single column and font weight.

const ROOT = join(__dirname, "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

/** The class names a stylesheet's selectors use. Declaration blocks are always innermost, so one pass removes them. */
function selectorClasses(css: string): Set<string> {
  const selectors = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{[^{}]*\}/g, "{}");
  return new Set([...selectors.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map((match) => match[1]!));
}

describe("page stylesheets", () => {
  const chat = selectorClasses(read("src/app/styles/chat.css"));
  const pages = selectorClasses(read("src/app/styles/pages.css"));

  it("define no class in common, so neither restyles the other's page", () => {
    expect(chat.size).toBeGreaterThan(20);
    expect(pages.size).toBeGreaterThan(20);
    expect([...chat].filter((name) => pages.has(name))).toEqual([]);
  });

  it("give the chat and Today starters their own classes", () => {
    expect([...chat].filter((name) => name.includes("starter")).sort()).toEqual(["chat-starter", "chat-starter-list"]);
    expect([...pages].filter((name) => name.includes("starter")).sort()).toEqual([
      "today-starter",
      "today-starter-example",
      "today-starter-list",
      "today-starter-title",
    ]);
    expect(read("src/features/chat/ChatWorkspace.tsx")).toMatch(/className="chat-starter-list"/);
    expect(read("src/app/(workspace)/today/page.tsx")).toMatch(/className="today-starter-list"/);
  });
});
