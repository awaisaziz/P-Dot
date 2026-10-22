# P-Dot — Personal Assistant Bot

Status: Draft for review

Date: 2026-10-09 (updated 2026-10-14)

Phase: MVP implementation in progress (authorized 2026-10-14)

## 1. Product summary

P-Dot is a web-based personal assistant that helps an individual ask questions, research topics, draft content, and plan everyday work through a conversational interface. Nebius provides model inference, Tavily provides web search when requested, and Cloudflare Workers hosts the frontend and backend API.

The initial product supports assistance within a conversation. It does not independently execute tasks in external applications.

## 2. Confirmed requirements and assumptions

Confirmed by the user:

- A frontend webpage with login-related functionality.
- A backend hosted on Cloudflare (originally Vercel; changed 2026-10-15, see `docs/decisions/0004-cloudflare-workers-deployment.md`).
- An AI layer using Nebius and Tavily.
- Repository instructions, an initial directory structure, and this PRD.
- Backend and minimal frontend implementation (requested 2026-10-14).
- Supabase for authentication and database, and streamed assistant replies (decided 2026-10-14; see `docs/decisions/`).
- Requested 2026-10-21 (built on `awais/agentic-workspace`, each in a proposed decision for review):
  - Agentic workflows that search the web and must not hallucinate, starting with flight search ([decision 0015](decisions/0015-grounded-workflows.md)).
  - Every explanation of how something works condensed to one line, and a nicer interface.
  - One workspace instead of Personal and Work tabs ([decision 0014](decisions/0014-one-workspace.md)).
  - Connectors the user can browse and connect, starting with Google Calendar, Docs, Slides and the rest of Google ([decision 0016](decisions/0016-google-connectors.md)).
  - Inference on Nebius Token Factory and web search on Tavily, which Nebius owns since 2026-02-19 (still a separate key and bill).

Proposed assumptions requiring review before implementation:

- Next.js and TypeScript will support the web UI and API in one repository.
- The MVP is text-based and supports multiple private user accounts.
- Email/password authentication, saved conversation history, and basic profile settings are sufficient initially.
- Users explicitly enable web search for a message; automatic search routing can follow later.
- No separate task manager or long-term personal memory is required for the MVP.

## 3. Target user and problem

The initial target is an individual who wants one workspace for everyday questions, research, writing, and planning. Current workflows require switching between a search engine, an AI chat tool, and notes. P-Dot should provide a straightforward conversation experience with accessible sources and private history.

## 4. Goals

- Make it easy to start a useful conversation after signing in.
- Answer general questions through Nebius-hosted inference.
- Support research with Tavily results and visible source links.
- Let users revisit and delete their own conversations.
- Make loading, failures, search use, and data retention understandable.

## 5. MVP scope

### Authentication and account access

- Landing page with sign-in and signup entry points.
- Signup, login, logout, email verification if required by the provider, and password recovery.
- Protected workspace and server-enforced authentication for all private endpoints.
- Clear validation and authentication error states without revealing whether an account exists.

Acceptance: A signed-out user cannot access private conversations or invoke the assistant API. Signing out invalidates access from the current session. A user can complete the configured recovery flow.

### Assistant conversations

- Start a new conversation, send a message, and receive a model-generated reply.
- Use recent conversation context within a documented token budget.
- Show pending and failed states, preserve the user's draft on failure, and allow explicit retry.
- Render output safely. Markdown support is optional; arbitrary HTML execution is prohibited.
- No fabricated completion states when providers are unavailable.

Acceptance: An authenticated user can complete a multi-turn exchange. An invalid request or upstream failure produces a useful error without exposing credentials or raw provider internals.

### Web research

- Offer an explicit web-search toggle for each request.
- Retrieve a bounded number of results through Tavily and pass relevant excerpts to Nebius.
- Display source titles and safe HTTP(S) links alongside the response.
- Distinguish retrieved source material from model interpretation. Do not present source links as proof of claims they do not support.
- Clearly report search failures; do not silently describe an answer as web-grounded if retrieval failed.

Acceptance: Search-enabled requests show the retrieved sources used as context. Search-disabled requests do not call Tavily. Retrieved content cannot authorize tool use or override application instructions.

### Conversation history

- Persist conversation messages under the authenticated account.
- List and reopen previous conversations.
- Allow users to delete a conversation through a clear confirmation step.
- Enforce ownership for listing, reading, writing, and deletion.

Acceptance: User A cannot access or modify user B's data, including through direct API requests with guessed IDs. Deleted conversations disappear from active storage; backup retention must be documented.

