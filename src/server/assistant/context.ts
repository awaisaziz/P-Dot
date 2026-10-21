import "server-only";
import type { MessageRole } from "@/types/api";

export interface HistoryMessage {
  role: MessageRole;
  content: string;
}

/**
 * Selects the most recent messages that fit within `charBudget`, newest first,
 * then returns them in chronological order. The latest message is always kept.
 * Consecutive messages with the same role (e.g. a user message whose reply
 * failed) are merged, and the window always starts with a user message, since
 * many chat templates require user/assistant alternation.
 */
export function buildContextWindow(history: HistoryMessage[], charBudget: number): HistoryMessage[] {
  const merged: HistoryMessage[] = [];
  for (const message of history) {
    const previous = merged.at(-1);
    if (previous && previous.role === message.role) {
      merged[merged.length - 1] = { role: message.role, content: `${previous.content}\n\n${message.content}` };
    } else {
      merged.push({ ...message });
    }
  }

  const selected: HistoryMessage[] = [];
  let used = 0;
  for (let index = merged.length - 1; index >= 0; index -= 1) {
    const message = merged[index]!;
    const isLatest = index === merged.length - 1;
    if (!isLatest && used + message.content.length > charBudget) break;
    if (isLatest && message.content.length > charBudget) {
      // Keep the end of an oversized latest message (the question is usually last).
      selected.push({ role: message.role, content: message.content.slice(-charBudget) });
      used = charBudget;
      continue;
    }
    selected.push(message);
    used += message.content.length;
  }
  selected.reverse();

  while (selected.length > 1 && selected[0]!.role !== "user") selected.shift();
  return selected;
}

/** Derives a conversation title from its first message. */
export function titleFromMessage(message: string, maxChars = 60): string {
  const collapsed = message.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return "New conversation";
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars - 1).trimEnd()}…` : collapsed;
}

/** The system message for naming a conversation from its first message. */
export const SMART_TITLE_SYSTEM_PROMPT =
  "You name conversations. Reply with only a title of 2 to 5 words that says what the user's message is about. No quotation marks, no punctuation at the end, no words such as 'Title:' or 'Sure'. Examples: Tokyo trip planning, React hook cleanup, Weekly meal ideas.";

/**
 * A usable title from a model's reply, or null when the reply is not one:
 * the first line, without quotes, Markdown marks or a "Title:" prefix, from 2
 * to 60 characters. The caller keeps the old title on null.
 */
export function smartTitleFromText(raw: string): string | null {
  const firstLine = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return null;
  const cleaned = firstLine
    .replace(/^(?:title|topic|subject|chat title)\s*[:\-]\s*/i, "")
    .replace(/["'*_#`«»“”‘’]/g, "")
    .replace(/[.!?:;,]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length < 2 || cleaned.length > 60) return null;
  if (/^(new conversation|untitled)$/i.test(cleaned)) return null;
  return cleaned;
}
