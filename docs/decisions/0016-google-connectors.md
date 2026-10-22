# 0016 — Google connectors: Calendar and Drive (Docs, Slides, Sheets) first

- Status: Proposed (2026-10-21). Requested by the owner: "connectors where they can search different connectors and then do a connection with, and we will start with the basic one, which is Google Calendar, Google Doc, Google Slide, and anything with Google". Built on `awais/agentic-workspace`; needs the owner's review and a Google Cloud OAuth client before it can be used.
- Related: [0005 assistant hub](0005-assistant-hub-proposal.md) (connector security questions), [0009](0009-memory-documents-actions.md) rule "a kind that changes an outside account needs its own decision", [0011 approval modes](0011-approval-modes.md), [DEPLOYMENT.md](../DEPLOYMENT.md) (secrets).

## Why

The Connectors page has only previews. The owner wants real account linking, starting with Google. The PRD's section 8 excluded external accounts from the MVP; this decision amends that for read access and records what is still excluded.

What was checked (2026-10-21): Google's web-server OAuth flow is unchanged (authorization code, `access_type=offline`, `prompt=consent` for the first grant, refresh tokens that last until revoked, 7 days while the app is in Testing). Scope tiers decide the verification cost: `calendar.events` is sensitive (brand and scope review, days to weeks); `drive.readonly` is restricted (annual CASA security assessment, roughly $500-$4,500 a year, before a public launch). `drive.file` is non-sensitive but only sees files the app created or the user picked with Google's Picker. Supabase's Google sign-in exposes provider tokens only to the browser session and does not refresh or store them, so connectors need their own server-side flow. Google's Workspace MCP servers are Developer Preview only and may not be used in public apps. Cloudflare Workers have the WebCrypto AES-GCM needed to encrypt tokens.

## Decision

### Scope of this change: read access, approval for anything else

Connect a Google account once; then the assistant may read the user's calendar and Drive files when a message needs them. It may not change anything in Google in this change. A later decision adds the write path (create an event, send mail) with the `external` effect of decision 0011, which always asks.

Scopes requested: `https://www.googleapis.com/auth/calendar.events` (read events; also covers the later write path) and `https://www.googleapis.com/auth/drive.readonly` (search files and export Docs, Slides and Sheets as text), plus `openid email` to learn which account was connected. `drive.readonly` is restricted: while the Cloud project is in Testing (at most 100 test users, refresh tokens expire after 7 days) it works without verification; before a public launch the owner must either pass the CASA assessment or switch to `drive.file` plus the Picker. The Connectors page says which.

### Flow

- `POST /api/connectors/google/start` (same origin, signed in): builds a random `state` and a PKCE verifier, stores both with the requested scopes in an HTTP-only, signed, 10-minute cookie (`pdot_oauth`, HMAC with the token key below), and returns the Google authorization URL (`access_type=offline`, `include_granted_scopes=true`, `code_challenge_method=S256`, `prompt=consent`). The browser navigates there.
- `GET /api/connectors/google/callback?code&state`: verifies the cookie signature, matches `state`, exchanges the code with the client secret and the verifier, reads the granted `scope` string (granular consent may be a subset), fetches the account email with the token, encrypts the refresh token, upserts the grant, clears the cookie and redirects to `/connectors?connected=google`. Any failure redirects to `/connectors?error=<code>` with nothing stored and nothing logged beyond the error code.
- `DELETE /api/connectors/google`: revokes the refresh token at Google (best effort), deletes the grant, answers 204.
- `GET /api/connectors`: the user's grants without any token: provider, account email, scopes, status, last used.

### Storage

Migration `20261022001000_connector_grants.sql`:

- `connector_grants`: `id`, `user_id` (RLS), `provider` (`google`), `account_email`, `scopes text[]`, `refresh_token_ciphertext bytea`, `access_token_ciphertext bytea null`, `access_token_expires_at`, `key_version smallint`, `status` (`active`, `needs_reconnect`, `revoked`), `last_used_at`, `created_at`, `updated_at`; unique `(user_id, provider, account_email)`. RLS own-row policies; `revoke all` from `anon` and `authenticated`; column-level `select` that leaves out both ciphertext columns; `insert`, `delete`, and column-level `update` on the token, expiry, status and last-used columns.
- `connector_grant_secrets(p_id uuid)`: SECURITY DEFINER, `set search_path = ''`, returns the two ciphertexts of the caller's own active grant (`user_id = auth.uid()`); execute granted to `authenticated` only. It is the only way to read a ciphertext, so no repository column list can return one by accident.
- Action log: the event check gains `connector_added` and `connector_removed`; a SECURITY DEFINER trigger `log_connector_change` writes `{grantId, provider, scopeCount, status}` through `write_action_log`. Never the email or a token.
- Tokens are encrypted in the Worker with AES-256-GCM (WebCrypto), a fresh 12-byte IV per encryption, the user ID and grant purpose as additional data, and a key from the new Worker secret `CONNECTOR_TOKEN_KEY` (base64, 32 bytes; also used for the state cookie HMAC). `key_version` allows rotation. The app has no service-role key, so a signed-in user could read their own ciphertext through PostgREST; they cannot decrypt it, and no route or DTO ever returns a token in any form.
- Settings: `GOOGLE_CLIENT_ID` (not a secret; on the allow list), `GOOGLE_CLIENT_SECRET` and `CONNECTOR_TOKEN_KEY` (Worker secrets). The redirect URI is `${SITE_URL}/api/connectors/google/callback`. `GET /api/health` reports `connectors.google` as a boolean.

