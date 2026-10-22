# 0014 — One workspace: no Personal and Work modes

- Status: Proposed (2026-10-21). Requested by the owner: "just mix them together and make it one". Built on the branch `awais/agentic-workspace`; needs the owner's review before it reaches `main`.
- Related: [0005 assistant hub](0005-assistant-hub-proposal.md) (introduced the modes), [0009 memory, documents and actions](0009-memory-documents-actions.md), [0011 approval modes](0011-approval-modes.md), [DEPLOYMENT.md](../DEPLOYMENT.md) ("Expand, then contract").

## Why

Decision 0005 added a Personal/Work switch: a `pdot_mode` cookie, a `mode` column on conversations, tasks, memories, documents and reminders, a `mode` key in every action payload, a `p_mode` filter in the two similarity-search functions, a paragraph in the system prompt that refuses the other side's topics, and copy on every screen. The owner has decided that one workspace is better: an assistant that helps with everything, with connectors (decision 0016) deciding what it can see, is simpler to use than two lists to keep apart.

## Decision

One workspace. The user sees no mode anywhere: no toggle, no scope note, no "Move to Work", no "List" select on approval cards, no mode names in copy, and the assistant is not told to refuse any topic.

The storage keeps its `mode` columns, check constraints, indexes and the `mode` key in action payloads. They are frozen migrations (`tests/integration/frozen-migrations.test.ts`) and dropping them would be a contract step for no user benefit. The code treats the column as a vestige with one value:

| Layer | Change |
| --- | --- |
| `src/lib/mode.ts` | Keeps `Mode` and exports `WORKSPACE_MODE = "personal"`, the value written to every new row. `MODE_COOKIE`, `parseMode`, `MODE_LABELS`, `src/server/mode.ts`, `src/features/mode/actions.ts` and `ModeToggle` are deleted. |
| Lists (`src/server/db/{tasks,memories,documents,reminders,conversations}.ts`) | The `mode` parameter of every list method becomes optional; without it the list returns every row of the user, whatever mode it was saved with. Nothing is hidden and no row is rewritten. |
| Similarity search | Migration `20261022000000_one_workspace.sql` replaces `match_memories` and `match_document_chunks` with the same signatures and the filter `(p_mode is null or m.mode = p_mode)`, and sets the column default `'personal'` on tasks, memories, documents and reminders. Live code keeps passing a mode and keeps working; new code passes `null`. The migration also re-issues the execute revokes and grants for both functions. |
| API | `GET /api/tasks`, `/api/memories`, `/api/documents`, `/api/reminders` and `/api/conversations` ignore `?mode=` (accepted for older tabs, never required). `mode` becomes optional in the create bodies and in `POST /api/chat`; the server writes `WORKSPACE_MODE`. `actionPayloadSchema` keeps `mode` required because `normalize_action_payload` in the database requires the key; the server always sets it, the card never shows it. |
| Prompt | `MODE_SCOPE` is removed. `PROMPT_VERSION` moves to `2026-10-22.1`. |
| Screens | Today becomes "Your day" with one to-do list and one approval list; Memory, Workflows and Connectors list everything; the `--personal` / `--work` colour tokens and the `.scope-note-*` and `[data-mode]` rules go. `.mode-toggle` / `.mode-option` stay because the Effort switch in the composer uses them. |
| Tests | The "missing mode → 400" and "lists per mode" cases are rewritten to the new contract; the prompt test stops asserting the mode paragraph; fakes keep a `mode` field on rows. |

## Rules

- No row is deleted or rewritten by this change. A row saved in Work mode stays as it is and appears in the one list.
- `WORKSPACE_MODE` is the only mode value the app writes. A second value would mean a second workspace, which this decision rejects.
- The column stays until an owner decides on a contract step. That step would need `create or replace` of `log_memory_change`, `log_reminder_change`, `log_document_change`, `log_proposal_change`, `normalize_action_payload`, `decide_action_proposal` and the two match functions first, because they read `mode`.

## Amendments after review (2026-10-21)

- **The server writes `WORKSPACE_MODE` whatever the client sends.** Every create route, `PATCH /api/memories/:id` (a body with only `mode` answers 200 and writes nothing) and `POST /api/actions/:id/decision` (the edited payload gets `mode = WORKSPACE_MODE` before validation) ignore a client `mode`. An older tab still gets 200.
- **No deploy-order dependency.** The new code never relies on the null-mode filter: similarity search asks for each saved mode and merges the matches by similarity, so it returns the same rows on the old and the new function. The migration stays for later callers; it is additive and can merge on its own.
- **A one-time notice.** When the user has rows saved in Work mode, Today shows one dismissible line: "Personal and Work are now one workspace: N items from Work are in your lists."
- **Old conversations.** The system prompt says: "Earlier messages may mention Personal or Work mode; those modes no longer exist, so help with anything the user asks."

## Open decisions

- An older proposal saved in Work mode and approved without edits is logged as "Edited before approval", because the server rewrites its mode to `personal` and the log trigger compares payloads. The fix is a migration that replaces `log_proposal_change` so it ignores the `mode` key.

- Whether to run the contract step at all. Keeping the column costs nothing visible.
- Whether the action log should keep showing the saved mode of older rows. This change hides it everywhere.
