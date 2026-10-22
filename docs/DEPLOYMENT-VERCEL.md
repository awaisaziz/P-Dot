# Deploying to Vercel (the awaisaziz/P-Dot fork)

This guide puts the fork `awaisaziz/P-Dot` on Vercel with its own Supabase project ([decision 0017](decisions/0017-vercel-deployment-for-the-fork.md)). The upstream production site stays on Cloudflare Workers ([DEPLOYMENT.md](DEPLOYMENT.md)); the application code is the same.

**Status:** not deployed yet. The code is ready (`npm run check` and `npm run build` pass), but nothing in this guide has run on Vercel.

## Summary

| Where | Address | How it updates |
| --- | --- | --- |
| Production | `https://<project>.vercel.app` (Vercel → Settings → Domains) | Each push to `main` of `awaisaziz/P-Dot` |
| Preview | A link on each deployment of another branch | Each push to that branch |
| Your computer | http://localhost:3000 | `npm run dev` |

- Hosting: one Vercel project with the Next.js preset, the Node.js runtime and Fluid compute (on by default).
- Database and accounts: one Supabase project for the fork. Production and Previews use the **same** database.
- Agents do not deploy, change Vercel or Supabase settings, or apply migrations to the hosted project unless the owner asks for it in the current task.

## What differs from Cloudflare

| Concern | Cloudflare Workers | Vercel |
| --- | --- | --- |
| Work after the response | The request's `ctx.waitUntil` | Next's `after()`, bound to the request in `createAssistantDeps` (`src/server/assistant/deps.ts`) |
| Time limit | None per route; provider timeouts bound each request | `maxDuration = 300` in `src/app/api/chat/route.ts`; other routes get the default (300 seconds with Fluid compute) |
| `/sw.js` no-cache header | `public/_headers` | `next.config.ts` |
| Settings and secrets | `wrangler.jsonc` and Worker secrets | Vercel environment variables |
| Build | OpenNext (`npx opennextjs-cloudflare build`) | `next build` |

Vercel does not read `wrangler.jsonc`, `open-next.config.ts` or `public/_headers`. The `.env` guard (`scripts/check-worker-env.mjs`) is for the OpenNext bundle; Vercel builds from Git, where no `.env` file exists.

## One-time setup (owner only)

### 1. Supabase project

1. On supabase.com, create a project on the Free plan in the region nearest you. Keep the database password. Do not reuse the upstream production project.
2. Copy the Project URL and the publishable key (`sb_publishable_…`) from **Connect** or Project Settings → API Keys. Never copy the secret (service_role) key anywhere ([decision 0001](decisions/0001-supabase-auth-and-database.md)).
3. Apply the migrations from your computer:

   ```bash
   npx supabase login
   npx supabase link --project-ref <project-ref>
   npx supabase db push
   ```

   New Supabase projects do not expose new tables to the Data API automatically. The migrations grant every table and function the app uses to `authenticated` explicitly, so nothing more is needed.

### 2. Vercel project

1. Vercel → Add New → Project → import `awaisaziz/P-Dot`. Give the Vercel GitHub app access to that repository only. Vercel detects the Next.js preset.
2. Build Command: `npm run check && npm run build`. If the check fails, nothing is deployed.
3. Add the environment variables from step 3 before the first deploy, or redeploy after adding them.
4. Settings → Functions → Function Region: the region next to the Supabase project, because each chat makes several database calls. The default `iad1` (Washington, D.C.) matches Supabase `us-east-1`.
5. Keep Fluid compute on and keep the default Deployment Protection.
6. Node.js: `engines.node` in `package.json` (`>=22.12.0`) overrides the dashboard setting and gives Node.js 24.x, which Next.js 16 supports. The project is tested on 22 (`.nvmrc`); set `engines.node` to `22.x` in a commit to match.

### 3. Environment variables

Settings → Environment Variables. Use the production domain from Settings → Domains wherever a URL is asked. Changes apply only to new deployments, and `NEXT_PUBLIC_` values are put into the bundle at build time, so redeploy after every change.

| Name | Type | Environments | Value |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Config | Production, Preview | Project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Config | Production, Preview | `sb_publishable_…` |
| `SITE_URL` | Config | Production, Preview | `https://<project>.vercel.app` |
| `NEBIUS_API_KEY` | Secret | Production | Nebius Token Factory key |
| `TAVILY_API_KEY` | Secret | Production | Tavily key |
| `GOOGLE_CLIENT_ID` | Config | Production only | OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Secret | Production only | OAuth client secret |
| `CONNECTOR_TOKEN_KEYS` | Secret | Production only | A new key, not the one in `.env.local` |
| `CONNECTOR_TOKEN_KEY_VERSION` | Config | Production only | `1` |
| `CONNECTOR_ALLOWED_USER_IDS` | Config | Production only | Your user ID (Supabase → Authentication → Users), not `*` |

