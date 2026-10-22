// Builds the POST /api/chat body. Pure, so it is unit-tested (tests/unit/chat-ui-request.test.ts).
import type { ChatRequest, Effort } from "@/types/api";

/** Same rule as the server's schema (src/lib/schemas.ts); a zone it would refuse is left out instead. */
const TIME_ZONE = /^[A-Za-z0-9_+\-/]{1,64}$/;

/** The browser's IANA time zone, or undefined when it is missing or not one the server accepts. */
export function requestTimeZone(read: () => string | undefined = browserTimeZone): string | undefined {
  try {
    const zone = read()?.trim();
    return zone && TIME_ZONE.test(zone) ? zone : undefined;
  } catch {
    return undefined;
  }
}

function browserTimeZone(): string | undefined {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export interface ChatRequestInput {
  action: "send" | "retry";
  message: string;
  conversationId: string | null;
  webSearch: boolean;
  effort: Effort;
  timeZone: string | undefined;
  /** The Google chip is on and Google is connected. */
  google: boolean;
}

/** The request body. Every send and retry carries the time zone and the Google chip. */
export function buildChatRequest(input: ChatRequestInput): ChatRequest | null {
  const options = {
    webSearch: input.webSearch,
    effort: input.effort,
    ...(input.timeZone ? { timeZone: input.timeZone } : {}),
    connectors: { google: input.google },
  };
  if (input.action === "retry") {
    return input.conversationId ? { action: "retry", conversationId: input.conversationId, ...options } : null;
  }
  return {
    action: "send",
    message: input.message,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...options,
  };
}
