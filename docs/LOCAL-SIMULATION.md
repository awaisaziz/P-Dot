# Local simulation: the production stack on your computer

This guide runs the whole product on one computer with no paid provider: the frontend and backend (the Next.js app), the database and accounts (the local Supabase stack), and the AI layer with a local model standing in for Nebius. The point is to exercise the exact code that runs in production: the same OpenAI-compatible client, model routing, spend guard, tool loop, memory retrieval and document search. Only the address the model calls go to changes.

| Production | Local stand-in | How it is chosen |
| --- | --- | --- |
| Nebius Token Factory (chat models) | [Ollama](https://ollama.com) with `qwen3-vl:2b-instruct` | A model ID with the `ollama/` prefix in a tier's chain |
| Nebius embeddings (`Qwen/Qwen3-Embedding-8B`, 1,024 dimensions) | Ollama with `qwen3-embedding:0.6b` (1,024 dimensions) | `OLLAMA_EMBEDDING_MODEL` |
| Tavily web search | Tavily itself, through its free keyless access (capped by Tavily), or your own key | `TAVILY_KEYLESS=true` with no key (development only), or `TAVILY_API_KEY` |
| Google connector | A Google Cloud OAuth client in Testing mode with `http://localhost:3000/api/connectors/google/callback` as a redirect URI | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `CONNECTOR_TOKEN_KEYS`, `CONNECTOR_ALLOWED_USER_IDS` ([DEPLOYMENT.md](DEPLOYMENT.md), one-time setup step 7) |
| Hosted Supabase | The local Supabase stack (`npm run db:start`) | `NEXT_PUBLIC_SUPABASE_URL` |
| Cloudflare Worker | `npm run dev`, or the Docker image | — |

A local model with the `ollama/` prefix is priced at zero, so the spend guard holds and settles the minimum amount for each call: every call is still counted, as in production.

## 1. Requirements

- Node.js 22 or newer, Docker Desktop (for Supabase and the optional container), and [Ollama](https://ollama.com/download).
- Models (about 2.5 GB in all):

  ```bash
  ollama pull qwen3-vl:2b-instruct
  ollama pull qwen3-embedding:0.6b
  ```

  `qwen3-vl:2b-instruct` is small and fast, but it does not call tools through Ollama (checked on 2026-10-21: it answers "I've remembered…" without calling `save_memory`). To see the tool loop (web search, document search, memory suggestions, task and reminder proposals), use a model that does, for example `ollama pull llama3.1:8b` and put `ollama/llama3.1:8b` in the fast tier. The 2B model still exercises streaming, routing, titles, memory retrieval into the prompt and the spend guard.

  The grounded workflows (flight checks and verified research, [decision 0015](decisions/0015-grounded-workflows.md)) need a tool-capable model in the **standard** tier too, because their extraction step runs there. Ollama ignores a named `tool_choice`, so a model that answers in text instead of calling the extraction tool makes that step fail ("Could not read the results"); the workflow then shows no fare rather than an unverified one. Workflow prompts are long (up to 12,000 characters of page text), and Ollama's default context window cuts the start of a long prompt, so start Ollama with a larger window: `OLLAMA_CONTEXT_LENGTH=16384 ollama serve`.

## 2. Start the database and accounts

```bash
npm install
npm run db:start
```

The first run downloads the Supabase images. `npm run db:status` prints the API URL (`http://127.0.0.1:54321`), the publishable key, Studio (`http://127.0.0.1:54323`) and the fake inbox for confirmation emails (`http://127.0.0.1:54324`). If the stack was started before a migration was added, apply the new ones without losing data:

```bash
npx supabase migration up --local
```

## 3. Configure `.env.local`

```env
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable key from db:status>
SITE_URL=http://localhost:3000

# Every tier on the local model. Mix tiers freely, for example only the heavy tier on Nebius.
NEBIUS_FAST_MODELS=ollama/qwen3-vl:2b-instruct
NEBIUS_STANDARD_MODELS=ollama/qwen3-vl:2b-instruct
NEBIUS_HEAVY_MODELS=ollama/qwen3-vl:2b-instruct
NEBIUS_VISION_MODELS=ollama/qwen3-vl:2b-instruct
NEBIUS_HEDGE_AFTER_MS=0
OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
OLLAMA_EMBEDDING_MODEL=qwen3-embedding:0.6b

# Leave empty for a pure local run. A Nebius key is required as soon as any tier or the
# embeddings use Nebius. A Tavily key turns on web search (the toggle and the web_search tool).
NEBIUS_API_KEY=
TAVILY_API_KEY=
# Development only: with no Tavily key, use Tavily's free keyless access (capped by Tavily).
# Ignored when NODE_ENV is production, and a deploy stops if it is set.
TAVILY_KEYLESS=true
```

Rules the configuration enforces:

- A chain may mix `ollama/...` and Nebius models. Every Nebius model needs a price in `src/server/providers/nebius/pricing.ts`; an `ollama/` model is free.
- `NEBIUS_API_KEY` may be empty only when every chain is local **and** `OLLAMA_EMBEDDING_MODEL` is set. Otherwise chat answers "This service is not configured yet."
- The embedding model must return 1,024 numbers (the database column is `vector(1024)`). `qwen3-embedding:0.6b` does; a model that returns another size fails the request with `bad_response`.
- In local mode the `embedding_model` column of memories and document chunks still records the Nebius model name. Vectors from the two models are not comparable, so do not mix a local database with Nebius embeddings.

## 4. Run and check

```bash
npm run dev
```

1. `curl http://localhost:3000/api/health` shows `{"configured":{"auth":true,"inference":true,"webSearch":false}}` (`webSearch` is true once a Tavily key is set).
2. Open http://localhost:3000, create an account, open the confirmation email in the fake inbox (`http://127.0.0.1:54324`) and click the link.
3. Send a message. The reply streams, the conversation gets a title, and the line under the reply names the model (`qwen3-vl:2b-instruct · everyday request`). "What was sent" lists the memories and document chunks that went to the model.
4. The server log shows one `model_route` line per model call (tier, model, first-token time) and one `chat_completed` line per reply (hops, tool calls, memories and document chunks used, token counts).
5. With a tool-capable model: "Remember that I prefer oat milk" produces a "Remember this?" card under the reply; "add buy oat milk to my to-do list" produces an approval card; a question about an uploaded document (Memory page) runs `search_documents`; with a Tavily key, a question about current events runs `web_search` and shows sources.

Checked on 2026-10-21 on Windows 11 with Ollama 0.40.6: sign-up and email confirmation, two chat turns with streamed replies on `ollama/qwen3-vl:2b-instruct`, automatic titles, and the `model_route` and `chat_completed` log lines with token usage from Ollama. The unit tests cover the tool loop with a fake model (`tests/unit/assistant-tools.test.ts`).

## 5. The Docker image (the same build the VM uses)

`Dockerfile` builds the app as a standalone Node.js server. `docker-compose.yml` runs it against the local Supabase stack and the Ollama on this machine, reached through `host.docker.internal`.

```bash
cp .env.docker.example .env.docker   # then edit if your keys differ
docker compose up --build            # http://localhost:3000
```

- The container reads the Supabase address and key at runtime from `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`. (`NEXT_PUBLIC_*` values are fixed into the bundle at build time, so a prebuilt image cannot change them; the runtime names win when both are set.)
- `docker compose --profile ollama up` also starts an Ollama container for machines without Ollama; then set `OLLAMA_BASE_URL=http://ollama:11434/v1` in `.env.docker` and pull the models inside it: `docker compose exec ollama ollama pull qwen3-vl:2b-instruct`.
- Stop `npm run dev` first if both use port 3000, or set `APP_PORT=3100`.

Checked on 2026-10-21: the image builds, `/api/health` from the container reports `auth` and `inference` configured, and the container reaches the host's Supabase (`/auth/v1/health`) and Ollama (`/api/version`).

## 6. From simulation to production

Nothing in the code changes. Remove the `ollama/` chains (the defaults are the Nebius chains in `.env.example`), unset `OLLAMA_EMBEDDING_MODEL`, and set `NEBIUS_API_KEY` and `TAVILY_API_KEY`. For Cloudflare see [DEPLOYMENT.md](DEPLOYMENT.md); for a virtual machine with its own database see [DEPLOYMENT-VM.md](DEPLOYMENT-VM.md).

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Chat says "This service is not configured yet." | `NEBIUS_API_KEY` is empty and a chain or the embeddings still point at Nebius. Set the key, or make every chain `ollama/...` and set `OLLAMA_EMBEDDING_MODEL`. The server log line `config_missing` names the variable. |
| The reply is "The assistant returned an empty reply." | Ollama is not running, or the model is not pulled: `ollama list`, `ollama pull <model>`. The log shows `model_route` with `outcome: "error"`. |
| Memory or document saving fails with `bad_response` | The embedding model returned a vector of another size. Use `qwen3-embedding:0.6b`. |
| No tool is ever used | The model does not emit tool calls through Ollama. Use `ollama/llama3.1:8b` or another tool-capable model in the fast tier. |
| The container cannot reach Supabase or Ollama | On Linux, `host.docker.internal` needs the `extra_hosts` line in `docker-compose.yml` (present). Check `docker compose exec app wget -qO- http://host.docker.internal:11434/api/version`. |
