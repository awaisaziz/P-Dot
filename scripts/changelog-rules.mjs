// Rules for each top-level entry under "## Unreleased" in CHANGELOG.md (AGENTS.md, pull requests section).
// Dated sections are not checked: entries from before this check use an older shape.

const REPO = "https://github.com/PATELOM925/P-Dot";
// The team repository, and Awais Aziz's fork, where work lands on main without a pull request.
const ACCEPTED_LINK = /^https:\/\/github\.com\/(?:PATELOM925|awaisaziz)\/P-Dot\/(?:pull\/\d+|commit\/[0-9a-fA-F]{7,40})$/;
const TITLE = /^- \*\*(.+?)\*\*/;
const LABEL = /\b(?:Problem|Resolution):/;
const HAS_TEXT = /[\p{L}\p{N}]/u;

function hasAcceptedLink(body) {
  const destinations = [...body.matchAll(/\]\(([^()\s]*)\)/g)].map((match) => match[1]);
  const bare = body.replace(/\]\([^()\s]*\)/g, "]").match(/https?:\/\/[^\s<>()[\]]+/g) ?? [];
  return [...destinations, ...bare].some((url) => ACCEPTED_LINK.test(url.replace(/[.,;:]+$/, "")));
}

function withoutCode(lines) {
  let fenced = false;
  return lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line.text)) {
      fenced = !fenced;
      return { ...line, text: "" };
    }
    return { ...line, text: fenced ? "" : line.text.replace(/(`+)[\s\S]*?\1/g, "code") };
  });
}

function fieldText(text, label) {
  const at = text.search(new RegExp(`\\b${label}:`));
  if (at === -1) return null;
  const rest = text.slice(at + label.length + 1);
  const next = rest.search(LABEL);
  return next === -1 ? rest : rest.slice(0, next);
}

function hasTextChild(lines, index) {
  const indent = lines[index].text.search(/\S/);
  const child = lines.slice(index + 1).find((line) => line.text.trim() !== "");
  if (!child || child.text.search(/\S/) <= indent) return false;
  const match = /^\s*[-*+]\s+(.*)$/.exec(child.text);
  return Boolean(match && HAS_TEXT.test(match[1]));
}

function labelStatus(lines, label) {
  const afterTitle = lines[0].text.replace(TITLE, "");
  const inline = fieldText(afterTitle, label);
  if (inline !== null) return HAS_TEXT.test(inline) ? null : "empty";
  const index = lines.findIndex((line, i) => i > 0 && new RegExp(`^\\s+- ${label}:`).test(line.text));
  if (index === -1) return "missing";
  const text = fieldText(lines[index].text, label) ?? "";
  if (HAS_TEXT.test(text)) return null;
  return hasTextChild(lines, index) ? null : "empty";
}

function checkEntry(entry) {
  const first = entry[0];
  const lines = withoutCode(entry);
  const title = TITLE.exec(first.text)?.[1] ?? first.text.slice(2, 62).trim();
  const at = `CHANGELOG entry "${title}" (line ${first.number})`;
  const errors = [];
  const add = (message) => errors.push({ line: first.number, title, message: `${at}: ${message}` });

  if (!/^- /.test(first.text)) add('start the entry with "- ", not "*" or "+".');
  if (!TITLE.test(first.text)) add('start the entry with a bold title: "- **What changed.**".');
  for (const label of ["Problem", "Resolution"]) {
    const result = labelStatus(lines, label);
    if (result === "missing")
      add(`add a "${label}:" line, as a sub-bullet "  - ${label}: ..." or after the bold title on the same line.`);
    if (result === "empty") add(`the "${label}:" line is empty. Write the ${label.toLowerCase()} after the label.`);
  }

  const body = lines.map((line) => line.text).join("\n");
  if (/PR:\s*not opened yet/i.test(body))
    add(`replace "PR: not opened yet" with the pull request link (${REPO}/pull/N). Open the pull request first.`);
  else if (!hasAcceptedLink(body))
    add(
      `add a link to the pull request (${REPO}/pull/N), or, if there was no pull request, to the commit (${REPO}/commit/<sha>). A link to a review comment does not count.`,
    );
  return errors;
}

export function findChangelogErrors(text) {
  const all = text.split(/\r?\n/).map((line, i) => ({ text: line, number: i + 1 }));
  const start = all.findIndex((line) => /^## Unreleased\s*$/.test(line.text));
  if (start === -1)
    return [{ line: 1, title: "", message: 'CHANGELOG.md has no "## Unreleased" section. Add it above the newest dated section.' }];

  const section = [];
  for (const line of all.slice(start + 1)) {
    if (/^## /.test(line.text)) break;
    section.push(line);
  }

  const entries = [];
  let current = null;
  for (const line of section) {
    if (/^[-*+] /.test(line.text)) {
      current = [line];
      entries.push(current);
    } else if (/^#/.test(line.text)) {
      current = null;
    } else if (current && (line.text.trim() === "" || /^\s/.test(line.text))) {
      current.push(line);
    } else if (line.text.trim() !== "") {
      current = null;
    }
  }
  return entries.flatMap(checkEntry);
}
