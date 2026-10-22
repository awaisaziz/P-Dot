import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findChangelogErrors } from "../../scripts/changelog-rules.mjs";

const PR = "https://github.com/PATELOM925/P-Dot/pull/14";
const COMMIT = "https://github.com/PATELOM925/P-Dot/commit/e78ebc7";

function changelog(unreleased: string, dated = "") {
  return `# Changelog\n\nIntro text.\n\n## Unreleased\n\n### Added\n${unreleased}\n## 2026-10-19\n\n### Added\n${dated}`;
}

function messages(text: string) {
  return findChangelogErrors(text).map((error) => error.message);
}

describe("findChangelogErrors", () => {
  it("accepts a commit link to the awaisaziz/P-Dot fork", () => {
    const text = changelog(
      "- **Fork.** Problem: it broke. Resolution: it is fixed. [commit](https://github.com/awaisaziz/P-Dot/commit/0123abc)\n",
    );
    expect(messages(text)).toEqual([]);
  });

  it("passes sub-bullet entries, inline entries, nested resolutions and commit links", () => {
    const text = changelog(
      [
        `- **Sub-bullets.** ([PR #14](${PR}))`,
        "  - Problem: it broke.",
        "  - Resolution: it is fixed.",
        `- **Inline.** Problem: it broke. Resolution: it is fixed. [commit](${COMMIT})`,
        "",
        "- **Nested resolution.**",
        "  - Problem: it broke.",
        "  - Resolution:",
        "    - step one",
        `  - PR: [#14](${PR}).`,
        "",
        "### Fixed",
        `- **Under another heading.** Problem: a. Resolution: b. ${PR}`,
      ].join("\n"),
      "- An old entry with no Problem, Resolution or link.\n",
    );
    expect(findChangelogErrors(text)).toEqual([]);
  });

  it("refuses 'PR: not opened yet' and names the entry and line", () => {
    const text = changelog("- **Pending.** Problem: a. Resolution: b. PR: not opened yet.\n");
    const errors = findChangelogErrors(text);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ line: 8, title: "Pending." });
    expect(errors[0]?.message).toContain('replace "PR: not opened yet"');
  });

  it("asks for a link when there is none, and a review comment link does not count", () => {
    const text = changelog(
      [
        "- **No link.** Problem: a. Resolution: b.",
        `- **Review only.** Problem: a. Resolution: b. ([review](${PR}#issuecomment-1))`,
        "- **Other repo.** Problem: a. Resolution: b. https://github.com/someone/else/pull/3",
      ].join("\n"),
    );
    const found = messages(text);
    expect(found).toHaveLength(3);
    for (const message of found) expect(message).toContain("add a link to the pull request");
  });

  it("asks for a missing title, Problem and Resolution", () => {
    const text = changelog(
      [`- Plain text without a title. ${PR}`, `- **Only a title.** ${PR}`, "  - Resolution: b."].join("\n"),
    );
    const found = messages(text);
    expect(found).toEqual([
      expect.stringMatching(/"Plain text without a title.*\(line 8\): start the entry with a bold title/),
      expect.stringMatching(/\(line 8\): add a "Problem:" line/),
      expect.stringMatching(/\(line 8\): add a "Resolution:" line/),
      expect.stringMatching(/"Only a title\." \(line 9\): add a "Problem:" line/),
    ]);
  });

  it("refuses an empty Problem or Resolution", () => {
    const text = changelog([`- **Empty.** ${PR}`, "  - Problem:", "  - Resolution:", "  - Other: text"].join("\n"));
    const found = messages(text);
    expect(found).toHaveLength(2);
    expect(found[0]).toContain('the "Problem:" line is empty');
    expect(found[1]).toContain('the "Resolution:" line is empty');
  });

  it("does not take a label from a later entry", () => {
    const text = changelog([`- **First.** ${PR}`, `- **Second.** ${PR}`, "  - Problem: a.", "  - Resolution: b."].join("\n"));
    expect(messages(text)).toEqual([
      expect.stringContaining('"First." (line 8): add a "Problem:"'),
      expect.stringContaining('"First." (line 8): add a "Resolution:"'),
    ]);
  });

  it("refuses an inline Problem whose only text is the next label", () => {
    const found = messages(changelog(`- **Fix.** Problem: Resolution: fixed. [PR](${PR})\n`));
    expect(found).toEqual([expect.stringContaining('the "Problem:" line is empty')]);
  });

  it("refuses a nested Problem whose only child bullet is empty", () => {
    const found = messages(changelog([`- **Fix.** [PR](${PR})`, "  - Problem:", "    -", "  - Resolution: fixed."].join("\n")));
    expect(found).toEqual([expect.stringContaining('the "Problem:" line is empty')]);
  });

  it("does not count review comment links on a pull request or a commit", () => {
    const text = changelog(
      [
        `- **Files review.** Problem: a. Resolution: b. [review](${PR}/files#r123)`,
        `- **Commit comment.** Problem: a. Resolution: b. [comment](${COMMIT}#r123)`,
        `- **Commit path.** Problem: a. Resolution: b. ${COMMIT}/extra`,
      ].join("\n"),
    );
    const found = messages(text);
    expect(found).toHaveLength(3);
    for (const message of found) expect(message).toContain("add a link to the pull request");
  });

  it("counts a pull request link next to a review link", () => {
    const text = changelog(`- **Both.** Problem: a. Resolution: b. ([PR #14](${PR}), [review](${PR}#issuecomment-1)).\n`);
    expect(messages(text)).toEqual([]);
  });

  it("allows a blank line between Resolution and its nested bullet", () => {
    const text = changelog([`- **Fix.** [PR](${PR})`, "  - Problem: bad.", "  - Resolution:", "", "    - Fixed."].join("\n"));
    expect(messages(text)).toEqual([]);
  });

  it("does not take a label from inside a code span", () => {
    const text = changelog(
      [`- **Fix.** [PR](${PR})`, "  - Problem: `Resolution:` appeared twice.", "  - Resolution: remove the duplicate."].join("\n"),
    );
    expect(messages(text)).toEqual([]);
  });

  it("does not count a link inside a code span or a fenced code block", () => {
    const text = changelog(
      [
        `- **Code span.** Problem: bad. Resolution: fixed. \`${PR}\``,
        "- **Code block.** Problem: bad. Resolution: fixed.",
        "  ```",
        `  ${PR}`,
        "  ```",
      ].join("\n"),
    );
    const found = messages(text);
    expect(found).toHaveLength(2);
    for (const message of found) expect(message).toContain("add a link to the pull request");
  });

  it("does not count a GitHub link inside another website's link destination", () => {
    const text = changelog(`- **Fix.** Problem: bad. Resolution: fixed. [other](https://example.org/?next=${PR})\n`);
    expect(messages(text)).toEqual([expect.stringContaining("add a link to the pull request")]);
  });

  it("counts a bare link in parentheses", () => {
    expect(messages(changelog(`- **Bare.** Problem: bad. Resolution: fixed. (${PR}).\n`))).toEqual([]);
  });

  it("counts a commit link with uppercase hex", () => {
    const link = "https://github.com/PATELOM925/P-Dot/commit/E78EBC7";
    expect(messages(changelog(`- **Upper.** Problem: bad. Resolution: fixed. [commit](${link})\n`))).toEqual([]);
  });

  it("fails when the Unreleased section is missing", () => {
    expect(messages("# Changelog\n\n## 2026-10-19\n")[0]).toContain('no "## Unreleased" section');
  });
});

describe("check-changelog script", () => {
  const SCRIPT = resolve("scripts/check-changelog.mjs");
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  function run(text: string) {
    dir = mkdtempSync(join(tmpdir(), "pdot-changelog-"));
    const file = join(dir, "CHANGELOG.md");
    writeFileSync(file, text);
    return spawnSync(process.execPath, [SCRIPT, file], { encoding: "utf8" });
  }

  it("exits 1 with the entry title on a bad entry", () => {
    const result = run(changelog("- **Bad.** PR: not opened yet.\n"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CHANGELOG entry "Bad." (line 8)');
  });

  it.each(["*", "+"])("exits 1 on a top-level entry that starts with %s", (marker) => {
    const result = run(changelog(`${marker} Plain entry. PR: not opened yet.\n`));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('start the entry with "- "');
    expect(result.stderr).toContain('replace "PR: not opened yet"');
  });

  it("exits 0 on good entries", () => {
    const result = run(changelog(`- **Good.** Problem: a. Resolution: b. ${PR}\n`));
    expect(result.status).toBe(0);
  });
});
