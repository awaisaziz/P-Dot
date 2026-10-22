# 0011 — Approval modes: "Ask first" and "Auto"

- Status: Proposed (2026-10-19). Frontend built; backend recipe below, not built.
- Related: [0009 memory and actions](0009-memory-documents-actions.md) (proposals, the decision route, the action log), [0005 assistant hub](0005-assistant-hub-proposal.md) (every send, booking, call or delete waits for the user).

## Why

Approving every small action gets tedious, but some actions must never happen without the user seeing them. Like Claude Code's permission modes, the user picks how much P-Dot may do on its own, and the risky kinds always stop and ask, whatever the mode.

## The modes

| Mode | What happens to an action P-Dot proposes |
| --- | --- |
| **Ask first** (default) | Every action waits as an approval card: approve, edit then approve, or cancel. |
| **Auto** | Actions that only add to P-Dot's own lists run on their own and appear under the reply as "Done on its own" with **Undo**. Everything else still waits as a card that says why it asks. At most 3 actions per reply run on their own; the rest ask. |

Auto applies only to replies to messages the user sent while Auto was on, and only while it is still on. Switching back to Ask first stops it at once.

## The rules (one source of truth)

`src/lib/approval-policy.ts` is shared by the browser and the server. Every `ActionKind` must be mapped to an effect in `ACTION_EFFECTS`; a new kind does not compile until it is, so nothing can run on its own by accident.

| Effect | Kinds today | Ask first | Auto |
| --- | --- | --- | --- |
| `create_own`: adds to P-Dot's own lists, can be undone | `create_task`, `create_reminder` | asks | runs on its own (limit 3 per reply) |
| `store_personal`: saves something about the user | `save_memory` | asks | **asks** |
| `change_own`: changes something the user already has | none yet | asks | **asks** |
| `delete`: deletes or removes anything | none yet | asks | **asks** |
| `external`: sends a message, changes an account, calendar or device | none yet | asks | **asks** |
| `read_sensitive`: reads email, a connected account or other private data | none yet | asks | **asks** |
| `spend`: spends money | none yet | asks | **asks** |
| `settings`: changes a setting or permission | none yet | asks | **asks** |

## What the frontend does today

- **Choosing the mode.** On a device where no mode was chosen, chat shows a one-time card ("How should P-Dot act?") with both modes explained; "Keep Ask first" closes it. After that, a button next to the microphone always shows the current mode and opens a menu with the same two options (it works with touch, mouse and keyboard, and Esc closes it). Settings → Approvals shows them as radio cards, and the Today approvals panel shows the mode with a Change link. The button is kept apart from the effort switch, whose "Auto" means model choice. The choice is kept on the device (`localStorage`, key `pdot.approvalMode`); an unknown or missing value means Ask first. Code: `src/features/actions/ApprovalModePicker.tsx`, `approval-mode.ts`.
- While Auto is on, a notice under the message box says what runs on its own and what still asks.
- Until the server runs actions itself, the chat approves eligible proposals for the user through the existing `POST /api/actions/:id/decision`. The server still validates each one, runs it at most once (the claim guard) and writes the usual log rows. Cards that still ask show "Asks even in Auto" with the reason; memory suggestions show it too.
- **Undo** calls the existing `DELETE /api/tasks/:id` or `DELETE /api/reminders/:id` with the ID in the proposal's `result`.
- No server code, schema or migration was changed for this.

## Backend recipe

1. **Send the mode with each message.** Add `approvalMode: z.enum(APPROVAL_MODES).optional()` to `sendSchema` and `retrySchema` in `src/lib/schemas.ts` (they are `.strict()`, so the field must be listed) and to `ChatRequest` in `src/types/api.ts`. A missing value means `"manual"`. Frontend follow-up: one line in `ChatWorkspace.submit()` adds `approvalMode` to the body.
2. **Record who decided.** Migration: `action_proposals.decided_by text check (decided_by in ('user', 'auto'))`, set by `decide_action_proposal` in the same update that claims the proposal (add a `p_decided_by` argument; users have no update grant on proposals). Add `'auto_approved'` and `'undone'` to the `action_log.event` check and write them from the proposal trigger (decision 0009: only the database writes the log). Add `decidedBy: "user" | "auto" | null` to `ActionProposalDTO`.
3. **Run eligible actions in the tool loop.** After `createProposal`, if the request's mode is `auto`, `mayRunOnItsOwn(kind, "auto")` is true and fewer than `MAX_AUTO_ACTIONS_PER_REPLY` ran for this reply: call `decide_action_proposal` with `decided_by = 'auto'`; the trigger logs `auto_approved` then `executed` with `{ auto: true }`. Otherwise leave it `proposed`. Do this **before** sending `done`, because the chat reloads proposals when `done` arrives. The browser's interim auto-approval then finds nothing waiting; if both race, the claim guard lets only one run.
4. **Undo (optional).** `POST /api/actions/:id/undo` deletes what the action created (from `result`), logs `undone` and returns the proposal. Until then the frontend's direct deletes work.
5. **Sensitive reads.** A tool that reads email, a calendar, a connected account or anything outside the conversation is `read_sensitive`. It creates a proposal (a new kind, for example `read_source`, mapped in `ACTION_EFFECTS`) and waits; the data goes to the model only after approval. Retrieved content stays untrusted and cannot approve anything.
6. **Deletes and outside actions.** New kinds such as `delete_task`, `send_message` or `create_calendar_event` map to `delete` or `external` and always wait. Decision 0009's rule still holds: a kind that changes an outside account needs its own decision.
7. **Routines and background jobs.** They have no chat request, so they treat every action as Ask first until there is an account-level setting (for example a `user_settings.approval_mode` column with RLS), which needs its own decision.
8. **Tests.** The schema accepts `approvalMode` and still rejects unknown keys; Ask first never runs anything; Auto runs only `create_own` and stops at the limit; `store_personal`, `delete`, `external` and `read_sensitive` always stay `proposed`; `decided_by` is stored; a browser approval racing the server's runs the action once.

When this lands, update: the hint in Settings → Approvals ("P-Dot does not propose actions in chat yet…"), `PastProposal` (show "Done on its own" when `decidedBy` is `auto`) and `describeLogEntry` (label `auto_approved` and `undone`).

## Amendment (2026-10-21): connector reads behind a visible toggle

Decision [0016](0016-google-connectors.md) adds read-only Google connectors. Step 5 above asks for one approval card for every sensitive read. A card for each calendar lookup would make the connector unusable, so this amendment, pending the owner's review, replaces step 5 for connector reads with a visible switch kept on the device:

- The Google chip in the composer's "+" menu is **off** until the user turns it on. Turning it on is the approval: while it shows as on, the assistant may call `calendar_list_events`, `drive_search_files` and `drive_read_file` for messages sent from that device. Turning it off stops it at once. The choice is stored on the device, like the approval mode, and sent with each message.
- Each read shows as a step line under the reply ("Read 6 events from your calendar"), so the user sees every read.
- After a connector read, the rest of that reply offers no tool that sends text outside P-Dot (web search, flight search, research), and Auto runs nothing on its own for that reply: every proposal waits as a card (decision [0015](0015-grounded-workflows.md), "Tainted replies").
- Any other read of private data stays `read_sensitive` and follows step 5.

## Open decisions

- The limit of 3 actions per reply.
- Whether a reminder far in the future still counts as safe, and whether Personal and Work get separate settings.
- Whether the choice should follow the account (server setting) rather than the device.
- If teenagers are an audience (decision 0005), whether Auto should be available to them.