### Basic settings

- Display account identity and provide logout.
- Explain which content is sent to inference and search providers.
- Document history retention and deletion behavior before public release.

## 6. Primary journey

1. A visitor opens the landing page and creates an account or signs in.
2. The user enters the workspace and starts a conversation.
3. The user enters a question and optionally enables web search.
4. The backend verifies the session, validates input, and checks the user's usage limit.
5. If requested, the backend retrieves web context from Tavily.
6. The backend invokes Nebius and returns the answer and any source references.
7. The user continues the conversation, reopens it later, or deletes it.

## 7. Nonfunctional requirements

- Security: TLS, server-only secrets, verified authentication, ownership enforcement, and safe output rendering.
- Privacy: Avoid logging raw conversations, tokens, and search queries. Document provider data handling and retention choices.
- Reliability: Bound input size, history context, search result count, output tokens, and upstream duration. Handle provider throttling and timeouts explicitly.
- Cost: Enforce a persistent per-user limit before paid provider calls. Set provider account budgets before public access.
- Accessibility: Keyboard-operable controls, visible focus, form labels, readable contrast, and accessible status messages.
- Responsiveness: Usable layouts on mobile and desktop.
- Operations: Health endpoint without secrets; structured request IDs, duration, and status metadata for debugging.
- Performance: Define measurable latency targets after testing a selected model; do not promise unmeasured response times.

## 8. Out of scope for MVP

Amended 2026-10-21 (proposed, decisions 0014-0016): **reading** a connected Google account (Calendar and Drive files, including Docs, Slides and Sheets) is in scope while the user's Google chip is on, and multi-step web workflows (flight checks, verified research) are in scope. Fares are shown as quoted on travel pages with their source and time; P-Dot never books or pays. Changing anything in an outside account is still out of scope.

- Autonomous actions, email sending, calendar edits, purchases, or other external account mutations.
- Background reminders and scheduled jobs.
- Voice, file uploads, multimodal input, and document indexing.
- Cross-conversation memory or inferred personal profiles.
- Team workspaces, shared conversations, billing, and native mobile apps.
- Custom model training, fine-tuning, or a self-hosted inference service.

## 9. Success measures

Track only the minimum privacy-preserving metadata needed to evaluate:

- Signup-to-first-successful-conversation completion.
- Successful assistant requests versus validation, authentication, and provider failures.
- Response latency and provider cost per completed request.
- Search-enabled response usefulness through optional user feedback.
- Returning users and reopened conversations, if analytics is approved.

Numerical targets and analytics tooling remain undecided until a baseline and privacy approach are agreed.

## 10. Delivery phases

1. Planning: Review this PRD, repository instructions, structure, and unresolved decisions.
2. Foundation: Initialize the approved framework, environment validation, UI shell, and authentication.
3. Assistant: Add authenticated chat orchestration and the Nebius adapter.
4. Research and history: Add Tavily retrieval, source display, persistence, and deletion.
5. Release preparation: Verify access boundaries, accessibility, error handling, usage limits, and Cloudflare deployment configuration.

Implementation of phases 2–4 was authorized on 2026-10-14; phase 5 (release preparation) remains.

## 11. Open decisions

Resolved on 2026-10-14:

- Authentication and database provider: Supabase ([decision 0001](decisions/0001-supabase-auth-and-database.md)).
- Streaming versus complete-response delivery: streaming ([decision 0002](decisions/0002-streaming-responses.md)).

Still open (provisional implementation defaults are listed in [decision 0003](decisions/0003-provisional-defaults.md)):

- Nebius model identifier, model availability, inference budget, and context window.
- Conversation retention, backup retention, and account deletion policy.
- Per-user request limits, total service budget, and initial audience size.
- Hosting region and any data-residency requirements.
- Whether practical planning remains chat-only or later grows into a task/reminder feature.
- From 2026-10-21: a flight-data provider for bookable fares (SerpApi or Duffel, decision 0015); the Google scope before public launch (`drive.readonly` with a CASA assessment, or `drive.file` with the Picker, decision 0016); Zero Data Retention on the Nebius account before connector content reaches other users; whether connector reads without a card (the visible Google chip, decision 0011 amendment) are acceptable.

## 12. Release acceptance

The MVP is ready only when signup/recovery/login/logout work, the assistant API rejects unauthorized access, both provider paths are verified with real credentials, conversation ownership is tested, history and deletion work, and documented validation passes in a Cloudflare preview deployment. None of these conditions is claimed complete yet: the implementation has been verified only with unit tests and mocked providers.
