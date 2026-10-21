# P-Dot Team Roadmap & Cross-Role Handoff Notes

This document aligns Person A (Frontend), Person B (Backend/Database/Infra), and Person C (AI Layer) on current progress, architectural contracts, and upcoming tasks.

---

## 1. Notes for Person A (Frontend & Apps)

### What the AI Layer is sending now
- **NDJSON Streaming**: The `/api/chat` route streams JSON chunks:
  - `{ "type": "delta", "text": "..." }` for partial text.
  - `{ "type": "search", "status": "used" | "failed" | "no_results", "sources": [{ "title": "...", "url": "..." }] }` when web search is invoked.
  - `{ "type": "done", "conversationId": "...", "messageId": "..." }` on completion.

### Immediate Frontend Needs
1. **FE-02: Safe Markdown & Citation Badges (High Priority)**
   - **Current State**: `MessageView.tsx` renders text directly via `<div className="message-content">{message.content}</div>`. Plain text only.
   - **Requirement**: Use a safe markdown renderer (e.g., `react-markdown` with `rehype-sanitize`) and syntax highlighting for code blocks with a "Copy" button.
   - **Citation Links**: Model outputs citations as `[1]`, `[2]`. Render these as clickable superscript badges that scroll to or highlight the corresponding item in the `SourceList`.

2. **FE-04: Action Cards (Approve / Edit / Cancel)**
   - When the assistant outputs structured actions (e.g. creating a reminder or saving a task), the UI should render an interactive Card with:
     - Action type and details (e.g., "Set Reminder: Call Doctor at 9:00 AM").
     - **Approve**, **Edit**, and **Cancel** buttons.
     - Confirmation state once approved.

3. **FE-05: "What P-Dot Remembers" & Document Screen**
   - A settings screen listing all items from `user_memories` with an option to delete or edit memories.
   - A document upload screen allowing users to drag-and-drop PDFs/TXT files to be indexed for RAG.

---

## 2. Notes for Person B (Backend, Supabase & Infra)

### Immediate Database & Infrastructure Needs
1. **Enable `pgvector` Extension**
   - Needed for **AI-05 (Vector RAG)** and **AI-06 (Long-term Memory)**.
   - Add to a new migration:
     ```sql
     create extension if not exists vector;
     ```

2. **New Tables Required in Supabase Migrations**
   - **`user_profiles`**:
     - `user_id` (uuid references auth.users), `full_name`, `timezone`, `preferences` (jsonb), `created_at`, `updated_at`.
   - **`user_memories`**:
     - `id` (uuid), `user_id` (uuid), `content` (text), `category` (text), `embedding` (vector(4096) for Qwen3-Embedding-8B or vector(1024)), `created_at`.
   - **`user_tasks` / `user_reminders`**:
     - `id` (uuid), `user_id` (uuid), `title` (text), `due_at` (timestamptz), `status` ('pending', 'completed', 'dismissed'), `created_at`.
   - **`user_documents` & `document_chunks`**:
     - `user_documents`: `id`, `user_id`, `filename`, `file_path`, `file_size`, `mime_type`, `created_at`.
     - `document_chunks`: `id`, `document_id`, `user_id`, `chunk_index`, `content`, `embedding` (vector), `created_at`.

3. **Supabase Storage Bucket**
   - Create a private bucket: `documents`.
   - Add RLS policy: users can only upload, read, and delete objects in their own folder (`auth.uid() = (storage.foldername(name))[1]`).

4. **Cloudflare Worker Keepalive / Streaming Timeouts**
   - Ensure streaming responses on Cloudflare Workers flush keepalive heartbeats if tool execution (search or RAG) takes >5 seconds.

---

## 3. Person C (AI Layer) — Master TODO & Roadmap

### Completed:
- [x] **AI-01: Nebius Model Audit & Selection**
  - Confirmed active model: `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`.
  - Audited pricing: $0.06 / $0.24 per 1M tokens (~189k turns for $25 budget).
  - Confirmed tool-calling support and EU zero-training data retention.
  - Documented in `docs/decisions/0005-nebius-model-selection-and-audit.md`.
