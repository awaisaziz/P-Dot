# P-Dot

A personal assistant with a web interface, a Cloudflare Workers backend, Nebius model inference, and optional Tavily web search. The whole stack can also run on one computer with a local model standing in for Nebius ([docs/LOCAL-SIMULATION.md](docs/LOCAL-SIMULATION.md)), or on a virtual machine with its own database ([docs/DEPLOYMENT-VM.md](docs/DEPLOYMENT-VM.md)).

**Status: MVP implementation in progress.** Working: accounts, a streaming chat with opt-in web search, conversation history with rename and delete, Personal and Work modes, a to-do list, browser dictation, approval cards, a Memory page for memories and documents, "What was sent" under each reply, an action log, reminders, and an installable app for Android. The assistant does not propose actions or use memories in replies yet, and nothing can be connected, automated or paired yet (those parts of Workflows, Connectors and Devices are previews). Unit tests use mocked providers; the database rules were tested against a local Supabase. A few small real Nebius calls checked the token usage and reasoning format (see [decision 0006](docs/decisions/0006-global-spend-guard.md)); a full chat through the live app has not been tested yet. The app is live at https://pdot.iampatelom.com (first deployed 2026-10-19); chat replies there say "not configured" until the Nebius key is set. A global spend guard caps what all users together can spend (see [Usage limits](#usage-limits)). See [What works today](#what-works-today) and [Verification status](#verification-status).

## What works today

| Area | Status |
| --- | --- |
| Sign up, sign in, email confirmation, password reset | Works (tested with local Supabase) |
| Chat with streamed replies, retry, stop | Works once Nebius is configured |
| Web search toggle (Tavily) from the "+" menu | Works once a Tavily key is set; off by default |
| Conversation list, **rename**, delete | Works |
| **Personal / Work mode** toggle | Works: each conversation and task belongs to one mode, lists are filtered by mode, and the assistant is instructed to stay within that mode's topics |
| **Today** page: to-do list per mode | Works (add, tick, delete) |
| **Microphone** button: speech to English text | Works in browsers with speech recognition (Chrome, Edge, Safari): the browser asks for the microphone the first time, shows the words it hears as you speak, and puts each finished phrase in the message box. You press send; sending or switching conversations stops listening. On Android it listens for one phrase per tap |
| **Approval cards** in chat and on Today: approve, edit then approve, cancel | Works for proposals stored through the API. In chat each card sits under the reply that made it, with earlier decisions as short lines; the Today tab shows how many are waiting. The assistant does not create proposals yet, so none arrive from chat |
| **Ask first / Auto** approval modes | Chat asks once per device which mode to use (Ask first is recommended). After that, the button next to the microphone shows the current mode and opens a menu that explains both; Settings → Approvals has the same choice, and the Today panel links to it. Works with today's API. In Auto, adding a task or a reminder runs on its own and shows "Done on its own" with Undo; saving a memory, deleting, outside accounts, private data, money and settings still ask (at most 3 on its own per reply). The choice is saved on the device; the server-side part is the recipe in [decision 0011](docs/decisions/0011-approval-modes.md) |
| **Remember this?** in chat: keep, edit then keep, don't keep | Works for memories P-Dot suggested (`status = 'proposed'`, linked to a message). The assistant does not suggest memories yet |
| **Memory** page: memories and documents (`.txt`, `.md`), add, keep, edit, move, delete | Works. Saving or changing text needs the Nebius key (embeddings); replies do not use memories or documents yet |
| **What was sent** under each reply | Works for replies saved since context records began; older replies say they have none |
| **Action log** page | Works: approvals, cancellations, runs and changes to memories, documents and reminders, without their text |
| **Workflows**: reminders | Works (add, done, reopen, delete); P-Dot does not notify you when one is due yet. Routines are previews |
| **Connectors** | Built-in tools (to-do list, reminders, memory, documents) show live counts; account connectors are previews |
| **Installable app** (PWA): manifest, service worker, install prompt, notification permission | Works in Chrome on Android and desktop; iPhone users add it to the Home Screen. No push messages are sent yet ([decision 0010](docs/decisions/0010-pwa-and-device-pairing.md)) |
| **Devices** page | Shows what this browser supports; device pairing is a preview |
| Daily brief | Preview only |
| Landing page agent example | Illustrative example, not real data |