### Tools (offered only when the user has an active Google grant)

- `calendar_list_events({time_min, time_max, query?})`: `events.list` on `primary` with `singleEvents=true&orderBy=startTime`, at most 25 events, returned inside `<connector_results provider="google-calendar">` as data: title, start, end, location, link.
- `drive_search_files({query})`: `files.list` with `q = "trashed = false and (name contains '…' or fullText contains '…')"`, at most 10 files: name, type, modified, link, id.
- `drive_read_file({file_id})`: `files.export` to `text/plain` for Docs, Slides and Sheets, or `files.get?alt=media` for plain text and Markdown; at most 12,000 characters are returned, inside `<connector_results>`.
- Access tokens are refreshed when within 60 s of expiry; an `invalid_grant` answer marks the grant `needs_reconnect` and the tool answers "Google needs to be reconnected on the Connectors page". Every call sets `last_used_at`.
- Connector data is untrusted: neutralised, delimited, size-capped, never instructions. The context record of the reply counts connector tool calls.

### Screens

- Connectors: one Google card with Connect (or the account email, the scopes in plain words, "Needs reconnect" when the refresh failed, and Disconnect). The other planned accounts keep one-line "Coming soon" cards. `?connected=google` and `?error=` show a one-line notice.
- Today: when Google is connected, a "Coming up" panel lists the next events of the day (one read on page load; a failure shows one line, never fake events).
- Settings, How your data is used: one bullet for Google (what is read, that tokens are encrypted, that content read for a reply is sent to Nebius for that reply only, and where to disconnect).

### Rules

- Reads only. A write to Google needs a new action kind with the `external` effect, an expand migration that teaches `normalize_action_payload` and `decide_action_proposal` the kind, and a completion function for the external outcome; the in-progress status of such a proposal must name its recovery path (AGENTS.md).
- No token leaves `src/server`; no token, email or Google response body is logged.
- A grant in `needs_reconnect` stays until the user reconnects or disconnects; nothing retries silently.
- Google's Limited Use policy: Workspace content is used only to answer the user's request; Nebius retains inputs by default for speculative decoding (Zero Data Retention is an opt-in the owner should request before public launch).

## Amendments after review (2026-10-21)

Three critics reviewed this decision. These changes replace the parts above where they differ.

