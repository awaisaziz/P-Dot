# 0004 — Deploy to Cloudflare Workers with OpenNext

- Status: Accepted (user decision, 2026-10-15)
- Supersedes: the Vercel hosting assumption in the PRD and architecture
- Amended by: [0017](0017-vercel-deployment-for-the-fork.md) for the `awaisaziz/P-Dot` fork, which deploys to Vercel (proposed)

## Decision

Host the Next.js app as a single Cloudflare Worker using `@opennextjs/cloudflare` (pinned 1.20.11) and Wrangler. Configuration lives in `wrangler.jsonc` and `open-next.config.ts`. Vercel-specific code was removed (`maxDuration` export, `VERCEL_URL` fallback, `.vercel/` ignore).

## Details

- Worker runs with `nodejs_compat` and `global_fetch_strictly_public`. No bindings, R2, or KV are used; all routes are dynamic.
- `NEXT_PUBLIC_*` values are inlined at build time. Secrets (`NEBIUS_API_KEY`, `TAVILY_API_KEY`) are Worker secrets; other settings are Worker variables.
- `SITE_URL` must be set in production (there is no platform-provided URL fallback).
- No per-route time limit: the Nebius (55 s total / 25 s idle) and Tavily (10 s) timeouts bound each request.

## Consequences and risks

- **Next.js is pinned to 16.3.8.** With 16.4.1 the Worker returned 500 on every page (`Unexpected loadManifest(/.next/server/preview-props.json)`), because OpenNext 1.20.11 does not inline that manifest. Re-test before upgrading either package.
- **`proxy.ts` uses Node.js middleware, which OpenNext supports only experimentally.** It worked in local Workers-runtime tests. If it proves unreliable, options are moving session refresh into the page/route layer or reverting to an edge `middleware.ts`.
- Native Windows builds are unsupported by OpenNext; deploy from Linux/macOS/WSL or Cloudflare's build service.
- First real deployment on 2026-10-19 (Worker `pdot`, custom domain `pdot.iampatelom.com`, 11,728 KiB uncompressed, 2,344 KiB gzip; the limit is 64 MiB uncompressed). Health, signed-out redirects, 401 on the chat API and security headers were checked on the live site; the Worker logs showed no CPU-limit errors. Not verified yet: signed-in flows and streaming chat on Cloudflare.
- The OpenNext build copies `.env*` file values into the Worker bundle (`.open-next/cloudflare/next-env.mjs`). Platform variables and secrets take priority at runtime, but the values are still uploaded. `scripts/check-worker-env.mjs` stops `npm run deploy` and `npm run upload` when a variable that is not on its allow list (`scripts/worker-env-rules.mjs`) has a value there.
- Continuous deployment uses Cloudflare Workers Builds (merge to `main` deploys; pull request branches get previews). `keep_vars: true` keeps dashboard variables on each deploy. Previews need the `previews` block and `preview_urls: true` (workers.dev links); they use their own secrets and their own variables (`previews.vars`, kept in step with `vars` by a unit test), and they do not get the self-reference service binding. The flow and the dashboard settings are in [`docs/DEPLOYMENT.md`](../DEPLOYMENT.md).