The design for all of this is in the "P-Dot Frontend Design" canvas; planned-but-unbuilt parts are tracked in [decision 0005](docs/decisions/0005-assistant-hub-proposal.md) and [decision 0010](docs/decisions/0010-pwa-and-device-pairing.md).

## Stack

- Next.js 16 (App Router, TypeScript) for pages and API routes, deployed to Cloudflare Workers with the OpenNext adapter ([decision 0004](docs/decisions/0004-cloudflare-workers-deployment.md))
- Supabase for authentication and Postgres (row-level security) — [decision 0001](docs/decisions/0001-supabase-auth-and-database.md)
- Nebius Token Factory (OpenAI-compatible) for inference, streamed to the browser as NDJSON — [decision 0002](docs/decisions/0002-streaming-responses.md)
- Tavily for opt-in web search, also available to the assistant as the `web_search` tool
- The AI layer (`src/server/assistant`): a rule-based model router, an executor with retries, fallbacks and a hedge, a spend guard, and a tool loop (web search, document search, memory search, memory suggestions, task and reminder proposals) with conversation titles and session memory suggestions
- Ollama as a local stand-in for Nebius (the `ollama/` model prefix) and a Docker image for local simulation and VM deployment
- Zod for validation, Vitest for tests

## Setup

Requires Node.js 22.12 or newer.

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Create a Supabase project** and apply the schema in [`supabase/migrations/20261014000000_initial_schema.sql`](supabase/migrations/20261014000000_initial_schema.sql), either by pasting it into the Supabase SQL editor or with the Supabase CLI (`supabase link`, then `supabase db push`).

3. **Configure Supabase Auth** (Authentication → URL Configuration and Email Templates):
   - Site URL: your production URL (or `http://localhost:3000` for local work).
   - Redirect URLs: add `http://localhost:3000/**` and each deployed origin you use, e.g. `https://pdot.iampatelom.com/**`.
   - Recommended email links (they work even if the email is opened in a different browser):
     - Confirm signup: `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next=/chat`
     - Reset password: `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/reset-password`

     The default `{{ .ConfirmationURL }}` templates also work, but only when the link is opened in the same browser that started the flow.

4. **Set environment variables**: copy `.env.example` to `.env.local` and fill it in. You need the Supabase URL and publishable key, a Nebius API key, and a Nebius chat model ID (list available models with `GET https://api.tokenfactory.nebius.com/v1/models`). `TAVILY_API_KEY` is optional. Never use the Supabase secret/service-role key in this app.

5. **Run the app**

   ```bash
   npm run dev
   ```

   Open http://localhost:3000, create an account, confirm the email, and start a conversation. `GET /api/health` reports which integrations are configured (without checking that they are reachable).

## Local development and testing (Docker)

Run Supabase locally instead of using a hosted project. Requires Docker running. [`supabase/config.toml`](supabase/config.toml) is already configured for this app (site URL `http://localhost:3000`, redirect URLs, 8-character minimum password, email confirmations on, rate limit of 2 emails per hour).

### 1. Start Supabase

`supabase init` is already done: the config is committed in `supabase/`, so do not run it again (it refuses to overwrite `config.toml`).

```bash
npm install
npm run db:start
```

The first run downloads a few GB of images and applies the migration. It prints the API URL, a publishable key, Studio (`http://127.0.0.1:54323`, a database browser) and the fake inbox (`http://127.0.0.1:54324`). `npm run db:status` prints them again.

### Local services and links

| Service | URL | What it does |
| --- | --- | --- |
| P-Dot app | http://localhost:3000 | The Next.js app (`npm run dev`). Use `localhost`, not `127.0.0.1`, so cookies and email links share one host. |
| Health check | http://localhost:3000/api/health | Reports which integrations are configured (booleans only; does not call the providers). |
| Supabase API | http://127.0.0.1:54321 | The URL the app uses for Auth and database requests (`NEXT_PUBLIC_SUPABASE_URL`). |
| Supabase Studio | http://127.0.0.1:54323 | Admin web UI. **Authentication → Users** lists accounts (unconfirmed ones show as waiting for verification). **Table Editor** shows `conversations`, `messages` and `usage_windows`. **SQL Editor** runs queries. It shows every user's rows, because it is an admin view; the app itself only sees the signed-in user's data. |
| Mailpit (fake inbox) | http://127.0.0.1:54324 | Catches every email local Supabase would send: signup confirmation and password reset. **Nothing is sent to real addresses; look here instead of your real inbox.** |
| Postgres | `postgresql://postgres:postgres@127.0.0.1:54322/postgres` | Direct database connection for any Postgres client (local development only). |

