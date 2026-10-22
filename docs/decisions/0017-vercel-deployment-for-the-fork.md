# 0017 — Deploy the awaisaziz/P-Dot fork to Vercel

- Status: Proposed (the fork owner's request, 2026-10-22). Not deployed yet.
- Amends: [0004](0004-cloudflare-workers-deployment.md), for the fork only. The upstream production site stays on Cloudflare Workers.

## Decision

The fork `awaisaziz/P-Dot` deploys to Vercel as a Next.js project (Node.js runtime, Fluid compute) with its own Supabase project. The same code still builds for Cloudflare Workers with OpenNext: nothing Cloudflare-specific is removed, and Workers ignore each Vercel-specific part. The steps are in [`docs/DEPLOYMENT-VERCEL.md`](../DEPLOYMENT-VERCEL.md).

## Details

- **Background work.** `waitUntil` in `src/server/assistant/deps.ts` hands work to the request's `ctx.waitUntil` on Cloudflare and to Next's `after()` elsewhere, which on Vercel passes it to the platform's `waitUntil`. Before this change it did nothing outside Workers, so on Vercel nothing kept alive the work a reply hands off (spend settlements, the context record, saved result cards) or the embedding of an approved memory.
- **Bound to the request.** `after()` throws outside the request's async context, and a streamed reply runs most of its code after the route handler has returned, when the client reads the next chunk. So `createAssistantDeps` builds its `waitUntil` with `createWaitUntilForRequest()`, which captures the request's context with `AsyncLocalStorage.snapshot()` (supported on Node.js and on Workers). The action decision route calls `waitUntil` inside its handler and needs no binding.
- **Time limit.** `src/app/api/chat/route.ts` exports `maxDuration = 300`, the Hobby maximum with Fluid compute; 0004 had removed this export, and Workers ignore it. Other routes get the platform default (300 seconds with Fluid compute).
- **Service worker header.** `next.config.ts` sets `Cache-Control: no-cache` on `/sw.js`. `public/_headers` keeps the same rule for Cloudflare, where static files skip the `next.config.ts` headers. Vercel does not read `_headers`; it serves it as a plain file, which holds only cache rules.
- **Settings.** Vercel environment variables: Config for public values and settings, Secret for keys. `SITE_URL` stays required, and there is still no `VERCEL_URL` fallback (0004), so email and connector links never point at a Preview or a deployment-specific address. The Google connector settings are for Production only.
- **Database.** A Supabase project for the fork, used with the publishable key only ([0001](0001-supabase-auth-and-database.md)). Migrations are applied with the Supabase CLI or the Supabase GitHub integration. The Vercel Marketplace Supabase integration is not used, because it adds the secret key and Postgres connection strings to the project's variables.
- `.vercel/`, made by `vercel link`, is ignored by Git.

## Consequences and risks

- **Not verified on Vercel.** `npm run check` and `npm run build` pass. `tests/unit/wait-until.test.ts` checks the hand-off with a stand-in for Next's request scope, not on Vercel. After the first deploy, check `/api/health`, sign-in, one chat and one flight check, and that the reply's steps and result cards are still there after a reload.
- A hand-off that starts after the response has ended, for example a settle after the client disconnected, may not be kept alive; that depends on the platform.
- Hobby allows at most 300 seconds per request and is for personal, non-commercial use. Pro allows longer requests.
- `engines.node` (`>=22.12.0`) makes Vercel build on Node.js 24.x, while the project is tested on 22 (`.nvmrc`). Setting `engines.node` to `22.x` matches them.
- Previews use the production database, as on Cloudflare. A Supabase Free project pauses after a week of low activity.
- The fork's owner pushes to `main` (the owner's instruction, 2026-10-22), and on Vercel each push to `main` deploys production. Upstream keeps the pull request flow in `AGENTS.md`.
