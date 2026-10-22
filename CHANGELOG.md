# Changelog

All notable changes to P-Dot. Newest first. Each entry says what changed, the problem it solves, and how it was resolved, with the pull request and review links. Commit messages hold the line-level detail.

Every pull request adds its entry under **Unreleased**. When it merges, the entry moves under the merge date. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Lessons about provider calls, retries, backups and spending are in [docs/PROVIDER-RELIABILITY.md](docs/PROVIDER-RELIABILITY.md).

## Unreleased

### Added
- **An agentic workspace: grounded flight checks and research, read-only Google connectors, one workspace instead of Personal and Work, and one-line explanations across the app.** ([commit 3bdcf19 on awaisaziz/P-Dot](https://github.com/awaisaziz/P-Dot/commit/3bdcf19); decisions [0014](docs/decisions/0014-one-workspace.md), [0015](docs/decisions/0015-grounded-workflows.md), [0016](docs/decisions/0016-google-connectors.md), amendment to [0011](docs/decisions/0011-approval-modes.md))
  - Problem: the owner asked for a personal bot that runs workflows such as "search my flight" and returns tickets without hallucinating, explanations condensed to one line, a nicer interface, one workspace instead of Personal and Work tabs, and connectors starting with Google. A single web search with five excerpts let the model state fares it had not read; the Personal/Work split made the assistant refuse topics; the Connectors page had only previews; many screens explained themselves in paragraphs, some of them out of date.
  - Resolution: `search_flights` and `verified_research` run several Tavily searches and an extract, then one forced extraction call that returns verbatim spans; code checks every quote against one chunk of its page and checks the price, airline, route, direction and date, parses currency and price basis itself, and shows only what passed, with "Quoted from <site>", the read time, typical prices kept apart from fares for the date, drop reasons and live-fare links. Code reads a clear flight request and runs the check before the model; a vague one is refused without credits so the model asks. Any amount or time in the reply that no quote contains is flagged. Steps stream as one-line run-panel rows and are saved with the results (`message_results`). After a workflow or connector result, the reply offers no web search or check and Auto runs nothing. Google Calendar and Drive (Docs, Slides, Sheets) are read only while the composer's Google chip is on, through an OAuth flow with PKCE and a signed `__Host-` state cookie, with tokens encrypted by AES-GCM under HKDF keys and written only by SECURITY DEFINER functions (`connector_grants`). The mode toggle is gone; lists show every row and the server writes one mode. Three additive migrations; lessons 12-15 in `docs/PROVIDER-RELIABILITY.md`; `scripts/changelog-rules.mjs` also accepts commit links to the awaisaziz/P-Dot fork. `npm run check` (1,728 tests) and `npm run build` pass; checked in a local browser with Ollama and Tavily keyless, not yet against Nebius or real Google.
- **The AI layer merged into main: a tool loop over the decision 0009 storage, memories in replies, conversation titles, session memory suggestions, and a local simulation of the production stack with Ollama and Docker.** ([commit 92281ce, the AI layer branch](https://github.com/PATELOM925/P-Dot/commit/92281ce); decision [0013](docs/decisions/0013-ai-layer-integration-and-local-simulation.md))
  - Problem: the AI layer (`tirth/ai-layer`) and the backend were built apart. The AI branch had its own memory and document tables with 4,096-dimension vectors and a single-model client without the spend guard, while main had model routing, the spend guard, the hardened memory, document and action-proposal storage, and screens that expected proposals and memory suggestions from chat. Copying the AI branch's files over main (the working tree before this change) removed main's routing, spend guard and deployment settings. There was also no way to run the whole stack without paid providers, and no deployment path with an internal database.
  - Resolution: a real merge. Main's storage, routing, executor and spend guard stay; the AI layer's tool calling, prompt guidance, titles and session summary are rebuilt on them. `src/server/providers/nebius/client.ts` streams tool calls; the executor passes tools through and commits an attempt on a tool call; `service.ts` runs up to three model calls per reply with `web_search` (one Tavily credit held each), `search_documents`, `search_memories`, `save_memory` (a `proposed` memory under the reply) and `propose_task` or `propose_reminder` (an `action_proposals` row the user approves). Memories that match the message go to the system message and the context record lists what was sent. The chat shows the model's plan as a status line (`thought` event) and the new title (`title` event). `POST /api/memories/summarize` suggests facts from a conversation as `proposed` memories. A model with the `ollama/` prefix runs on a local Ollama through the same client at zero price; `OLLAMA_EMBEDDING_MODEL` embeds locally; `NEBIUS_FIRST_TOKEN_TIMEOUT_MS` widens the first-token window for local models. `Dockerfile` and `docker-compose.yml` run the app in Docker against the local Supabase, and `deploy/` runs the app with Postgres, Supabase Auth, PostgREST, Kong and Caddy on one machine (`docs/DEPLOYMENT-VM.md`). The AI branch's migrations, repositories and tests for the old schema were not merged. Three tests now pass on Windows too (path separators, CRLF, symbolic links).
- **A check that every Unreleased changelog entry has a problem, a resolution and a link.** ([PR #13](https://github.com/PATELOM925/P-Dot/pull/13); review history in [PR #15](https://github.com/PATELOM925/P-Dot/pull/15), [review, round 1](https://github.com/PATELOM925/P-Dot/pull/15#issuecomment-6297189500))
  - Problem: entries missed required parts again and again. PR #5 review found entries without pull request links (P3, twice). PRs #7, #8, #11 and #12 reached `main` in squash `e78ebc7` without entries of their own, and six entries said that their pull request was not opened yet.
  - Resolution: `scripts/check-changelog.mjs` runs in `npm run lint`. Each top-level entry under "Unreleased" needs a bold title, a "Problem:" and a "Resolution:" line (sub-bullet or on the title line) and a pull request link, or a commit link when there was no pull request. A placeholder that says the pull request is not opened yet fails, and a review comment link does not count. The error gives the entry title, the line and what to add. The check uses no git and no network. The entries that landed in `e78ebc7` now link that commit. `AGENTS.md` lists the rule under "Rules and what enforces them".
- **Tests that make each write of a request fail, to find rows left halfway.** ([PR #13](https://github.com/PATELOM925/P-Dot/pull/13); review history in [PR #16](https://github.com/PATELOM925/P-Dot/pull/16))
  - Problem: the same mistake reached review twice. A request that failed after its first write left a row in an in-between status: a document stuck `processing` (PR #10), a proposal stuck `approved`, and an action that ran but was stored as `failed` (PR #12). Each test covered only the one step a reviewer found.
  - Resolution:
    - `tests/support/write-faults.ts` wraps the existing fakes. A test can make the Nth write fail as refused (nothing saved) or lost (saved, then the call fails). `sweepWriteFaults` starts with a run with no fault. After each run it adds a case for every write that run reached after its last fault, up to two faults and 500 cases. So a write that runs only after an error (the fallback `failed` status, the settle of stale documents) is also made to fail. A case fails when the faults that fired (step, fault and label) differ from the plan. It counts only the fakes a test wraps.
    - Sweeps for document upload and its settle in `GET /api/documents`, action decisions, chat turns (with and without web search), and memory create and edit check that no row stays in an in-between status, that the HTTP status is correct and that a retry does not repeat the effect. They use the real budgeted embedder on a fake endpoint, the fake spend guard and a fake context record store. The PR #10 and PR #12 routes fail these tests.
    - `it.fails` tests record defects that this change does not fix: a chat send that fails after its first write leaves an empty or extra conversation; a lost response on a single insert (chat message, memory) saves a second copy on resend; a lost response on the reply write leaves the reply with no "what was sent" record; an upload that answered 500 can still end `ready`, so a resend gives two ready copies.
    - `AGENTS.md` gets rows in the "Rules and what enforces them" table. Decision 0009 names the recovery path for `documents.status = 'processing'`.
    - Older proposals left `approved` keep an unknown outcome: they are never set to `failed` or run again, and the owner sets `executed` only for a row the user confirms, which no other proposal names and, for a reminder, which is not linked to another proposal. The owner statements are in `docs/decisions/0009-legacy-approved.sql`, each for one user. The database gate runs that file with a second user's rows, an edited task and a deleted task.
    - The database gate setup hook has 60 seconds, because PGlite start can pass the 10 second default when other test files run at the same time.
- **A database test gate that runs in `npm test`.** ([PR #13](https://github.com/PATELOM925/P-Dot/pull/13))
  - Problem: the same kind of database defect reached review three times. Grants let a signed-in user write rows the app trusts (`action_log` inserts, `action_proposals` updates that can reset an approved action, `context_records`). The database also accepted a nested `action_log` detail that the app's log reader refuses, so one row broke the whole list. Each time, a reviewer proved it by hand in a throwaway database.
  - Resolution:
    - `tests/integration/sql-gate.test.ts` applies every migration, unchanged and in name order, to an in-memory Postgres (PGlite 0.5.10 with pgvector 0.0.11, dev dependencies only). Stand-ins model the Supabase roles, `auth.uid()` and the Supabase default grants. A check on a new table proves that the stand-in grants are live.
    - It checks that `anon` has no access to any table or function, that one user cannot read, change, delete or insert another user's rows in every table, that `id`, `user_id` and `created_at` cannot be updated, and that search returns only the caller's rows. A new table fails the gate until it is classified.
    - It reads stored `action_log` and `action_proposals` rows, NULLs included, through the app's own repositories.
    - Three checks fail on `main` and pass with the memory hardening migration in this PR: the nested log detail, the `action_log` insert grant and the `action_proposals` update grant.
    - `tests/integration/frozen-migrations.test.ts` fails when a migration is not listed in `frozen-migrations.sha256` or its file no longer matches its hash. The message tells the author what to do.
    - Test hooks have 60 seconds (`vitest.config.ts`), because starting the database and applying every migration can take more than 10 seconds when test files run in parallel.
- **Dynamic personal bot usage showcase on the landing page.** Landed without a pull request in [commit b45b695](https://github.com/PATELOM925/P-Dot/commit/b45b695).
  - Problem: the landing page showed only a single static example ("Get me ready for Friday and book a haircut"), with non-interactive buttons, giving visitors a narrow view of what a personal bot can do across different life and work domains.
  - Resolution:
    - Added `DynamicAgentCard` with interactive scenario tabs: Weekend errands & booking, Morning triage & inbox zero, Travel & reservations, Developer ops & hotfixes, and Meeting prep & executive briefs.
    - Added an interactive human-in-the-loop approval simulator with "Approve" and "Skip" buttons that transition step status, badges, and feedback in real time to demonstrate P-Dot's safety-first architecture.
    - Added automatic carousel cycle with pause on hover/focus and support for `prefers-reduced-motion`, plus keyboard accessibility and mobile horizontal tab scrolling.
    - Added unit test coverage in `tests/unit/landing-use-cases.test.ts`.
- **Screens for approvals, memory, documents, "what was sent", the action log and reminders** (decisions [0009](docs/decisions/0009-memory-documents-actions.md) and [0005](docs/decisions/0005-assistant-hub-proposal.md)). Landed without a pull request in [commit e78ebc7](https://github.com/PATELOM925/P-Dot/commit/e78ebc7).
  - Problem: the storage and routes from decision 0009 had no screens. Users could not see or edit what P-Dot keeps, approve an action, or check what went to the model.
  - Resolution:
    - Approval cards in chat (only that conversation's) and on Today: Approve, Edit then approve, Cancel. The details shown come from the stored payload, which is what runs, not from the assistant's one-line summary. A failed run, a decision made in another tab and a lost session each get a clear message.
    - A Memory page for each mode: memories (add, keep a suggestion, edit, move to the other mode, delete) and documents (`.txt` and `.md`; file type, size and empty files are checked before anything is sent; list, delete).
    - "What was sent" under each reply. The server saves the record just after the reply, so a reply under a minute old offers "Check again" instead of treating a 404 as final.
    - An action log page, grouped by the viewer's local day, without IDs or text.
    - Reminders on Workflows, and live counts for the built-in tools on Connectors. Routines and account connectors stay previews.
    - Every page says plainly that replies do not use memories or documents yet and that the assistant does not propose actions yet.
- **Chat shows P-Dot's suggestions under the reply that made them, and the Today tab counts what is waiting.** Landed without a pull request in [commit e78ebc7](https://github.com/PATELOM925/P-Dot/commit/e78ebc7).
  - Problem: chat listed every waiting card at the end of the conversation, so in a long conversation a card was far from the reply it came from, and a decided card disappeared after a reload. Memories P-Dot suggests had no place in chat, and proposals were easy to miss on other pages.
  - Resolution:
    - Each proposal goes under the reply of the turn it was made in (by database time, since proposals have no message link). Waiting ones are cards; decided ones are short lines with the outcome.
    - Memories P-Dot suggested appear as "Remember this?" cards under the reply they came from: Keep, Edit then keep (one request, so the old text is never kept), Don't keep.
    - The Today tab shows how many proposals wait in both modes. It reloads after a decision, after a reply and when the tab comes back into view.
    - What the screens expect from the AI layer (timing, links, IDs) is written down in decision [0009](docs/decisions/0009-memory-documents-actions.md), so it can be built against them.
- **Installable app for Android (PWA) and a Devices page** ([decision 0010](docs/decisions/0010-pwa-and-device-pairing.md)). Landed without a pull request in [commit e78ebc7](https://github.com/PATELOM925/P-Dot/commit/e78ebc7).
  - Problem: P-Dot could not be installed on a phone or ask to show notifications, though the landing page says it acts on your phone.
  - Resolution: a manifest, a service worker that caches only the offline page and icons (never pages or API responses), the install prompt, notification permission with a local test notification, and a Devices page that shows what the browser supports and previews pairing. Push delivery and pairing need the open decisions in 0010.
- **Storage and shared code for memory, documents, action proposals, the action log, reminders and "what was sent"** (decision [0009](docs/decisions/0009-memory-documents-actions.md)). Landed in [commit e78ebc7](https://github.com/PATELOM925/P-Dot/commit/e78ebc7) from [PR #6](https://github.com/PATELOM925/P-Dot/pull/6).
  - Problem: the pitch needs memory the user can see and edit, search over their own documents, actions that run only after approval, a record of what happened, and a view of what was sent to the model. None of this had storage.
  - Resolution: one additive migration with pgvector, RLS on every table, append-only log and context records, and similarity search that runs as the caller. Embeddings use Qwen3-Embedding-8B at 1,024 dimensions through the spend guard. Shared types, request schemas and limits for the API routes that follow.
- **Document routes: upload, list and delete plain text or Markdown** ([PR #10](https://github.com/PATELOM925/P-Dot/pull/10)).
  - Problem: the user needs to add documents for search, and an upload that stops before its final status write must not stay "processing" for ever.
  - Resolution: the upload splits the text into chunks, embeds them through the spend guard and saves them in one statement. If both final status writes fail, the route logs the document ID only. A later list settles each of the user's documents that is still "processing" after 10 minutes: "ready" if all its chunks have embeddings, otherwise "failed". The update applies only while the status is still "processing", and it makes no embedding call.

- **"Ask first" and "Auto" approval modes in chat** ([decision 0011](docs/decisions/0011-approval-modes.md)). Landed without a pull request in [commit e78ebc7](https://github.com/PATELOM925/P-Dot/commit/e78ebc7).
  - Problem: approving every small action is tedious, but some actions must never happen unseen.
  - Resolution:
    - Easy to find and set: a one-time card in chat asks which mode to use (Ask first recommended, or keep it with one click). After that, a button next to the microphone always shows the current mode and opens a menu that explains both (touch, mouse and keyboard; Esc closes it). Settings → Approvals has the same choice as radio cards, and the Today panel shows the mode with a Change link. The choice is saved on the device; Ask first is the default.
    - The button is kept apart from the effort switch, whose "Auto" means the model choice, not approvals.
    - One shared rule set (`src/lib/approval-policy.ts`): every action kind must name its effect, or it does not compile. In Auto only adding to P-Dot's own lists runs on its own, at most 3 per reply; saving something personal, changing or deleting, outside accounts, private data, money and settings always ask, and their cards say why.
    - Auto acts only on replies to messages sent while it was on. It approves through the existing decision route, so the server still checks and logs each action, and shows "Done on its own" with Undo (the existing task and reminder delete routes).
    - No server change. Decision 0011 holds the backend recipe: the mode in the chat request, `decided_by`, running in the tool loop before `done`, sensitive reads as proposals, and tests.

### Fixed
- **Automatic deploys from GitHub (Workers Builds) failed on every merge.** ([PR #5](https://github.com/PATELOM925/P-Dot/pull/5))
  - Problem: the build settings were empty, so Cloudflare used its defaults (`npm run build`, `npx wrangler deploy`). The plain Next.js build does not make the OpenNext Worker, so each deploy failed after about 45 seconds. The first three builds on 2026-10-19 failed this way, and PR #3 and #4 were deployed by hand.
  - Resolution: the commands from `docs/DEPLOYMENT.md` and the two public Supabase build variables were set on both the Production and Previews Base tabs. A rerun of `main` (`9a8bea2`) then built and deployed in 1 minute 42 seconds. A live sign-up and chat worked after it, and the reply showed "Nemotron 3.5 Lightning · everyday request". The fix itself is a dashboard setting. [PR #5](https://github.com/PATELOM925/P-Dot/pull/5) records it ([review, round 1](https://github.com/PATELOM925/P-Dot/pull/5#issuecomment-6258531931)).
- **Only the database writes the action log and the outcome of an action (contract step)** (decision [0009](docs/decisions/0009-memory-documents-actions.md)). PR: [#17](https://github.com/PATELOM925/P-Dot/pull/17).
  - Problem: after the database step (PR #18) and the code step (PR #13), the old insert grant on the action log and the old update grant on action proposals still let a signed-in user write a log row or move a proposal forward outside `decide_action_proposal`. They stayed only so that the older code kept working during the deploy.
  - Resolution: migration `20261021010000_memory_hardening_contract.sql` removes the insert grant and policy on `action_log` and the update grant and policy on `action_proposals`. Merge it only after the PR #13 code serves all traffic and older requests have ended (`docs/DEPLOYMENT.md`). Outcomes written by callers before this step keep `decided_by_function = false`, so they never read as verified. The database gate checks that both paths are gone, that the old two-write decision is refused, that an old request crossing this step leaves no false verified record, and that a log row a caller inserted before this step with a `verified` key reads as not verified after it.
- **Owner SQL could not mark a legacy action as done on a new database session.** PR: [#13](https://github.com/PATELOM925/P-Dot/pull/13).
  - Problem: the expand migration (PR #18) sets `action_proposals.decided_by_function` and `action_log.verified` from a session setting. On a session where no statement has set it, Postgres returns NULL, so both markers became NULL and the write failed the NOT NULL check. `confirm_executed` in `docs/decisions/0009-legacy-approved.sql` failed this way. App requests were not affected: the API roles always get `false`, and the database functions set the value first. An automated review on PR #18 found it.
  - Resolution: migration `20261021000500_marker_unset_setting.sql` replaces the two trigger functions. An unset value now counts as not set. `tests/integration/sql-gate-fresh-session.test.ts` runs both writes as the first statement on a new database.
- **One owner for the worst-case Nebius hold, and no hold is reduced to fit the ceiling.** PR: [#13](https://github.com/PATELOM925/P-Dot/pull/13) (review history in [#14](https://github.com/PATELOM925/P-Dot/pull/14)).
  - Problem: the spend hold was less than the real worst-case cost three times. A fallback price was below real prices and negative usage became zero (PR #2, 1945dda). The embedder copied the chat clamp and cut a hold down to the $0.25 ceiling (PR #6, 0dce68a). Chat still clamped, and the embedder kept its own copy of the hold math.
  - Resolution:
    - `src/server/assistant/spend.ts` owns the hold: `nebiusHoldMicroUsd` (chat) and `nebiusEmbeddingHoldMicroUsd` (embeddings). Above the ceiling they throw `NebiusHoldTooLargeError`. The embedder settles through `nebiusSettleMicroUsd`.
    - Chat answers 413 before any reserve call. No valid chat turn reaches the ceiling: the largest one holds 138,233 micro-dollars.
    - A search source URL is checked again after normalization. A 2,048-character URL with 3-byte characters grew to 18,312 bytes, so the first chat hold could be below the cost of the prompt it paid for. A test with worst-case results through the real Tavily adapter proves the first hold covers the final prompt.
    - A test reads the source and fails when another file uses `MAX_NEBIUS_HOLD_MICRO_USD`, the ceiling as a number, or `costMicroUsd` (`pricing.ts` may only declare it). Boundary tests: 250,000 is reserved, 250,001 is refused.
- **Database expand step for the memory hardening** (decision [0009](docs/decisions/0009-memory-documents-actions.md)). PR: [#18](https://github.com/PATELOM925/P-Dot/pull/18).
  - Problem: the code that makes only the database write the action log and decide action proposals (PR #13) needs a new database function and log triggers. If that code went live before its migration, its writes would succeed with no log row. The migration must also not break the code on main.
  - Resolution: migration `20261021000000_memory_hardening.sql` only adds. It adds the log triggers, `decide_action_proposal`, the `decided_by_function` trust marker, a protected `verified` column on the log (true only for a row the log triggers wrote, and for an action outcome only when the function decided it; a `verified` key in the detail is removed, so a caller cannot supply it), triggers that check new rows and changed columns only, a forward-only proposal status, explicit grants, and it removes TRUNCATE, REFERENCES and TRIGGER from the API roles. It keeps the older grants, so main keeps working. The database gate checks main's code against it. `docs/DEPLOYMENT.md` gives the order: this PR, then PR #13, then PR #17, with a check before each merge and the rollback rule.
- **Only the database writes the action log and the outcome of an action (code step)** (decision [0009](docs/decisions/0009-memory-documents-actions.md), reviews of PR #6, PR #12 and PR #13). PR: [#13](https://github.com/PATELOM925/P-Dot/pull/13).
  - Problem: a signed-in user could use the public API to forge an executed action or a log event, reset an action to "proposed" and run it twice, and store short private text or nested values in the log. The decision route ran the action and wrote its result in separate steps, so a lost write could store a false or missing outcome. A late memory vector, or an edit that did not change the text, could leave text next to another text's vector. Rejecting an older proposal could answer 500 after the rejection was saved. The screens showed an outcome that a caller wrote as a completed action. The embedder cut a worst-case spend hold down to the ceiling instead of refusing.
  - Resolution:
    - The code uses the database step of PR #18 and merges only after that migration is applied (see `docs/DEPLOYMENT.md`).
    - The decision route calls `decide_action_proposal` once. It answers 200 with the ID and status for an older row whose payload cannot be shown, never 500 after a committed decision. Proposals and log entries have `verified`, read from protected database columns. The screens say "Done" and "Action completed" only for a confirmed outcome; an unconfirmed one shows "Marked done" in chat and "Marked as completed" in the action log, with "P-Dot did not confirm this action."
    - An approved memory is embedded after the response, and the vector is written only while the memory still has that text. A memory edit does not write unchanged text, and applies only while the text is the one it read; otherwise it answers 409.
    - The app no longer writes the log. The action log page skips a row that does not parse, and shows the new "Document ready to search" and "Document could not be processed" events.
    - The embedder refuses a batch whose worst-case hold is above the ceiling, before any reservation. The documents route answers 413.
    - Also brought over from PRs #9 and #10, which target code that is already on main: a memory edit checks ownership before it embeds, and documents left "processing" are settled later.
    - Tests run the repositories and routes against the real SQL of the gate.
- **Dictation was blocked by P-Dot's own security header.** Landed without a pull request in [commit e78ebc7](https://github.com/PATELOM925/P-Dot/commit/e78ebc7).
  - Problem: `next.config.ts` sent `Permissions-Policy: microphone=()`, which turns the microphone off on every page, so the microphone button showed as available but Chrome refused it, and the message told users to change their own browser settings. Words heard after Send also landed in the next message.
  - Resolution: the header now allows the microphone for P-Dot's own pages only (`microphone=(self)`; camera and location stay off), with a test. The button is disabled when a page cannot use the microphone. While listening, the words being heard show under the message box; finished phrases are added within the message length limit; Esc, Send and switching conversations stop listening and drop any later words; stopping on purpose shows no error; Chrome on Android listens for one phrase per tap, because continuous listening there repeats words.

### Changed
- **Merge several pull requests first, then deploy once.** ([PR #5](https://github.com/PATELOM925/P-Dot/pull/5), [review, round 1](https://github.com/PATELOM925/P-Dot/pull/5#issuecomment-6258531931), [round 2](https://github.com/PATELOM925/P-Dot/pull/5#issuecomment-6258580241), [round 3](https://github.com/PATELOM925/P-Dot/pull/5#issuecomment-6258608769))
  - Problem: each merge into `main` started a production build. Builds of in-between states used build minutes and CI time, and could deploy before the last merge.
  - Resolution: owner rule, 2026-10-19. When pull requests or a stack are ready at about the same time, merge them all and let one build deploy them. Added to `AGENTS.md` and `docs/DEPLOYMENT.md`, with checks before each merge, a top-down merge for stacks that gives one production build, best-effort cancelling of older builds, and confirming that production runs the final `main`.
- **Each upper merge in a stack gets its own review and checks.** ([PR #5](https://github.com/PATELOM925/P-Dot/pull/5), [review, round 4](https://github.com/PATELOM925/P-Dot/pull/5#issuecomment-6258642398))
  - Problem: after an upper merge, the next pull request has a new head and a larger diff, so an earlier verdict and earlier checks no longer cover it. The guide also cited GitHub's native stack guide as if native stacks used the same steps.
  - Resolution: `docs/DEPLOYMENT.md` says to inspect the new head and combined diff, post a verdict for that head and wait for its `Workers Builds: pdot` check before each merge. It separates ordinary stacks (top down) from GitHub native stacks (group merge). A set of pull requests with a database expand or contract step does not merge as one deploy, and `AGENTS.md` says so too; each step follows [Expand, then contract](docs/DEPLOYMENT.md#expand-then-contract).
- **The deployment guide records the one-time setup steps and the Workers Builds failure.** ([PR #5](https://github.com/PATELOM925/P-Dot/pull/5), [review, round 1](https://github.com/PATELOM925/P-Dot/pull/5#issuecomment-6258531931))
  - Problem: the guide did not say which one-time setup steps were done, and it did not explain why the first builds failed.
  - Resolution: `docs/DEPLOYMENT.md` now marks which steps are done and has a "Known failure" note for the Workers Builds failure.
- **Icons and colours follow the design palette.** Landed without a pull request in [commit e78ebc7](https://github.com/PATELOM925/P-Dot/commit/e78ebc7).
  - Problem: the icons used the old flat blue, the manifest colour made the bar flash when the app opened, and the manifest locked the screen to portrait.
  - Resolution: the favicon, Apple icon and app icons put the "P." mark on the indigo-to-violet accent gradient. The manifest uses the page ground colour and no longer locks the screen to portrait.

## 2026-10-19

### Added
- **Model routing for Nemotron on Nebius Token Factory** ([PR #3](https://github.com/PATELOM925/P-Dot/pull/3), merged as `6e5224d`).
  - Problem: one fixed model for every message was either too slow and costly for small questions or too weak for hard ones. A provider error ended the reply with no second try.
  - Resolution: a rule-based router picks a tier with no extra model call:
    - fast: Lightning → Nano → Super
    - standard: Super → Lightning
    - heavy: Ultra → Super, with a thinking budget
    - vision: Super VL
  - Retries happen only before the first visible token. The router uses backoff with jitter, honors `Retry-After`, caps the attempts, sends one hedged request on the fast tier only, and skips a failing model for a short time with a circuit breaker.
  - Every attempt goes through the spend guard. Each reply shows which model answered and why.
  - Decision: [0007](docs/decisions/0007-model-routing.md).
- **Fixed during review (PR #3):**
  - A failed hedge reset the other model's retry wait, so it retried too early. Each model now keeps its own wait. ([round 1](https://github.com/PATELOM925/P-Dot/pull/3#issuecomment-6257890039))
  - Error events inside the stream were misread. "Model not found" stopped instead of moving to the next model, and "out of credit" was retried. Errors are now classified by status and label. ([round 1](https://github.com/PATELOM925/P-Dot/pull/3#issuecomment-6257890039))
  - Chat failed if the code went live before its migration. Reads and inserts now fall back to the old columns, for a missing route column only. ([round 1](https://github.com/PATELOM925/P-Dot/pull/3#issuecomment-6257890039), [round 2](https://github.com/PATELOM925/P-Dot/pull/3#issuecomment-6258000501))
- **`docs/PROVIDER-RELIABILITY.md`.** Ten lessons from review findings and measurements, each with a rule and sources: retries, backup models, hedged requests, error labels, pricing, usage parsing, migrations, `waitUntil`, the circuit breaker and the deploy guard. There are also checklists for adding a model, an error rule or a migration. ([PR #4](https://github.com/PATELOM925/P-Dot/pull/4))
- **This changelog**, and a rule in `AGENTS.md` that every pull request updates it. ([PR #4](https://github.com/PATELOM925/P-Dot/pull/4))
- **Global spend guard for Nebius and Tavily** ([PR #2](https://github.com/PATELOM925/P-Dot/pull/2), merged as `00a2865`).
  - Problem: the only limit was per user, and sign-up is open for judges. Anyone could make many accounts and use up the owner's $25 Nebius credit, and then the card is charged.
  - Resolution: Postgres counters with caps for all users together:
    - Nebius: $1 a day and $20 in total
    - Tavily: 40 credits a day and 800 a month
    - each user: $0.25 and 10 credits a day
  - Each paid call reserves its worst-case cost first and settles the real cost after. Errors, Stop and missing usage keep the full hold.
  - The Supabase GitHub integration applied the migration on merge (confirmed with `supabase migration list` about 30 seconds later).
  - Decision: [0006](docs/decisions/0006-global-spend-guard.md).
- **Fixed during review (PR #2):**
  - An unknown model got a fallback price below real catalog prices, so spending could pass the cap. Unpriced models are now refused. ([round 1](https://github.com/PATELOM925/P-Dot/pull/2#issuecomment-6257586511))
  - Negative usage counts were clamped to zero, so a malformed reply was free. Invalid usage now keeps the full hold. ([round 1](https://github.com/PATELOM925/P-Dot/pull/2#issuecomment-6257586511), [round 2](https://github.com/PATELOM925/P-Dot/pull/2#issuecomment-6257656084))
- **Nemotron reasoning control** (PR #2).
  - Problem: with thinking on by default, Nemotron Nano used the whole output limit on reasoning and returned an empty reply.
  - Resolution: chat sends `enable_thinking: false`. Reasoning text is never shown or saved.
- **Apache-2.0 license, custom domain, deploy guard and deployment guide** ([PR #1](https://github.com/PATELOM925/P-Dot/pull/1), merged as `4934a80`).
  - Problem:
    - The hackathon requires a visible open-source license.
    - The site needed its own address.
    - The OpenNext build copies `.env` file values into the uploaded Worker, so a local key could ship inside the code.
  - Resolution:
    - `LICENSE` added (Apache-2.0).
    - Worker `pdot` served only on `pdot.iampatelom.com`.
    - `npm run deploy` stops when a non-allowed variable has a value in the bundle.
    - `docs/DEPLOYMENT.md` describes the PR, preview and merge flow and the rules for agents.
    - `AGENTS.md` requires a pull request and review before merge.
  - Review fixed gaps in the guard (it now uses an allow list) and the Preview settings.
- **First deploy** to https://pdot.iampatelom.com (Cloudflare Workers free plan, about 2.3 MB compressed).

### Changed
- **"Think harder" applies to one message only.**
  - Problem: the switch stayed on until the user turned it off, so a forgotten switch kept using the most expensive model (Ultra).
  - Resolution: the switch goes back to "Auto" when the server accepts the message. Owner decision, 2026-10-19.
  - PR: routing follow-ups ([PR #4](https://github.com/PATELOM925/P-Dot/pull/4)).
- **Decision 0007 (model routing) is accepted.** Web search raises an otherwise fast message to the standard tier (Nemotron 3 Super), because summarizing sources needs the better model. "Think harder" and the stronger reasoning rules can still choose the heavy tier for a search turn. Owner decision, 2026-10-19.
- **Merged Personal and Work modes, tasks, rename and dictation into `main`** (Awais's frontend, `ec3ea0e`). It was a fast-forward. Lint, types, 131 tests and the build passed before the merge (run locally on 2026-10-19). The Supabase GitHub integration applied both migrations (confirmed with `supabase migration list`).

### Security
- **Real keys were found in the tracked `.env.example` before any commit.** The values were moved to git-ignored files, and the template went back to blank values. The admin key, database password and connection strings now live only in `.env.admin.local`, which the app never reads. `git status` showed the file as changed but never committed, and nothing was pushed, so no key needed rotation.

## 2026-10-16

### Added
- Personal and Work modes, conversation rename, a to-do list for each mode, browser dictation, and preview-only Workflows and Connectors pages (Awais Aziz, `ec3ea0e`). Decision: [0005](docs/decisions/0005-assistant-hub-proposal.md).

## 2026-10-15

### Added
- Backend and minimal frontend (Awais Aziz, `792c5fc`):
  - Supabase auth and Postgres with row-level security
  - streamed chat on Nebius
  - opt-in Tavily web search
  - conversation history and deletion
  - per-user request limits
  - Cloudflare Workers deployment setup

  Decisions: [0001](docs/decisions/0001-supabase-auth-and-database.md) to [0004](docs/decisions/0004-cloudflare-workers-deployment.md).

## 2026-10-09

### Added
- Project instructions, PRD and repository scaffold (Awais Aziz, `0c98cbd`).