Where is my confirmation email? After signing up, the app shows "Check your email for a confirmation link". Open Mailpit, open the "Confirm your signup" email and click the link. It returns to `/auth/confirm` and then `/chat`, signed in. Password-reset emails arrive in the same inbox. If nothing arrives, the address may already be registered (the app shows the same message either way), or the local limit of 2 emails per hour was reached (raise `email_sent` under `[auth.rate_limit]` in `supabase/config.toml`, then `npm run db:stop && npm run db:start`).

### 2. Configure `.env.local`

Create `.env.local` (git-ignored) in the project root:

```env
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable key from db:start>
SITE_URL=http://localhost:3000

# Needed only for chat replies; auth and history work without them
NEBIUS_API_KEY=<your Nebius key>
# Optional: the model chains for each tier have defaults (see .env.example).
TAVILY_API_KEY=
```

If the CLI prints an "anon key" instead of a publishable key, use that.

### 3. Run the app

```bash
npm run dev
```

Open `http://localhost:3000` (not `127.0.0.1`, so cookies and email links share one host). Restart `npm run dev` after changing `.env.local`.

### 4. Manual test checklist

| Test | Expected result |
| --- | --- |
| `GET http://localhost:3000/api/health` | `"auth": true` (`"inference": true` once Nebius is set) |
| Sign up | "Check your email"; open the fake inbox, click the link, you land in `/chat` |
| Sign out, then open `/chat` | Redirected to `/login` |
| Sign in with a wrong password | "Incorrect email or password…" |
| Forgot password | Email in the fake inbox; the link opens `/reset-password`; after saving you are signed in |
| Send a message without Nebius settings | "This service is not configured yet." and nothing is saved |
| Send a message with Nebius settings | Reply streams in; the conversation appears in the sidebar |
| Studio → Table Editor | `conversations`, `messages`, `usage_windows`, `tasks` hold your rows |
| Click **Work** in the header, then start a chat | The sidebar shows only Work conversations; asking a personal question (dinner, gifts) gets a reply that it belongs in Personal mode |
| Hover a conversation: pencil, then Enter | Renamed in the sidebar; the new name is stored |
| **Today** → add a task, tick it, delete it | Persists after a reload; Work and Personal lists are separate |
| Microphone button, allow the browser prompt, speak | "Listening…" with the words being heard, then English text in the message box (Chrome/Edge/Safari; button is disabled elsewhere). Esc or the button stops; Send stops it too |
| **Workflows** and **Connectors** pages | Reminders work on Workflows; Connectors shows live counts for the built-in tools; routines and account Connect buttons are disabled previews |
| Insert a row into `action_proposals` for your user (Studio → SQL Editor, `status = 'proposed'`, with a `conversation_id`), then open that conversation | An approval card appears under the reply of the latest turn before the row was made, and the Today tab shows the count. Approve, Edit then approve, and Cancel each change its status; approved tasks and reminders appear on Today and Workflows; each decision appears on **Action log**; after a reload, decided ones show as short lines |
| Insert a row into `memories` with `status = 'proposed'`, `source = 'assistant'` and `source_message_id` set to a message in that conversation | A "Remember this?" card appears under that turn's reply. Keep moves it to Remembered on the Memory page; Don't keep deletes it |
| **Memory** → add, keep, edit, move to the other mode, delete | Persists after a reload. Without a Nebius key, adding or changing text says the embedding service is not configured |
| **Memory** → Documents → choose a `.md` or `.txt` file, check the title, Add | With a Nebius key it shows "Ready". Other file types and empty files are refused before anything is sent |
| **What was sent** under a reply | Model, conversation size, memories, documents, web search and tokens for that reply |
| **Settings** → App and notifications (Chrome on Android) | "Install P-Dot" opens the install dialog; "Allow notifications" asks for permission; the test notification appears |
| Second user in a private window | Sees none of the first user's conversations |
| Delete a conversation | Gone from the sidebar and from Studio |
| Exceed `CHAT_REQUESTS_PER_WINDOW` (set it to 2 to try) | 429 "You have reached your request limit" |
| Set `NEBIUS_DAILY_CAP_USD=0.01` and send two or three messages | 429 "P-Dot has reached its daily usage limit. Try again tomorrow." |
| Set `TAVILY_DAILY_CREDITS=1`, turn on search, send two messages | The second reply says web search was not used because of the search limit |