- [x] **AI-04: Multi-hop Autonomous Tool Calling & Action Proposal System**
  - Implemented multi-hop tool execution loop with strict attempt budgeting (up to 2 attempts per turn).
  - Explicit attempt instructions provided to model in system prompt and tool feedback context.
  - Implemented `propose_reminder` and `propose_task` tools emitting `{ type: "action", action }` events for interactive frontend cards (FE-04).
  - Normalization of Unicode non-breaking spaces and Asian citation brackets `【n】` to standard `[n]`.
  - Added unit test suite in `tests/unit/assistant-tools.test.ts` (129/129 unit tests passing).

- [x] **AI-05: Vector RAG (Personal Document Search & Ingestion)**
  - Integrated Nebius `Qwen/Qwen3-Embedding-8B` (4096 dimensions, $0.01 / 1M tokens) via `src/server/providers/nebius/embeddings.ts`.
  - Implemented recursive character text chunker with priority separators and overlap (`src/server/rag/chunker.ts`).
  - Added Supabase migration `20261020000000_vector_rag_documents.sql` featuring `pgvector`, HNSW cosine index, and `match_document_chunks` RPC.
  - Implemented `DocumentRepository` (`src/server/db/documents.ts`) and ingestion orchestrator (`src/server/rag/ingestion.ts`).
  - Implemented autonomous `search_documents` tool in multi-hop assistant loop with document source citations `[n]` (`src/server/assistant/service.ts`).
  - Implemented `/api/documents` REST endpoints for upload, listing, and deletion.
  - Unit test suite expanded to 155 passing tests across 14 suites (`npm run check` 100% clean).

- [x] **AI-05b: Hallucination Prevention & Factual Rigor Suite**
  - Built comprehensive unit guardrail test suite in `tests/unit/hallucination.test.ts` (10 tests covering: orphan citation prohibition, empty retrieval honesty, sycophancy refutation, unmentioned entity containment, adversarial document injection neutralization, UTC temporal grounding, and cross-source multi-tool citation integrity).
  - Built live model evaluation benchmark in `tests/evals/test-hallucination-live.ts` (`npm run eval:hallucination`) testing anachronisms, fictional treaties, general knowledge citations, missing document facts, and prompt injection resistance.
  - Verified 100% (5/5) pass rate against live Nebius Token Factory (`nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`).

- [x] **AI-06: Long-Term Memory System (Personal Fact Extraction & Retrieval)**
  - Created Supabase migration `20261020000001_user_memories.sql` with `user_memories` table (4096-dimensional vectors), `match_user_memories` RPC, and RLS policies.
  - Implemented `MemoryRepository` (`src/server/db/memories.ts`) with Supabase pgvector client and mock test repository.
  - Implemented autonomous `save_memory` and `search_memories` tools in multi-hop assistant loop (`src/server/assistant/tools.ts`, `service.ts`).
  - Built hybrid memory architecture: semantic pre-retrieval on every turn injecting `<relevant_memories>` into the system prompt.
  - Built REST API endpoints: `GET /api/memories`, `POST /api/memories`, `DELETE /api/memories/[id]`.
  - Added unit test suite in `tests/unit/memories.test.ts` (171/171 tests passing across 16 test suites).
  - Verified live recall with `npm run memory:demo` (`tests/evals/test-memory-live.ts`), successfully recalling user allergies and personal preferences.

- [x] **AI-06b: Episodic Session Summarization (Offline / End-of-Session Memory Distillation)**
  - Implemented `src/server/memory/summarizer.ts` with atomic fact extraction across 4 core categories (`preference`, `work`, `personal`, `fact`).
  - Added strict negative guardrails against transient questions, assistant suggestions, and secret/credential scrubbing (`scrubSensitiveData`).
  - Implemented semantic deduplication and conflict resolution (`deduplicateAndPersistMemories`): updates existing memories when cosine similarity $\ge 0.85$, avoiding duplicate bloat.
  - Added `updateMemory` method to `MemoryRepository` across Supabase pgvector and in-memory test mocks.
  - Implemented `POST /api/memories/summarize` route for out-of-band asynchronous processing.
  - Integrated fire-and-forget background triggers in `ChatWorkspace.tsx` on conversation switches, new chat creation, and periodic turn milestones.
  - Added unit test suite in `tests/unit/session-summary.test.ts` (179/179 tests passing across 17 test suites, 0 lint warnings, 0 typecheck errors).

### Upcoming Steps:
- [ ] **AI-07: Calendar & Action Proposal Execution Engine**
  - Connect Person A's interactive Action Cards (`approve`, `edit`, `cancel`) to database operations for reminders and tasks (`user_reminders`, `user_tasks`).
