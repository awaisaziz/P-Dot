import "server-only";

// Untrusted text (page titles, quotes, page text, file names, event titles)
// goes into the workflow blocks with every angle bracket replaced, so no
// field can open or close a tag the prompt uses (decision 0015, "Encoding").

/** ASCII and look-alike angle brackets: < > ＜ ＞ ﹤ ﹥ 〈 〉 ⟨ ⟩ 〈 〉. */
const OPEN = /[<＜﹤〈⟨〈]/g;
const CLOSE = /[>＞﹥〉⟩〉]/g;

// Control characters other than tab and newline, and the bidi controls.
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F‪-‮⁦-⁩]/g;

/** Cuts to at most `max` UTF-16 units without splitting a surrogate pair. */
export function cutChars(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/**
 * Replaces angle brackets with ‹ and ›, drops control characters and caps the
 * length. A field that was cut ends with "…". Keeps line breaks.
 */
export function encodeUntrusted(text: string, maxChars: number): string {
  const encoded = text.replace(CONTROL, "").replace(/\r\n?/g, "\n").replace(OPEN, "‹").replace(CLOSE, "›");
  if (encoded.length <= maxChars) return encoded;
  return `${cutChars(encoded, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/** The same, on one line: line breaks and runs of spaces become one space. */
export function encodeLine(text: string, maxChars: number): string {
  return encodeUntrusted(text.replace(/\s+/g, " ").trim(), maxChars);
}

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Joins `head`, as many `body` lines as fit, and `tail`, so the whole text is
 * at most `maxBytes` UTF-8 bytes. Lines that do not fit are left out and
 * counted; `omitted(n)` gives the line that says so. Throws when the head and
 * tail alone do not fit, which is a bug in the caller's caps.
 */
export function fitLines(
  head: string[],
  body: string[],
  tail: string[],
  maxBytes: number,
  omitted: (count: number) => string,
): string {
  const join = (lines: string[]) => lines.join("\n");
  const fixed = utf8Bytes(join([...head, ...tail])) + utf8Bytes(omitted(body.length)) + 2;
  if (fixed > maxBytes) throw new RangeError("the fixed part of a block is larger than its byte cap");
  let used = fixed;
  const kept: string[] = [];
  for (const line of body) {
    const size = utf8Bytes(line) + 1;
    if (used + size > maxBytes) break;
    kept.push(line);
    used += size;
  }
  const dropped = body.length - kept.length;
  return join([...head, ...kept, ...(dropped > 0 ? [omitted(dropped)] : []), ...tail]);
}
