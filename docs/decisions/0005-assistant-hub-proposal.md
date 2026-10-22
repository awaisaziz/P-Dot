# 0005 — Assistant hub: connectors, workflows, daily brief (proposal)

- Status: Partly implemented (2026-10-16, updated 2026-10-19). Built: Personal/Work modes, to-do list, conversation rename, browser dictation, the new landing page, approval cards, the memory and documents page, "what was sent", the action log, reminders on the Workflows page, live built-in tools on the Connectors page, the installable app and a Devices page ([0009](0009-memory-documents-actions.md), [0010](0010-pwa-and-device-pairing.md)). Not built and still open: the assistant proposing actions, real account connectors, routines and a scheduler, the daily brief, push delivery, device pairing, Telegram/WhatsApp/phone. The PRD has not been amended.
- Source: design review comment on the "P-Dot Frontend Design" canvas (2026-10-16).
- Superseded in part (2026-10-21, proposed): the Personal and Work views are replaced by one workspace ([0014](0014-one-workspace.md)); real account connectors start with read-only Google Calendar and Drive ([0016](0016-google-connectors.md)); the assistant now proposes actions and runs grounded workflows ([0015](0015-grounded-workflows.md)). The PRD's section 8 is amended for these.

## Request

Add, beside chat: connectors (Gmail, GitHub, Vercel, WhatsApp, phone calls and appointment booking, Telegram delivery), workflows, a daily brief and to-do list, and separate Personal and Work views, in a neutral palette suited to adults and teenagers. Mockups: boards "Today: Personal", "Today: Work", "Workflows" and "Connectors" on the canvas.

## Conflicts with the current PRD

The PRD (section 8) puts these out of scope for the MVP: autonomous actions, email sending, calendar edits, other external account mutations, background reminders and scheduled jobs. `AGENTS.md` also requires explicit user confirmation before any consequential external action.

## Open decisions before any implementation

- Scope: move this into a post-MVP phase, or amend the PRD.
- Connector security: OAuth token storage (encrypted, per user), least-privilege scopes, read-only first, revocation, audit log. MCP servers and retrieved content are untrusted input.
- Approval model: every send, booking, call or delete shows what will happen and waits for the user. The mockups assume this.
- Scheduling: workflows and the morning brief need a scheduler (for example Cloudflare Cron Triggers plus a queue); the current app has none.
- Channels: Telegram bot is the simplest delivery target; WhatsApp needs business API approval and costs; phone calls need a telephony provider, consent, and regional legal review.
- Minors: if teenagers are an audience, age limits, parental consent and data-protection rules (for example COPPA/GDPR-K) must be decided before connecting personal accounts.
- Palette: resolved. Neutral ground with colour where it helps: indigo-to-violet accent, coral for Personal and blue for Work, mint for success and web sources, and a colour per tool; DM Sans type. Applied to every board and the app.

## Implementation notes (2026-10-16)

- Modes: `conversations.mode` and `tasks.mode` (`personal` | `work`) with RLS; the selected mode is a view cookie (`pdot_mode`), not an authorization control. The assistant is told which topics belong to the mode, but this is a prompt instruction, so it is a guide rather than a guarantee.
- Dictation uses the browser's Web Speech API (English). Audio may be processed by the browser vendor; P-Dot servers receive only the text the user sends. Server-side speech-to-text was not added.
- The Workflows and Connectors pages state that nothing runs. They must not be changed to simulate success before the underlying features exist.
- 2026-10-19: as their APIs landed, parts of both pages became real. Workflows holds the live reminders list; its routines are still previews. Connectors shows P-Dot's own to-do list, reminders, memory and documents as "Ready", with live counts for the current mode; account connectors and devices are still previews with disabled buttons.


## Landing page motto (2026-10-19)

The landing page now carries: "A private agent on open Nemotron that never trains on your data. You can see and edit everything it remembers. It acts on your own laptop and phone, and every action is approved and logged." Today these claims are **not yet true or not verified**, and each must be true (or the wording softened) before a public release:

- "Never trains on your data": depends on the inference provider's terms. Nebius's Token Factory quickstart does not state a no-training or retention policy; confirm it in Nebius's terms/privacy documentation or contract before claiming it.
- "See and edit everything it remembers": partly true since 2026-10-19. The Memory page lists every memory and document for a mode, with edit and delete, but replies do not use memories or documents yet (the PRD still excludes cross-conversation memory).
- "Acts on your own laptop and phone": no device agent exists. The Devices page previews pairing ([0010](0010-pwa-and-device-pairing.md)).
- "Every action is approved and logged": the approval cards and the action log exist, and an action runs only after approval. The assistant does not propose actions yet, so in practice nothing reaches a card from chat.
- "Open Nemotron": the app uses whichever model `NEBIUS_MODEL` names; no Nemotron ID is configured yet.
