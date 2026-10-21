# 0013 — Integrating the AI layer, and a local simulation of the production stack

- Status: Proposed (2026-10-21). Built on the integration branch; needs the owner's review before it reaches `main`.
- Related: [0006 spend guard](0006-global-spend-guard.md), [0007 model routing](0007-model-routing.md), [0009 memory, documents and actions](0009-memory-documents-actions.md), [0011 approval modes](0011-approval-modes.md), [LOCAL-SIMULATION.md](../LOCAL-SIMULATION.md), [DEPLOYMENT-VM.md](../DEPLOYMENT-VM.md).

## Why

Three parts of P-Dot were built apart: the frontend (`awais/frontend`, already in `main`), the backend (`om/backend`, in `main`) and the AI layer (`tirth/ai-layer`, 21 commits not in `main`). The AI branch forked `main` before model routing, the spend guard and the decision 0009 storage landed. It had its own memory and document tables (`user_memories`, `user_documents`, `document_chunks` with `vector(4096)`), its own repositories, a single-model client with a fallback and no spend holds, and a tool loop that proposed actions as transient objects in the stream. Main's screens expect proposals and memory suggestions as rows (decision 0009) and its tests enforce one owner for the spend math. The two could not be merged file by file: a copy of the AI branch over `main` removed routing, the spend guard and the deployment settings.

## Decision

Keep `main`'s storage, routing, executor and spend guard, and rebuild the AI layer's features on them:

| AI branch feature | Where it lives now |
| --- | --- |
| Tool calling in the Nebius client | `src/server/providers/nebius/client.ts` streams `tool_calls` chunks; `ChatMessage` carries `tool_calls` and `tool_call_id`. The executor passes `tools` and `toolChoice` through and commits an attempt on a tool call, like a first token. |
| Multi-hop tool loop (AI-04, AI-05) | `src/server/assistant/service.ts`: at most `MAX_TOOL_HOPS` (3) model calls per reply, the last without tools. Each call has its own spend hold through `attemptBudget` (`src/server/assistant/complete.ts`). |
| `web_search` tool | `deps.search` (Tavily). One credit is reserved for each call; a refusal tells the model the limit was reached. Results are numbered after the toggle's results and go back inside `<web_search_results>`. |
| `search_documents`, `search_memories` | `RetrievalRepository` (`match_document_chunks`, `match_memories`, RLS) through the budgeted embedder. IDs go to the context record. |
| `save_memory` | A `memories` row with `status = 'proposed'`, `source = 'assistant'`, `source_message_id` = the user's message: the "Remember this?" card. |
| `propose_reminder`, `propose_task` | An `action_proposals` row (`create_reminder` with an ISO due time, `create_task`), validated with `actionPayloadSchema`: the approval card. Nothing runs without approval. |
| Memories in the prompt (AI-06) | Memories that match the message (`match_memories`, 5 at most) in the system message inside `<relevant_memories>`; their IDs in the context record. |
| Smart titles (AI-06b) | After the first exchange, one fast-tier call (`completeText`) names the conversation; the `title` event updates the list. |
| Session summarization (AI-06b) | `src/server/memory/summarizer.ts` and `POST /api/memories/summarize`: a fast-tier call extracts lasting facts; each new one becomes a `proposed` memory (near-duplicates of active memories and waiting suggestions are skipped). The chat calls it when a conversation is left and every sixth message. |
| Chain of thought events | The `thought` event: what the model said before a tool call, shown as a status line and cleared from the reply. |
| Evaluation suite (AI-02) | `tests/evals/` kept, with `npm run eval` (mock) and `npm run eval:live`. The runner calls the client directly and is not a test of the service. |
| Reports and roadmap | `docs/AI_*.md`, `docs/TEAM_ROADMAP.md`, `docs/pdf/`, `docs/decisions/0005-nebius-model-selection-and-audit.md` kept as written (note the duplicate number 0005). |

Not merged: the AI branch's three migrations, `src/server/rag/`, its `db/memories.ts` and `db/documents.ts`, its `summarize` route and the unit tests for them, and the live demo scripts that used its schema (`tests/evals/test-rag-live.ts`, `test-memory-live.ts`, `test-hallucination-live.ts`, with the `rag:demo`, `memory:demo` and `eval:hallucination` commands). The reports under `docs/` that mention those commands describe runs on the AI branch before the merge. The limits (`src/lib/limits.ts`) stay at `main`'s values, which the spend holds were sized for.

## Local simulation

A model ID with the `ollama/` prefix goes to a local [Ollama](https://ollama.com) server through its OpenAI-compatible API (`createOllamaProvider`, chosen per model by `createRoutedProvider`). It uses the same client, so streaming, usage parsing, the think filter, tool calls, retries, the breaker and the spend guard all run; the price is zero and the hold is the minimum one micro-dollar, so every call is still counted and settled. `OLLAMA_EMBEDDING_MODEL` embeds locally (the vector must have 1,024 numbers). `NEBIUS_FIRST_TOKEN_TIMEOUT_MS` replaces every tier's first-token timeout, because a local model loads on its first call (an 8B model needed more than the fast tier's 5 seconds on 2026-10-21). `NEBIUS_API_KEY` may be empty only when every chain is local and embeddings are local.

`Dockerfile` builds the standalone server; `docker-compose.yml` runs it against the local Supabase stack; `deploy/` runs it with its own Postgres, Supabase Auth, PostgREST, Kong and Caddy ([DEPLOYMENT-VM.md](../DEPLOYMENT-VM.md)). The server reads `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` at runtime when set, so one image serves every environment.

## Rules

- Every model call, tool search and embedding reserves spend first and settles after, including each hop and the title and summary calls. Only `src/server/assistant/spend.ts` prices a hold.
- Tool results, memories and document chunks are data inside delimiters, never instructions. Tags that look like the delimiters are neutralized before they are sent.
- A tool never changes an outside account. `save_memory` and the proposal tools create rows the user decides on; the assistant is told to say so.
- A model that keeps asking for tools still answers: the last hop offers none, and an empty final reply is an error, never a saved empty message.

## Open decisions

- **Autonomous web search.** The PRD says search-disabled requests do not call Tavily. With the tool loop the model may call `web_search` when the toggle is off (the AI branch's AI-04). It is bounded by the Tavily caps and one credit per call, but it is a change to the PRD's acceptance criterion. Keep it, or offer the tool only when the toggle is on?
- **Server-side Auto mode.** Decision 0011's recipe (run `create_own` proposals on the server when the request says `approvalMode: "auto"`) is not built; the browser still auto-approves eligible proposals when `done` arrives.
- **Summary triggers and cost.** The chat asks for a session summary when a conversation is left and every sixth message: one fast-tier call and one embedding per fact each time. Nebius cost is small (Lightning: about $0.0003 per summary) but it is a hidden call. Keep, make it a setting, or move it to a routine?
- **`embedding_model` in local mode.** Memories and chunks embedded by Ollama record the Nebius model name. A vector from one model is not comparable with the other, so a database must not mix them. A column value per embedder is the fix.
- **The first-token override.** `NEBIUS_FIRST_TOKEN_TIMEOUT_MS` applies to every tier. A per-tier setting, or one that applies only to `ollama/` models, would keep the production numbers exact when tiers are mixed.
- **Model choice for the tool loop locally.** `qwen3-vl:2b-instruct` does not emit tool calls through Ollama; `llama3.1:8b` does. The 2B model remains the default for speed; the guide says when to switch.