The last five are for the Google connector and can wait. Make the token key with:

```bash
node -e "console.log(JSON.stringify({1: require('crypto').randomBytes(32).toString('base64')}))"
```

Rules:

- Do not paste `.env.local` into Vercel. Its `OLLAMA_*` settings and `ollama/` model chains point at your computer, and `TAVILY_KEYLESS` is for development only (the code ignores it in production). Leave the model chains unset: the defaults in the code are Nebius models, and embeddings then use Nebius too.
- Never add the Supabase secret key, a database password or a connection string.
- The spend caps and chat limits have defaults in the code: `NEBIUS_DAILY_CAP_USD` 1.00, `NEBIUS_USER_DAILY_CAP_USD` 0.25, `NEBIUS_TOTAL_CAP_USD` 20.00, `TAVILY_DAILY_CREDITS` 40, `TAVILY_MONTHLY_CREDITS` 800, `TAVILY_USER_DAILY_CREDITS` 10, and `CHAT_REQUESTS_PER_WINDOW` 30 per `CHAT_WINDOW_SECONDS` 3600. Set one only to change it ([decision 0006](decisions/0006-global-spend-guard.md)). Also set a spending limit in the Nebius and Tavily accounts.
- Keep the Google connector settings out of Preview. Previews use the production database, so a branch with `CONNECTOR_TOKEN_KEYS` could decrypt stored Google tokens. Without them, connectors in a Preview report "not configured".
- Add `NEBIUS_API_KEY` and `TAVILY_API_KEY` to Preview only if you want chat in Previews. Preview chats count against the same caps.

### 4. Supabase Auth

1. Authentication → URL Configuration: Site URL `https://<project>.vercel.app`; Redirect URLs `https://<project>.vercel.app/**` and `http://localhost:3000/**`. Email links always use `SITE_URL`, so Preview addresses need no entry.
2. Create your account: Authentication → Users → Add user, with **Auto Confirm User**. Signing up in the app also works, but the default email service sends only to members of the Supabase organization, about 2 messages each hour, and its confirmation link works only in the browser that signed up.
3. Turn off **Allow new users to sign up** (Authentication → Sign In / Providers). The spend caps are shared by all accounts, so this keeps other people from using the provider budget.

### 5. Google connector (optional)

Use the OAuth client from [DEPLOYMENT.md](DEPLOYMENT.md), one-time setup step 7. Add the authorized redirect URI `https://<project>.vercel.app/api/connectors/google/callback`, set the five Google settings above, redeploy, then open Connectors → Google. In Testing mode Google ends access after 7 days, so the Connectors page asks to reconnect weekly.

## Deploy and check

1. The first deployment runs when you import the project; later ones run on each push to `main`. If the production domain differs from the one you entered, fix `SITE_URL` and the Supabase URLs, then redeploy.
2. Check the health route. It shows which settings exist and calls no provider:

   ```bash
   curl -sS https://<project>.vercel.app/api/health
   ```

   Expected: `{"status":"ok","configured":{"auth":true,...}}`.
3. Sign in, send one chat and one flight question, then reload. The steps and result cards under the reply must still be there: they are written in the background, which `after()` keeps alive.
4. Check that `/sw.js` answers with `Cache-Control: no-cache`:

   ```bash
   curl -sSI https://<project>.vercel.app/sw.js
   ```

## Database changes

After pushing a commit with a new migration, apply it from `main` with `npx supabase db push`. Or connect the Supabase GitHub integration to `awaisaziz/P-Dot` with `main` as the production branch: it applies migrations on each push, minutes before the Vercel build finishes, so every migration must work with the code that is live, and [Expand, then contract](DEPLOYMENT.md#expand-then-contract) applies. Never apply a migration from another branch: Previews use the production database.

## Known limits

- Hobby allows at most 300 seconds per request and is for personal, non-commercial use only. Pro allows longer requests.
- Work handed to `after()` must finish within the route's maximum duration. A hand-off that starts after the response has ended may not be kept alive.
- A Supabase Free project pauses after a week of low activity; resume it from the dashboard.
- Logs: Vercel → the project → Logs. Each reply writes one `model_route` line (see [DEPLOYMENT.md](DEPLOYMENT.md#known-limits)).

Sources: [Vercel function duration](https://vercel.com/docs/functions/configuring-functions/duration), [Vercel environment variable types](https://vercel.com/docs/environment-variables/sensitive-environment-variables), [Vercel Node.js versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions), [Next.js `after`](https://nextjs.org/docs/app/api-reference/functions/after), [Supabase Data API grants change](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically), [Supabase redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls), [Supabase project pausing](https://supabase.com/docs/guides/platform/free-project-pausing).
