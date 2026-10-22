# Architecture

Status: Implemented for the MVP and unit-tested with mocked providers; not yet verified against live Supabase, Nebius, or Tavily (see `README.md`).

## System boundaries

```text
Browser: Next.js pages and UI, installable as an app
   |-- service worker (public/sw.js): offline page and notifications only;
   |   never caches pages or API responses (decision 0010)
   |
   | authenticated same-origin requests
   v
Cloudflare Worker (OpenNext): Next.js API routes
   |-- src/proxy.ts: session cookie refresh, page redirects
   |-- authentication and ownership checks (Supabase Auth, getClaims)
   |-- assistant orchestration (src/server/assistant)
   |     |-- router: picks a model tier (no model call)
   |     |-- executor: retries, fallbacks, hedge, breaker
   |     |-- tool loop (service.ts): at most 3 model calls per reply; tools read the
   |     |     user's data, search the web, or create proposals the user approves
   |     |-- grounded workflows (workflows/): search_flights and verified_research run
   |     |     several searches, read pages, extract with a forced tool call and keep
   |     |     only facts quoted word for word from a page (decision 0015)
   |     |-- Google connector (src/server/connectors): read-only Calendar and Drive,
   |     |     only while the user's Google chip is on (decision 0016)
   |     |-- Nebius Token Factory: streamed model inference (OpenAI-compatible)
   |     |     `-- or a local Ollama for a model with the `ollama/` prefix (local simulation)
   |     `-- Tavily: web retrieval (the search toggle, web_search, and the workflows'
   |           search and extract calls)
   |-- Google APIs (www.googleapis.com, oauth2.googleapis.com): GET only, tokens
   |     encrypted with AES-GCM in the Worker before they reach the database
   `-- persistence (src/server/db) -> Supabase Postgres with row-level security
