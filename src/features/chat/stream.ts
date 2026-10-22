import type { ChatStreamEvent } from "@/types/api";

const EVENT_TYPES = new Set(["start", "search", "thought", "step", "result", "delta", "title", "done", "error"]);

function hasStringType(value: unknown): value is { type: string } {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

export class StreamFormatError extends Error {
  constructor() {
    super("The server sent an unreadable response.");
    this.name = "StreamFormatError";
  }
}

/**
 * Parses a newline-delimited JSON response body into chat stream events.
 * An event with an unknown string type is skipped, so a newer server does not
 * break an older tab. Malformed JSON or a missing type still throws.
 */
export async function* readChatStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const parse = (line: string): ChatStreamEvent | null => {
    const trimmed = line.trim();
    if (!trimmed) return null;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      throw new StreamFormatError();
    }
    if (!hasStringType(value)) throw new StreamFormatError();
    if (!EVENT_TYPES.has(value.type)) return null;
    return value as ChatStreamEvent;
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const event = parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (event) yield event;
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    const last = parse(buffer);
    if (last) yield last;
  } finally {
    reader.cancel().catch(() => {});
  }
}
