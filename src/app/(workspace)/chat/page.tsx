import type { Metadata } from "next";
import { ChatWorkspace } from "@/features/chat/ChatWorkspace";
import { draftFromQuery } from "@/features/chat/starters";

export const metadata: Metadata = { title: "Chat · P-Dot" };

interface ChatPageProps {
  searchParams: Promise<{ c?: string | string[]; q?: string | string[] }>;
}

export default async function ChatPage({ searchParams }: ChatPageProps) {
  const { c, q } = await searchParams;
  // `q` (a starter from Today) goes into the message box once; the user sends it.
  return <ChatWorkspace initialConversationId={typeof c === "string" ? c : null} initialDraft={draftFromQuery(q)} />;
}
