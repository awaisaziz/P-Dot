import type { Metadata } from "next";
import Link from "next/link";
import { DocumentsPanel } from "@/features/documents/DocumentsPanel";
import { MemoryList } from "@/features/memory/MemoryList";
import { DOCUMENT_LIST_LIMIT, MEMORY_LIST_LIMIT } from "@/lib/limits";
import { requireAuth } from "@/server/auth/session";
import { createDocumentRepository } from "@/server/db/documents";
import { createMemoryRepository } from "@/server/db/memories";

export const metadata: Metadata = { title: "What P-Dot remembers · P-Dot" };

export default async function MemoryPage() {
  const auth = await requireAuth("/memory");
  const [memories, documents] = await Promise.all([
    createMemoryRepository(auth.supabase).listMemories(auth.userId, undefined, MEMORY_LIST_LIMIT),
    createDocumentRepository(auth.supabase).listDocuments(auth.userId, DOCUMENT_LIST_LIMIT),
  ]);

  return (
    <main className="page stack">
      <div className="page-intro">
        <h1>What P-Dot remembers</h1>
        <p className="muted">Memories and documents P-Dot keeps about you; change or delete any of it.</p>
      </div>

      <p className="hint">Replies that use them list them under &ldquo;What was sent&rdquo;.</p>

      <MemoryList initialMemories={memories} />

      <DocumentsPanel initialDocuments={documents} />

      <p className="hint">
        Changes are recorded in the <Link href="/action-log">action log</Link>, without their text.
      </p>
    </main>
  );
}