To skip email confirmation, set `enable_confirmations = false` under `[auth.email]` in `config.toml`, then `npm run db:stop && npm run db:start`. If reset emails stop arriving, raise `email_sent` under `[auth.rate_limit]`.

### 5. Automated checks

```bash
npm run check
```

runs lint, type-check, and unit tests. To also run the row-level security tests against the local database, create two confirmed users (Studio → Authentication → Add user, with "Auto Confirm User" checked) and set these variables in the same terminal before `npm test`:

```powershell
$env:SUPABASE_TEST_URL="http://127.0.0.1:54321"
$env:SUPABASE_TEST_PUBLISHABLE_KEY="<publishable key>"
$env:SUPABASE_TEST_USER_A_EMAIL="<user A email>"
$env:SUPABASE_TEST_USER_A_PASSWORD="<user A password>"
$env:SUPABASE_TEST_USER_B_EMAIL="<user B email>"
$env:SUPABASE_TEST_USER_B_PASSWORD="<user B password>"
npm test
```

The 10 tests in `tests/integration/rls.test.ts` should then run instead of being skipped. One checks the model route columns on messages. They also reserve and give back a few micro-dollars through the spend guard functions.

`npm test` also runs the database gate (`tests/integration/sql-gate.test.ts`) without any setup. It applies every migration to an in-memory Postgres (PGlite with pgvector) that has stand-ins for the Supabase roles, `auth.uid()` and the Supabase default grants, then checks grants and RLS as `anon` and as two signed-in users, and reads stored rows through the app's own parsers. `tests/integration/frozen-migrations.test.ts` fails if a migration is not listed in `tests/integration/frozen-migrations.sha256` or no longer matches its hash. The pull request that adds a migration adds its hash. After merge, never edit the file: add a new migration.

### Housekeeping

| Command | Effect |
| --- | --- |
| `npm run db:reset` | Wipe the local database and re-apply the migration |
| `npm run db:stop` | Stop the Docker containers |

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server on port 3000 |
| `npm run build` | Production build (does not need secrets) |
| `npm run db:start` / `db:status` / `db:reset` / `db:stop` | Manage the local Supabase stack (Docker) |
| `npm run preview` | Build for Cloudflare and run the Worker locally in the Workers runtime |
| `npm run deploy` | Owner only. Build for Cloudflare, check that no secret is in the bundle, and deploy (see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)) |
| `npm run upload` | Owner only. Same as deploy, but uploads a new version without sending traffic to it |
| `npm run check:worker-env` | Check the last OpenNext build for secret values copied from `.env` files |
| `npm run lint` | ESLint (Next.js core-web-vitals + TypeScript rules), then `scripts/check-changelog.mjs` on the Unreleased entries |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest unit tests and the database gate (in-memory Postgres, no setup); the live RLS integration test is skipped unless configured |
| `npm run check` | Lint, type-check, and tests |

To run the row-level security test against a **test** Supabase project, set the `SUPABASE_TEST_*` variables listed at the top of [`tests/integration/rls.test.ts`](tests/integration/rls.test.ts).

## API

All private endpoints require the Supabase session cookie and scope data to the signed-in user. Errors use `{ "error": { "code", "message", "requestId" } }`.