- **Scopes:** `calendar.readonly` (not `calendar.events`), `drive.readonly`, `openid`, `email`. The write path adds `calendar.events` later by incremental authorisation. Each tool is offered only when its scope is in the granted `scopes`; the Connectors page shows each product's status from them.
- **Approval:** connector reads happen only while the user's Google chip in the composer is on (decision 0011, amendment of 2026-10-21). After a connector read, the reply is *tainted* (decision 0015): no web search, flight check or research and no Auto for the rest of it. A further connector read is allowed (since 2026-10-22), so a Drive search can be followed by reading the file it found.
- **One Google account per user** in v1: `unique (user_id, provider)`. A reconnect with another account replaces the grant and revokes the old token.
- **Storage:** add `account_sub text not null` (Google `sub` from the ID token). Tokens are written only through the SECURITY DEFINER function `store_connector_tokens(p_id, p_refresh, p_access, p_expires, p_key_version)`; there is no UPDATE grant on either ciphertext column. Column UPDATE only on `account_email, scopes, status, last_used_at, access_token_expires_at`. `connector_grant_secrets(p_id)` returns `id, key_version` and both ciphertexts for the caller's own row in **any** status (Disconnect must revoke a `needs_reconnect` grant), with `if auth.uid() is null then raise …`. Every function revokes execute from `public, anon`; the trigger function also from `authenticated`. Statuses: `active`, `needs_reconnect` (no `revoked`). The log trigger fires `after insert or delete` and `after update of status, scopes` when they change: `connector_added`, `connector_removed`, `connector_changed`, detail `{grantId, provider, scopeCount, status}`.
- **Keys:** `CONNECTOR_TOKEN_KEYS` (Worker secret, JSON `{"1":"<base64 32 bytes>"}`) and `CONNECTOR_TOKEN_KEY_VERSION` (plain variable). HKDF-SHA256 derives a non-extractable AES-GCM key (`pdot/connector-token/v<k>`) and an HMAC key (`pdot/oauth-state/v<k>`). Additional data: `pdot.connector.v1|<user_id>|google|<account_sub>|<refresh|access>|<key_version>`. A row with an older key version is re-encrypted on its next token write. A decrypt failure or an unknown key version changes nothing (no status change, no upsert, no delete) and the tool answers "Google is not available here".
- **Previews:** `CONNECTOR_TOKEN_KEYS` and `GOOGLE_CLIENT_SECRET` are never set in the Preview base config (previews share the production database); without them connectors report "not configured". `POST /start` refuses a request whose host is not the `SITE_URL` host.
- **Who may connect:** until Zero Data Retention is confirmed on the Nebius account, Connect works only for user IDs listed in `CONNECTOR_ALLOWED_USER_IDS` (plain variable; `*` allows everyone). Others see one line: "Google is not open to your account yet."
- **State cookie:** `__Host-pdot_oauth`, `Path=/`, `Secure`, `HttpOnly`, `SameSite=Lax`, `Max-Age=600`. Payload `{v, uid, state (32 random bytes), verifier, iat}` signed with the HMAC key and checked with `crypto.subtle.verify`. The callback needs a session, `uid === auth.userId`, `iat` within 600 s and a matching `state`; the cookie is cleared on every outcome; scopes are a server constant, not in the cookie. Redirects go only to `${SITE_URL}/connectors?connected=google` or `?error=<code>` with a code from a closed set (`state_mismatch`, `denied`, `admin_blocked`, `not_a_tester`, `scopes_missing`, `exchange_failed`, `storage_failed`, `not_signed_in`), each with one line of copy; Google's error text is never passed on. If storage fails after a successful exchange, the new token is revoked.
- **Disconnect:** `DELETE /api/connectors/google` revokes by POSTing `token=<refresh>` in a form body (never the query string), then deletes the row; if revocation fails, one line points to myaccount.google.com/permissions.
- **Tools:** `calendar_list_events` reads the user's selected calendars from `calendarList` (at most 10) and tags each event with its calendar and `from_others` when the organizer is not the user; all-day events are marked. `drive_search_files` escapes `\` and `'`, splits the words into at most 4 `fullText contains` terms, takes an optional `kind` (doc, slides, sheet, any), and with no hit says "No match for these words in Drive", never that a file does not exist. `drive_read_file` validates `file_id` against `^[A-Za-z0-9_-]{10,128}$`, exports Docs and Slides as `text/plain` and Sheets as `text/csv` (first sheet), reads at most 48 KB and cuts at 6,000 characters with "first 6,000 of N characters". Requests are GET only to `www.googleapis.com`, built with `new URL` and `URLSearchParams`.
- **Today "Coming up":** `GET /api/connectors/google/upcoming?tz=<IANA>` lists the next 24 hours (at most 5 rows, all-day first). Failure states: "Google needs reconnecting · Reconnect" and "Could not load your calendar · Retry"; while the Cloud project is in Testing, one line says access expires every 7 days.
- **Connectors page:** a searchable directory with cards for Google Calendar, Docs, Slides, Sheets and Drive behind one Google sign-in, each with its status from the granted scopes, and one-line "Coming soon" cards for the rest.
- **Privacy copy:** "Content read for a reply is sent to Nebius to write that reply. The reply, and anything it quotes, is saved in your conversation and sent again as context in later messages there. Disconnecting stops new reads but does not delete past conversations." Connectors use their own OAuth client, separate from any Supabase Google sign-in client.
- **Missing tables:** code that reads `connector_grants` treats a missing relation (the migration not applied yet) as "no grant", so chat keeps working whatever the deploy order.

## Open decisions

- The context record does not count connector calls yet (it needs an expand migration on `context_records`); "What was sent" reads them from the stored results. Each saved Drive read carries `capped`, so a file cut at the 48 KB download cap shows "more than N characters".
- Scope choice before public launch: keep `drive.readonly` and pass CASA, or move to `drive.file` plus the Picker.
- Gmail is not included. Read scopes for Gmail are restricted; `gmail.send` alone is sensitive. Add it only with the write path.
- Where the OAuth client lives (the owner's Cloud project) and the Testing-mode 7-day token expiry, which users will see as "Needs reconnect" weekly until the app is published.
- Whether per-chat toggles for connectors (in the composer "+" menu) are wanted, or whether a connected account is always available to the assistant.
- Zero Data Retention on Nebius for connector content.