```

The same application also runs as one Node.js container (`Dockerfile`): on a computer against the local Supabase stack (`docker-compose.yml`, [LOCAL-SIMULATION.md](LOCAL-SIMULATION.md)), or on a virtual machine with its own Postgres, Supabase Auth and PostgREST behind a gateway (`deploy/docker-compose.yml`, [DEPLOYMENT-VM.md](DEPLOYMENT-VM.md)).

A single Next.js application. Its API routes form the backend, deployed as one Cloudflare Worker through the OpenNext adapter ([decision 0004](decisions/0004-cloudflare-workers-deployment.md)); there is no separate always-on API server. Sessions are Supabase Auth cookies managed by `@supabase/ssr`. The app uses only the publishable key, so every database query runs under RLS as the signed-in user ([decision 0001](decisions/0001-supabase-auth-and-database.md)).

## Intended directory structure

```text
src/
  proxy.ts                 session refresh + redirects (Next.js 16 "proxy")
  app/
    page.tsx, layout.tsx   landing page, root layout, globals.css
    manifest.ts            web app manifest (/manifest.webmanifest)
    (auth)/                login, signup, forgot-password, reset-password
    (workspace)/           today, chat, memory, workflows, connectors, action-log,
                           devices, settings (server-side auth guard in layout)
    auth/confirm/          email verification and recovery link handler
    api/
      chat/                POST: streamed assistant reply (NDJSON)
      conversations/       GET list; [id]/ GET detail, PATCH rename, DELETE
      tasks/               to-do items per mode
      memories/, documents/, actions/, action-log/, reminders/,
      messages/[id]/context/   decision 0009
      health/              GET liveness + configured integrations
  components/layout/       workspace header, navigation, mode switch
  components/ui/           LocalTime (dates in the viewer's time zone)
  features/
    auth/                  server actions, form component
    chat/                  workspace UI, API client, NDJSON reader, "What was sent",
                           placing suggestions under the reply they came from
    actions/               approval cards, action log list, display helpers
    memory/, documents/    the Memory page (memories, documents)
    reminders/, today/     reminders panel, to-do list
    connectors/            live status lines for the built-in tools
    pwa/                   service worker registration, install prompt, notifications
  server/                  server-only modules
    config.ts              env validation (lazy; build needs no secrets)
    log.ts                 metadata-only structured logs
    auth/                  getClaims-based session, proxy helper
    assistant/             context budget, prompt assembly, orchestration,
                           model router, tiers, executor, circuit breaker
      workflows/           grounded lookups: flights, research, verify, airports,
                           links, intent, encoding (decision 0015)
    connectors/            config, crypto (HKDF, AES-GCM, signed state), Google
                           OAuth, Calendar and Drive clients, tool runner (0016)
    providers/             model.ts (provider interface), nebius/ (SSE streaming),
                           tavily/, shared errors/timeouts
    db/                    Supabase client, conversation repository, quota gate, spend guard
    http/                  body limits, origin check, error responses, NDJSON
  lib/                     limits, zod schemas, URL safety, Supabase public config
  types/                   API contracts shared with the browser
public/                    sw.js, offline.html, icons/, _headers (static file caching)
supabase/migrations/       schema, RLS policies, quota function
tests/
  unit/                    validation, providers, assistant, API routes
  integration/             database gate on in-memory Postgres (runs in npm test),
                           live RLS test (skipped unless configured)
  support/                 in-memory fakes and stream helpers
docs/decisions/            accepted and proposed decisions
```

Parenthesized folders are Next.js route groups and do not appear in URLs. `src/features/settings/` and `tests/e2e/` are still empty placeholders.

## Responsibilities

- API routes: Validate requests, verify identity, invoke application services, and translate errors into public responses.
- Assistant service: Assemble bounded conversation context, optionally retrieve search results, call inference, and associate source references with the response.
- Provider adapters: Isolate provider-specific authentication, request/response mapping, and timeouts. Mark these modules server-only when implemented.
- Database adapter: Persist private records and apply ownership checks. Do not use local files or process memory (Workers isolates are ephemeral) for durable storage.
- Feature folders: Group product-specific presentation and client state. Shared UI primitives belong in `components/ui/`.

## Data model

Defined in `supabase/migrations/20261014000000_initial_schema.sql`:

- User: `auth.users`, managed by Supabase Auth.
- `conversations`: ID, owner, title, created/updated time. A trigger bumps `updated_at` when a message is added.
- `messages`: ID, conversation, owner, role (`user`/`assistant`), content, web-search outcome (`off`/`used`/`no_results`/`failed`), source references (`[{title, url}]`), created time, and for assistant replies the model, tier, route reason and fallback flag (nullable; `NULL` for replies saved before model routing, [decision 0007](decisions/0007-model-routing.md)). Only completed assistant replies are stored, so there is no per-message completion status; an unanswered trailing user message is what the UI offers to retry.
- `usage_windows`: per-user request count per fixed window, written only by `consume_chat_quota()`.
- `spend_counters` and `spend_reservations`: global spend for Nebius (micro-dollars) and Tavily (credits) per UTC day, month and all time, plus one row per held call. No user content. Users cannot read or write them; only `reserve_provider_spend()` and `settle_provider_spend()` do ([decision 0006](decisions/0006-global-spend-guard.md)).

Added on 2026-10-22 (decisions 0015, 0016; migrations `20261022000500_message_results.sql`, `20261022001000_connector_grants.sql`):

- `message_results`: the verified results and steps of one assistant reply (`payload` up to 32 KB, kinds `flights`, `research`, `calendar`, `drive`), deleted with the message. Select and insert own; no update.
- `connector_grants`: one Google grant per user (account `sub` and email, granted scopes, status `active` or `needs_reconnect`, last used). The two token columns hold AES-GCM ciphertext made in the Worker and are not in the select grant; they are written only by `store_connector_tokens()` and read only by `connector_grant_secrets()`, both SECURITY DEFINER and limited to the caller's own row. A trigger writes `connector_added`, `connector_removed` and `connector_changed` to the action log with IDs, counts and status only.

Every row still carries a `mode` column (`personal` for everything written since decision 0014); the app no longer shows or filters by it.

RLS allows each user to select and insert only their own rows and to delete only their own conversations (messages cascade). Updates are revoked. Repository methods also filter by the session user ID. Each chat request holds a worst-case Nebius cost (and one Tavily credit when search is on) before the paid call, and settles the real cost from the token usage after it. A hold above $0.25 is refused, never reduced; `src/server/assistant/spend.ts` computes every hold. Global caps refuse a request with `budget_exhausted` before streaming ([decision 0006](decisions/0006-global-spend-guard.md)).

## Provider contracts

Nebius exposes an OpenAI-compatible API. The adapter calls `POST {NEBIUS_BASE_URL}/chat/completions` with `stream: true`, `stream_options.include_usage` (token usage for the spend guard) and `chat_template_kwargs.enable_thinking` (off, or on with `thinking_token_budget` for the heavy tier), and parses server-sent events, including errors sent mid-stream. Reasoning fields and a leading `<think>` block are never shown or saved. The base URL and the model chains are configuration.

Model routing ([decision 0007](decisions/0007-model-routing.md)): a rule-based router picks a tier (`fast`, `standard`, `heavy` or `vision`) from the message, the conversation size, web search and the user's effort choice. The executor runs the tier's model chain through a provider interface (`src/server/providers/model.ts`). It retries and falls back only before the first visible token or tool call, uses one deadline for all attempts, hedges slow fast-tier calls once, and skips a failing model with a soft breaker in isolate memory (best effort, not shared). Each attempt holds and settles spend through the spend guard. A model ID with the `ollama/` prefix goes to a local Ollama server through the same client at zero price ([decision 0013](decisions/0013-ai-layer-integration-and-local-simulation.md)). Tavily `POST /search` is called with `basic` depth and at most five results, and only http(s) URLs are kept. Responses are validated with Zod, context is bounded, and both adapters have timeouts. Retrieved text goes in the final user turn inside `<web_search_results>` delimiters and is described to the model as untrusted data.

The tool loop ([decision 0013](decisions/0013-ai-layer-integration-and-local-simulation.md)): the model may call `web_search` (one Tavily credit each, held first), `search_documents` and `search_memories` (similarity search over the user's own rows, through the budgeted embedder), `save_memory` (a `proposed` memory the user keeps or discards), and `propose_task` or `propose_reminder` (an `action_proposals` row the user approves; nothing runs without approval, decision 0009). A reply has at most three model calls; the last one offers no tools, so the model answers with what it has. Each call holds and settles spend like any other attempt. Tool results go back to the model inside delimiters as untrusted data and never authorize anything. Memories that match the message are retrieved before the first call and placed in the system message; the context record lists the memory and document chunk IDs that were sent. A new conversation is named from its first exchange with one fast-tier call, and `POST /api/memories/summarize` suggests lasting facts from a conversation as `proposed` memories.

Grounded workflows ([decision 0015](decisions/0015-grounded-workflows.md)): when `parseFlightRequest` finds an origin, a destination and a date in the user's words, the service runs the flight check itself before the first model call and skips the toggle search; a vaguer flight request (detected by `detectFlightIntent`) offers `search_flights` normally, and the tool refuses without spending credits unless the trip details are in the user's own messages. A workflow reserves all its Tavily credits first, runs up to 3 searches in parallel, extracts up to 5 pages, and makes one forced tool call on the extraction plan that returns verbatim spans. Code then checks that each quote is in one chunk of its page, that the price, airline, route, direction and date are in the quote, and parses currency and price basis itself. Only verified items go back to the model, inside `<flight_results>` or `<research_results>` with every untrusted character encoded. The service streams a `step` event per stage and a `result` event, writes a code-built summary as the first line of the reply, marks any price or time in the reply that is not in the verified set, and saves results and steps to `message_results`. After a workflow or connector result, the reply is tainted: later hops offer no tool that sends text outside P-Dot, and Auto runs nothing on its own. At most one workflow runs per reply, and `nextHopFits` refuses a tool whose result could push the next hop past the hold ceiling.

Google connector ([decision 0016](decisions/0016-google-connectors.md)): `POST /api/connectors/google/start` sets a signed `__Host-pdot_oauth` cookie (state, PKCE verifier, user ID) and returns Google's authorization URL; the callback checks the cookie and session, exchanges the code, encrypts the tokens and stores the grant. The tools `calendar_list_events`, `drive_search_files` and `drive_read_file` are offered only when the request's Google chip is on and the grant is active with the matching scope; access tokens refresh within 60 seconds of expiry, and `invalid_grant` marks the grant `needs_reconnect`.

Reference documentation:

- [Next.js installation and App Router](https://nextjs.org/docs/app/getting-started/installation)
- [OpenNext for Cloudflare](https://opennext.js.org/cloudflare)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Nebius API reference](https://api.tokenfactory.nebius.com/docs)
- [Tavily search API](https://docs.tavily.com/documentation/api-reference/endpoint/search)

Recheck current provider documentation and dependency versions when implementation begins.

## Deployment plan

Deploy with `npm run deploy` (OpenNext build, then `wrangler deploy`) or Cloudflare Workers Builds. Keep preview and production credentials separate. `NEXT_PUBLIC_*` values are inlined at build time; keys are Worker secrets and other settings are Worker variables read at runtime. Configure authentication redirect URLs for each intended origin. Model inference runs on Nebius infrastructure, while Tavily supplies retrieval.

Deployment configuration is `wrangler.jsonc` and `open-next.config.ts` (no R2/KV cache: every route is rendered per request). Workers have no per-route `maxDuration`; the Nebius/Tavily timeouts in code bound each request, and the Worker CPU-time limit applies to compute, not to time spent waiting on providers. Production is live at https://pdot.iampatelom.com (first deployed 2026-10-19). Merges to `main` deploy through Cloudflare Workers Builds and pull request branches get previews, once the owner connects it; see [DEPLOYMENT.md](DEPLOYMENT.md).