| Method and path | Purpose |
| --- | --- |
| `POST /api/chat` | `{ action: "send", conversationId?, mode?, message, webSearch, effort? }` (`mode` applies to new conversations) or `{ action: "retry", conversationId, webSearch, effort? }`. `effort` is `"auto"` (default: the router picks a model tier) or `"deep"` (always the heavy tier). Streams `application/x-ndjson` events: `start` (with `route: { tier, reason }`), `search`, `delta`, `done` (its message has `route: { model, tier, reason, fallback }`), `error` (`budget_exhausted` if the spend guard refuses a fallback). Messages in `GET /api/conversations/:id` have the same `route` field, or `null` for user messages and older replies. Returns 401, 403, 404, 409, 413, 415, 429, or 503 before streaming when appropriate. A global spend cap returns `budget_exhausted` (429 for a daily cap, 503 for the total cap). |
| `GET /api/conversations[?mode=personal\|work]` | The user's conversations, most recent first, optionally for one mode |
| `PATCH /api/conversations/:id` | Rename: `{ title }` (404 for someone else's) |
| `GET /api/tasks?mode=` | The user's to-do items for a mode |
| `POST /api/tasks` | Add a task: `{ mode, title }` |
| `PATCH /api/tasks/:id` | Change `{ title?, done? }` |
| `DELETE /api/tasks/:id` | Delete a task |
| `GET /api/conversations/:id` | One conversation with its messages (404 for missing or someone else's) |
| `DELETE /api/conversations/:id` | Permanently delete a conversation and its messages |
| `GET /api/memories?mode=&status=`, `POST /api/memories`, `PATCH`/`DELETE /api/memories/:id` | Memories the user can see, edit and delete ([decision 0009](docs/decisions/0009-memory-documents-actions.md)) |
| `GET /api/documents?mode=`, `POST /api/documents`, `DELETE /api/documents/:id` | Plain text and Markdown documents, split and embedded on upload |
| `GET /api/actions?status=`, `POST /api/actions/:id/decision` | Action proposals; `{ decision: "approve" \| "reject", payload? }` runs an approved action once |
| `GET /api/action-log` | The action log, written only by the database (IDs, kinds, modes, counts and flags only) |
| `GET /api/reminders?mode=`, `POST /api/reminders`, `PATCH`/`DELETE /api/reminders/:id` | Reminders (no delivery yet) |
| `GET /api/messages/:id/context` | "What was sent" for one assistant reply (404 when it has no record) |
| `GET /api/health` | Liveness and configured integrations (booleans only) |
| `GET /auth/confirm` | Landing page for email verification and password-recovery links |

## Structure

| Path | Contents |
| --- | --- |
| `src/app/` | Pages (landing, `(auth)`, `(workspace)`: today, chat, memory, workflows, connectors, action-log, devices, settings), API routes, `auth/confirm`, the web app manifest (`manifest.ts`) |
| `wrangler.jsonc`, `open-next.config.ts` | Cloudflare Worker and OpenNext adapter configuration |
| `src/proxy.ts` | Session refresh and page redirects (Next.js 16 "proxy", formerly middleware) |
| `src/features/` | Auth forms and server actions, chat workspace (rename, dictation, "What was sent"), to-do list, mode switch, approval cards and the action log (`actions/`), memory, documents, reminders, connectors status, the installable app (`pwa/`) |
| `src/components/` | Shared layout components and `ui/LocalTime` (dates in the viewer's time zone) |
| `public/` | Service worker (`sw.js`), offline page, app icons, `_headers` for static files |
| `src/server/` | Server-only code: config, auth session, Supabase repositories, assistant orchestration, Nebius/Tavily adapters, HTTP helpers |
| `src/lib/`, `src/types/` | Shared limits, validation schemas, URL safety helpers, API contracts |
| `supabase/migrations/` | Database schema, RLS policies, the quota function, the modes/rename/tasks migration, and the global spend guard |
| `tests/` | Unit tests (`unit/`), the database gate and the live Supabase RLS test (`integration/`), shared fakes (`support/`) |
| `docs/` | PRD, architecture, [deployment guide](docs/DEPLOYMENT.md), [provider reliability lessons](docs/PROVIDER-RELIABILITY.md), decision records |
| `CHANGELOG.md` | What changed, the problem, and how it was resolved, for each pull request |
| `scripts/` | `check-worker-env.mjs` and `worker-env-rules.mjs`: deploy guard against secrets in the Worker bundle. `check-changelog.mjs` and `changelog-rules.mjs`: changelog entry check |
| `src/app/icon.svg`, `favicon.ico`, `apple-icon.png` | Site icon ("P." on the indigo-to-violet accent); the app icons in `public/icons/` use the same mark |

## Local simulation with Ollama and Docker

**Read [docs/LOCAL-SIMULATION.md](docs/LOCAL-SIMULATION.md).** It runs the production code path with no paid provider: every model tier on a local Ollama model (`NEBIUS_FAST_MODELS=ollama/qwen3-vl:2b-instruct` and so on), local embeddings (`OLLAMA_EMBEDDING_MODEL=qwen3-embedding:0.6b`), the local Supabase stack, and optionally the app in Docker (`docker compose up --build`). A Tavily key turns web search on in the same way as in production. The `ollama/` prefix is the only switch: the same client, routing, spend guard and tool loop run against Ollama and against Nebius.

## Deploying on a virtual machine

**Read [docs/DEPLOYMENT-VM.md](docs/DEPLOYMENT-VM.md).** `deploy/docker-compose.yml` runs the app, Supabase Auth, PostgREST, the gateway and Postgres with pgvector on one machine, applies the migrations, and serves HTTPS with Caddy. Models run on Nebius and web search on Tavily, with server-side keys. The database never leaves the machine.

## Deploying to Cloudflare

**Read [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).** It is the full guide for people and coding agents: the branch → pull request → preview → merge → production flow, where each setting and secret lives, previews, database changes, and what agents must not do.

Short version:

- Production: https://pdot.iampatelom.com, one Cloudflare Worker named `pdot` ([`wrangler.jsonc`](wrangler.jsonc), [`open-next.config.ts`](open-next.config.ts), [decision 0004](docs/decisions/0004-cloudflare-workers-deployment.md)).
- Every change goes through a pull request into `main` with an adversarial review. When the owner merges, Cloudflare Workers Builds deploys `main`. Each pull request branch gets a preview link. (Workers Builds must first be connected by the owner; until then only the owner deploys, with `npm run deploy`.)
- `npm run preview` runs the built Worker on your computer in the Workers runtime, with no Cloudflare account. Stop `npm run dev` first.
- `NEXT_PUBLIC_*` values are put into the bundle at build time. Provider keys are Worker secrets. The OpenNext build copies `.env.local` values into the Worker bundle, so `npm run deploy` and `npm run upload` stop if a name that is not on the allow list (for example a key or password) has a value there (`scripts/check-worker-env.mjs`).
- Build and deploy from macOS, Linux, WSL or Workers Builds. Native Windows is not supported by OpenNext.

## Verification status

Done and passing locally: lint, type-check, the unit tests (request validation, auth and ownership boundaries at the route level, rename, modes and tasks, provider error/timeout handling, prompt-injection delimiting, search-off/search-failure behavior, retry and persistence rules, spend guard holds, settles and refusals), production build, and the 6 row-level-security tests against a local Supabase database (including rename and tasks privacy, which need the `SUPABASE_TEST_*` variables described below).

Deployed and checked on 2026-10-19: `/api/health` (auth configured, inference not configured), `/`, `/login`, `/signup` return 200, `/chat` redirects to `/login` when signed out, and `POST /api/chat` without a session returns 401. No CPU-limit or runtime errors in the Worker logs.

Spend guard SQL (2026-10-19): the migration was run on an in-memory Postgres (PGlite) with stand-ins for the Supabase roles and `auth.uid()`. Checked: hold and settle, settle once, no settle by another user, no negative or above-hold settle, parameter bounds, day, total and per-user caps, no direct table access for `anon` or `authenticated`. Not checked there: many requests at the same time (row locks).

Real provider checks (2026-10-19): 4 small Nebius calls to `nvidia/nemotron-3-super-120b-a12b` (`max_tokens` at most 300) and the free Tavily usage endpoint. No Tavily search was made. For model routing, about 28 more small calls (`max_tokens` at most 400, under $0.01 in total): the reasoning budget (`thinking_token_budget`) on Super, Ultra and Nano, each tier through the executor, and a 404 for an unknown model ID that moved to the next model. Numbers are in [decision 0007](docs/decisions/0007-model-routing.md).

Model routing was tested with a fake streaming provider and fake timers: router examples, retries with `Retry-After`, no retry on 400 and 401, 404 to the next model, first-token timeout, the hedge (winner, loser stopped and settled, at most one, never on heavy), the breaker, the deadline, budget refusal, Stop during a hedge, no switch after the first token, and the saved route. The new migration was run on an in-memory Postgres (PGlite) on top of existing rows.

Signed-in walkthrough of the hub screens (2026-10-19, local): in the Claude desktop app's built-in browser (Chromium) against `npm run dev` and a local Supabase with every migration, with a new test account and fixture rows inserted with SQL for what the app cannot create yet (proposals, and a saved reply with its context record). Checked: chat shows only that conversation's approval cards; Approve, Edit then approve (title and due time) and Cancel; a failed run (approving a memory without a Nebius key) shows one clear error; Today's approvals panel, its other-mode hint and the to-do list refreshing after an approval; "What was sent" for a reply with a record, an old reply without one, and a new reply whose record arrives a moment later ("Check again"); memory keep, move and delete, and the "not configured" messages for adding and editing text; the document list, delete, file checks (a PDF and an empty file refused, a `.md` without a MIME type accepted) and the upload error; the action log; reminders (add, done, overdue flag); Connectors counts; the manifest, service worker and offline page; the install button with a stand-in install event; phone width (375 px, no sideways scrolling) and dark mode. The database rows matched each action. Then, for suggestions in chat: cards under the right reply in a two-turn conversation (including one made before its reply was saved), earlier decisions as short lines, "Remember this?" keep, edit (the "not configured" message) and don't keep, and the Today count after decisions in chat and on Today, after a conversation switch and when the tab comes back into view. Dictation: the pages now send `microphone=(self)` and the browser reports the microphone as allowed; a blocked microphone shows the right message; with a stand-in recognizer, the words being heard show while speaking, finished phrases land in the message box within the length limit, Esc stops, Send and switching conversations stop it and drop any later words, and Android listens one phrase per tap. Real speech was not tried (the built-in browser blocks microphone capture). Not checked: a reply from a real model, a successful document upload or memory save (both need the Nebius key), installing on a real Android phone, and granting notification permission.

AI layer and local simulation (2026-10-21, Windows 11, Ollama 0.40.6, local Supabase with every migration): the unit tests cover the tool loop with a fake model (`tests/unit/assistant-tools.test.ts`: each tool, malformed arguments, the hop limit, holds settled, Stop during a tool, titles) and the session summary (`tests/unit/session-summary.test.ts`). In the browser against `npm run dev`: sign-up with the fake inbox, two chat turns on `ollama/qwen3-vl:2b-instruct` with streamed replies, automatic titles, the model line under each reply and "What was sent"; on `ollama/llama3.1:8b-instruct-q4_K_M`, "remember that I prefer oat milk" made the assistant call `save_memory`, and the "Remember this?" card appeared under the reply with the suggested text. The `model_route` and `chat_completed` log lines carried the token usage Ollama reports. The Docker image built and answered `/api/health` with auth and inference configured, reaching the host's Supabase and Ollama. Not checked with a real model: web search (no Tavily key here), document search and task or reminder proposals from chat (covered by the unit tests), the session summary from the browser, and a reply from Nebius through the merged tool loop.

Not yet done: a real Tavily search, a full chat through the live app, a signed-in browser walkthrough in production, dictation in real browsers, end-to-end tests, Workers Builds (automatic deploys and previews), and production Supabase email setup. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) → One-time setup. After pulling these changes, apply the new migration with `npm run db:start` (new stack) or `npx supabase migration up` (running stack). Provisional limits and behaviors that need review are listed in [decision 0003](docs/decisions/0003-provisional-defaults.md).

## Usage limits

Two kinds of limit protect the owner's paid credit:

- **Per user:** 30 chat requests each hour (`CHAT_REQUESTS_PER_WINDOW`, `CHAT_WINDOW_SECONDS`).
- **All users together (global spend guard):** Nebius $1.00 each UTC day and $20.00 in total; Tavily 40 credits each UTC day and 800 each month. One user can use at most $0.25 of Nebius and 10 Tavily credits each day. The settings are `NEBIUS_DAILY_CAP_USD`, `NEBIUS_TOTAL_CAP_USD`, `NEBIUS_USER_DAILY_CAP_USD`, `TAVILY_DAILY_CREDITS`, `TAVILY_MONTHLY_CREDITS` and `TAVILY_USER_DAILY_CREDITS`. When the Nebius budget is used up, chat says "P-Dot has reached its daily usage limit. Try again tomorrow." When only the Tavily budget is used up, replies come without web search and say so. Details, and how to change or reset the caps: [decision 0006](docs/decisions/0006-global-spend-guard.md).
