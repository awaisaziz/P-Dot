# Deployment guide

This guide tells people and coding agents how P-Dot goes from a branch to the live site. Read it before you change `wrangler.jsonc`, `open-next.config.ts`, `package.json` scripts, environment variables or anything in this file.

## Summary

| Where | Address | How it updates |
| --- | --- | --- |
| Production | https://pdot.iampatelom.com | A merge to `main` deploys it through Workers Builds (connected on 2026-10-19) |
| Pull request preview | A `*.workers.dev` link that Cloudflare posts on the pull request | Each push to a pull request branch |
| Your computer, Node.js | http://localhost:3000 | `npm run dev` |
| Your computer, Workers runtime | The address that `npm run preview` prints | `npm run preview` |

- Hosting: one Cloudflare Worker named `pdot`, built with the OpenNext adapter. Decision: [0004](decisions/0004-cloudflare-workers-deployment.md).
- Database and accounts: one hosted Supabase project. Production and previews use the **same** database.
- The `workers.dev` address for production is off (`workers_dev: false`). Production is served only on the custom domain. `preview_urls: true` turns on `workers.dev` links for Previews and for each uploaded version.
- The fork `awaisaziz/P-Dot` deploys to Vercel with its own Supabase project instead: see [DEPLOYMENT-VERCEL.md](DEPLOYMENT-VERCEL.md) ([decision 0017](decisions/0017-vercel-deployment-for-the-fork.md)).

## The normal flow

1. Make a branch from `main`. Do the work. Run `npm run check` and `npm run build`. Both must pass.
2. Push the branch and open a pull request into `main`.
3. Cloudflare Workers Builds builds the branch and posts a comment on the pull request with the build result and a preview link.
4. An adversarial review is posted on the pull request as comments. Fix or answer each comment before merge.
5. The owner (Om) merges. Do not merge your own pull request.
6. Workers Builds builds `main` and deploys it to https://pdot.iampatelom.com. Check the result:

   ```bash
   curl -sS https://pdot.iampatelom.com/api/health
   ```

   Expected: `{"status":"ok","configured":{"auth":true,...}}`. The health check shows which settings exist. It does not call Nebius or Tavily.

Workers Builds was connected on 2026-10-19. Each push to `main` starts one production build. Each push to another branch starts one preview build. If Workers Builds is down, only the owner can deploy, with [a manual deploy](#manual-deploy-owner-only-fallback).

### Merging several pull requests

When two or more pull requests, or a stack of pull requests, are ready at about the same time, merge them together and aim for one deploy. Each build costs build minutes and CI time, and a build of an in-between state is replaced minutes later. Workers Builds starts a build for every push to `main` ([branch builds](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/)), so there are these options:

- **One production build, top down (ordinary stacks):** use this when each pull request is based on the branch below it, and the bottom one is based on `main`. Merge the top pull request into the branch below it, then that pull request into the branch below it, and so on. Do not change any base. Only the last merge, the bottom pull request into `main`, pushes to `main`, so only one production build runs. The merges into lower branches can start preview builds, but they do not change production. Each pull request keeps its own base and its own review. Its diff grows with each merge from above, so check it again before its own merge (step 1).
- **GitHub native stack (group merge):** use this when the pull requests were made as a GitHub native stack. GitHub lands the selected pull request and all lower unmerged pull requests together, so the top-down steps do not apply. When every pull request in the stack has a SHIP verdict for its current head and a passing `Workers Builds: pdot` check, use GitHub's group merge once. It lands the stack on `main` in one operation. See [merging stacked pull requests on GitHub](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-stacked-pull-requests).
- **Several merges (best effort):** merge one after another and cancel the older builds. An older build can still finish and deploy before you cancel it, so an in-between version can go live for a short time.

1. **Before each merge,** check the pull request again:
   - its base is `main`, or the branch below it in the stack;
   - its diff contains only the changes you expect: its own, and any merged into it from above;
   - its review verdict (SHIP) is for its current head commit;
   - the `Workers Builds: pdot` check passes on that head.

   With several merges, if the next pull request was based on the merged branch, change its base to `main`. If it was based on a squash merge, rebase it first and review the new diff.

   On the top-down path, each upper merge gives the next pull request a new head and a larger diff. Before you merge that pull request:
   - inspect the new head and the combined diff;
   - post a review verdict (SHIP) for that new head on that pull request;
   - wait for the `Workers Builds: pdot` check to pass on that head.

   The review can check the content that was already reviewed and the result of the merge. Do not skip these checks to save build minutes. Use "Create a merge commit" for the top-down path, so each pull request keeps its history.
2. **Merge in one sitting,** top down for a stack, or one after another for separate pull requests, as described above. Do not wait for production builds of `main` between merges. Do wait for the checks in step 1 on each new head before you merge it.
3. **Cancel every older build** of `main` that is still queued or running (Workers & Pages → `pdot` → Deployments → View build history → Cancel build). This is best effort: an older build that already finished has already deployed, and the last build replaces it.
4. **Wait until every build of `main` has finished or is cancelled, and confirm the last build succeeded.** If it failed, fix it and deploy the final `main` once. Do not deploy the in-between commits by hand.
5. **Confirm production runs the final `main`:** open the build of the last merge commit in the build history and note the version ID it deployed. It must match the active version in `npx wrangler deployments list --name pdot`. Then check the live site once (`/api/health`, sign-in, one chat).

Other rules:

- A set of pull requests with a database expand or contract step does not merge as one deploy, top down or as a native stack. Each step merges to `main` and deploys on its own, in the order and with the checks in [Expand, then contract](#expand-then-contract).
- Do not push small follow-up fixes to `main` one by one. Put them in one pull request.
- Each merge into `main` applies its own migration (Supabase GitHub integration) at once. The matching code goes live only when a build finishes, which is later: minutes later with several merges, or later still if a build fails. During that time the new migrations run with the old code. So every migration must be safe for the code that is live now, and new code must work on the old schema ([lesson 6](PROVIDER-RELIABILITY.md#6-new-code-can-run-before-its-migration)). If the last build fails, this time is longer, so fix it first.
- These steps are for the owner. Agents still must not merge or deploy (see [Rules for coding agents](#rules-for-coding-agents)).

## What runs in Workers Builds

These are the settings in the Cloudflare dashboard (Workers & Pages → `pdot` → Settings → Build). They are not stored in Git, so keep this table the same as the dashboard.

| Setting | Value |
| --- | --- |
| Git repository | `PATELOM925/P-Dot` |
| Production branch | `main` |
| Build command | `npm run check && npx opennextjs-cloudflare build && npm run check:worker-env` |
| Deploy command | `npx opennextjs-cloudflare deploy` |
| Builds for non-production branches | On |
| Non-production branch command | `npx wrangler preview` (the default) |
| Build variables | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (hosted project values; both are public by design) |
| Node.js version | From `.nvmrc` (22) |

If `npm run check` fails, the build stops and nothing is deployed.

## Settings and secrets

| Name | Kind | Where it is set |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Build time. Put into the browser bundle. Public. | Workers Builds build variables, or `.env.local` for a manual deploy |
| `SITE_URL` | Runtime variable | `wrangler.jsonc` (`https://pdot.iampatelom.com`) |
| `NEBIUS_BASE_URL`, `CHAT_REQUESTS_PER_WINDOW`, `CHAT_WINDOW_SECONDS`; the model routing settings `NEBIUS_FAST_MODELS`, `NEBIUS_STANDARD_MODELS`, `NEBIUS_HEAVY_MODELS`, `NEBIUS_VISION_MODELS`, `NEBIUS_MAX_OUTPUT_TOKENS`, `NEBIUS_STANDARD_MAX_OUTPUT_TOKENS`, `NEBIUS_HEAVY_MAX_OUTPUT_TOKENS`, `NEBIUS_HEAVY_THINKING_BUDGET`, `NEBIUS_HEDGE_AFTER_MS` ([decision 0007](decisions/0007-model-routing.md)); and the spend caps `NEBIUS_DAILY_CAP_USD`, `NEBIUS_TOTAL_CAP_USD`, `NEBIUS_USER_DAILY_CAP_USD`, `TAVILY_DAILY_CREDITS`, `TAVILY_MONTHLY_CREDITS`, `TAVILY_USER_DAILY_CREDITS` ([decision 0006](decisions/0006-global-spend-guard.md)) | Runtime variables. The code has a default for each. `wrangler.jsonc` sets the routing settings (the same values as the defaults) and each cap. `NEBIUS_MODEL` is no longer read. | `wrangler.jsonc`, in **both** `vars` (production) and `previews.vars` (Previews), changed through a pull request. Previews do not get top-level `vars` or dashboard variables. `tests/unit/wrangler-config.test.ts` fails if the two lists have different names. Dashboard variables (Workers & Pages → `pdot` → Settings → Variables and Secrets) are kept on deploy by `keep_vars: true`, but they apply to production only. |
| `NEBIUS_API_KEY`, `TAVILY_API_KEY` | Runtime secrets | `npx wrangler secret put NAME` (owner only) |
| `GOOGLE_CLIENT_ID`, `CONNECTOR_TOKEN_KEY_VERSION` (default `1`), `CONNECTOR_ALLOWED_USER_IDS` (comma-separated user IDs, or `*`; empty means nobody) | Runtime variables for the Google connector ([decision 0016](decisions/0016-google-connectors.md)). Not secrets; on the allow list. | Dashboard variable (production only) or `wrangler.jsonc` `vars`. Leave them out of `previews.vars`. |
| `GOOGLE_CLIENT_SECRET`, `CONNECTOR_TOKEN_KEYS` (JSON `{"1":"<base64 of 32 random bytes>"}`) | Runtime secrets for the Google connector | `npx wrangler secret put NAME` (owner only). **Never** in the Preview base config. |
| `TAVILY_KEYLESS` | Development only: lets `npm run dev` use Tavily's keyless access when `TAVILY_API_KEY` is empty | `.env.local` only. It is not on the allow list, so a deploy with it set stops, and the code ignores it when `NODE_ENV` is `production`. |

Rules:

- Never commit a secret. Never put a secret in `wrangler.jsonc`, in a build variable, or in a `NEXT_PUBLIC_` variable.
- Never add the Supabase secret key (service role key), a database password or a connection string to the Worker.
- **The OpenNext build copies every value from `.env`, `.env.local`, `.env.production` and `.env.production.local` (and the `development` versions) into the Worker bundle** (`.open-next/cloudflare/next-env.mjs`). `npm run deploy` and `npm run upload` run `scripts/check-worker-env.mjs` after the build. It stops the deploy if any variable that is not on its allow list has a value in that file. The allow list is in `scripts/worker-env-rules.mjs`: the two public Supabase values, `SITE_URL`, the Nebius and chat-limit settings, and the spend caps. A unit test fails if a name in `wrangler.jsonc` `vars` is not on it. Keys, passwords and connection strings are never on it. To add a non-secret setting, add its name there through a pull request. Workers Builds has no `.env` file, so this problem does not occur there.
- Previews do not get the production secrets. They use the `previews` block in `wrangler.jsonc` for variables, and the Preview base config for secrets (`npx wrangler preview base-config secret put NAME`, owner only). Until the owner adds them, chat in a preview says "This service is not configured yet."
- **Google connector secrets never go into the Preview base config.** Previews use the production database, so a branch holding `CONNECTOR_TOKEN_KEYS` could decrypt production users' Google tokens. Without them, connectors in a Preview report "not configured" and the start route refuses any host other than `SITE_URL`'s.

## Previews: what to know

- Each pull request branch gets a Preview at `<branch>-pdot.<account subdomain>.workers.dev`. Later pushes to the branch update the same link. Cloudflare posts it on the pull request.
- `wrangler preview` needs the `previews` block in `wrangler.jsonc` (it can be empty). Keep it there.
- The `preview_urls: true` setting takes effect at the first production deploy after it is merged. Previews have no link before then.
- A Preview uses the **production Supabase database**. If you sign up or chat in a Preview, the data is real. Use a test account. Never run a migration from a branch.
- Email links (confirm sign-up, reset password) always go to `SITE_URL`, which is the production address.
- Previews do not get the top-level `WORKER_SELF_REFERENCE` service binding, and the `previews` block does not add it. (If it were added there, it would call the production Worker.) OpenNext uses this binding only for cache work, and this app has no cache, so it has no effect today. Do not add a cache without a fix for this.
- Version links (`<version>-pdot.<account subdomain>.workers.dev`) also open each uploaded production version. They need the same sign-in as the live site.
- Workers Previews are in open beta. The Cloudflare documentation does not give a price for them. The owner checks the Workers plan page before turning on branch builds. Check that the first pull request after setup gets a working Preview link. If it does not, record what happened in this file.
- Preview logs do not appear in `wrangler tail`.
- To test the Workers runtime without Cloudflare access, run `npm run preview` on your computer. It uses your `.env.local` and your local or hosted Supabase. Stop `npm run dev` first.

## Database changes

Migrations are in `supabase/migrations/`. The hosted Supabase project has the GitHub integration on: a merge to `main` applies new migrations automatically. Agents never apply migrations. Write each migration so that the code which is live now still works after it runs (additive changes only). The new code and the migration go live at about the same time; for a short time the new code can run before its migration, so new database calls must fail closed.

### Expand, then contract

When a change needs a new database function or must remove something that the live code uses (a grant, a policy, a column), the new code cannot go live at the same time as its migration. Ship it in separate pull requests, in this order, and check each step before the next merge:

1. **Database (expand).** A migration that only adds. The code on main must keep working during and after it. The database gate checks main's code against it.
   - Check: the owner confirms in the Supabase dashboard that the migration is in the migration history and that its new objects exist. Agents never read the hosted database.
   - Until this check passes, do not use a Preview of the step 2 or step 3 branch. Previews use the production database, so that code would save rows with no log entry and fail on decisions.
2. **Code.** The code that uses the new objects. Merge it only after check 1.
   - Check: in the Cloudflare dashboard, the new Worker version serves 100% of traffic, and no Preview of an older branch is in use (Previews use the production database). Then wait a short drain time, for example 5 minutes, so that requests that started on the older version can end.
3. **Contract.** A later migration that removes the old path. Merge it only after check 2.

Rollback: after step 3, a Worker version older than step 2 no longer works, because it needs what step 3 removed. Roll back only to the step 2 version or a later one. Before step 3, a rollback to the older code is safe. Never undo a migration by hand.

The memory hardening ships this way:

1. PR #18 (branch `om/memory-expand-db`): migration `20261021000000_memory_hardening.sql`. Check 1: `public.decide_action_proposal` exists.
2. PR #13: the code that calls `decide_action_proposal` and no longer writes the action log. Without step 1, its writes would succeed with no log row. It also adds migration `20261021000500_marker_unset_setting.sql`, which works with any code. Check: `confirm_executed` from decision 0009 works on a new session. Merge it before step 3, because the Supabase integration skips a migration older than the newest one applied.
3. PR #17: migration `20261021010000_memory_hardening_contract.sql`, which removes the older log insert and proposal update paths.

Between steps 1 and 3, the older code can still write a second log row for a change, and a user can still move a proposal forward with the older update grant. Only a proposal with `decided_by_function = true` is a record of an action that the database ran; any other outcome is what a caller wrote (decision 0009).

The agentic workspace (decisions 0014, 0015, 0016, branch `awais/agentic-workspace`) adds three additive migrations, `20261022000000_one_workspace.sql`, `20261022000500_message_results.sql` and `20261022001000_connector_grants.sql`. No contract step follows. The code tolerates them missing (similarity search asks for each saved mode; a missing `message_results` or `connector_grants` table reads as "no results" and "no grant"), but the expand rule above still applies:

1. **Database (expand):** one pull request with only the three migrations, their lines in `tests/integration/frozen-migrations.sha256` and the gate changes. Merge it and let it deploy on its own. Check: in the Supabase dashboard, `public.message_results`, `public.connector_grants`, `public.store_connector_tokens` and `public.connector_grant_secrets` exist.
2. **Code:** the rest of the branch. Merge after check 1. The migrations must apply in timestamp order, so do not merge anything with a newer migration timestamp between the two steps.

## One-time setup (owner only)

These steps need the owner's Cloudflare or Supabase account. They are not done yet unless this list says so.

1. **Connect Workers Builds.** Done on 2026-10-19. Dashboard → Workers & Pages → `pdot` → Settings → Build → Connect. Choose GitHub, install the Cloudflare app on `PATELOM925/P-Dot` only, then enter the values from [What runs in Workers Builds](#what-runs-in-workers-builds) on **both** tabs, Production and Previews Base. The Free plan includes 3,000 build minutes each month.
   - **Known failure:** if the command fields stay empty, Cloudflare uses `npm run build` and `npx wrangler deploy`. The plain Next.js build does not make `.open-next/worker.js`, so the deploy fails after about 45 seconds. This happened on the first three builds on 2026-10-19. The fix was to enter the commands and the two build variables on both tabs.
2. **Set provider secrets** when the Nebius and Tavily accounts exist:

   ```bash
   npx wrangler secret put NEBIUS_API_KEY
   npx wrangler secret put TAVILY_API_KEY
   ```

   Set a spending limit on both provider accounts first. Production secrets were set on 2026-10-19. Provider spending limits are not confirmed yet.
3. **Models and spend caps.** `wrangler.jsonc` sets the model chain for each tier (`NEBIUS_FAST_MODELS` and the others) and the global spend caps in both `vars` and `previews.vars`. To change one, open a pull request. Every model in a chain must have a price in `src/server/providers/nebius/pricing.ts`. If one does not, chat says "This service is not configured yet." and no provider is called. Add the price in the same pull request. See [decision 0006](decisions/0006-global-spend-guard.md) and [decision 0007](decisions/0007-model-routing.md). If `NEBIUS_MODEL` was set in the dashboard, you can delete it there: the code no longer reads it.
4. **Preview secrets (optional).** To let Previews call Nebius and Tavily, set them in the Preview base config. Use a separate key with a low spending limit if the provider allows it:

   ```bash
   npx wrangler preview base-config secret put NEBIUS_API_KEY
   npx wrangler preview base-config secret put TAVILY_API_KEY
   ```

   Changes to base secrets apply only to Previews created after the change.
5. **Supabase Auth URL configuration** (Authentication → URL Configuration): Site URL `https://pdot.iampatelom.com`; redirect URLs `https://pdot.iampatelom.com/**` and `http://localhost:3000/**`. Done on 2026-10-19. The free plan does not allow email template changes without custom SMTP, so the templates from the README "Setup" section are not applied yet.
6. **Email sending.** The default Supabase email service sends only to members of the Supabase organization's team, and about 2 messages each hour. Before other people sign up, either add them to the Supabase team, create their accounts in the dashboard (Authentication → Users → Add user, "Auto Confirm User"), or set up custom SMTP. On 2026-10-19 "Confirm email" was turned off for the hackathon, so sign-up works without an email. Password reset emails still reach only team members.

7. **Google connector** ([decision 0016](decisions/0016-google-connectors.md); optional, connectors stay off without it).
   - In Google Cloud Console, create an OAuth client of type **Web application** in its own project, separate from any Supabase Google sign-in client. Authorized redirect URIs: `https://pdot.iampatelom.com/api/connectors/google/callback` and, for local runs, `http://localhost:3000/api/connectors/google/callback`. On the consent screen add the scopes `calendar.readonly`, `drive.readonly`, `openid` and `email`, and keep the app in **Testing** with your own account as a test user. In Testing, Google ends access after 7 days, so the Connectors page asks to reconnect weekly. `drive.readonly` is a restricted scope: publishing the app to everyone needs Google's verification and a yearly CASA security assessment, or a move to `drive.file` with the Picker.
   - Generate the token key and set the secrets:

     ```bash
     node -e "console.log(JSON.stringify({1: require('crypto').randomBytes(32).toString('base64')}))"
     npx wrangler secret put CONNECTOR_TOKEN_KEYS
     npx wrangler secret put GOOGLE_CLIENT_SECRET
     ```

     Then set `GOOGLE_CLIENT_ID` and `CONNECTOR_ALLOWED_USER_IDS` (your own user ID from Supabase Authentication → Users) as dashboard variables. Keep the allow list to your own account until Zero Data Retention is confirmed on the Nebius account: by default Nebius keeps inputs for speculative decoding, and Google's Limited Use policy covers every test user.
   - Rotation: add `"2"` to `CONNECTOR_TOKEN_KEYS`, then set `CONNECTOR_TOKEN_KEY_VERSION=2`. Rows move to version 2 on their next token write. Remove version 1 only when no row has `key_version = 1`. If a key leaks: rotate, then ask every user to reconnect.
   - Deleting an account removes its stored Google token without revoking it at Google; users can remove access at myaccount.google.com/permissions.

## Manual deploy (owner only, fallback)

Use this only when Workers Builds is not available. You need macOS, Linux or WSL and `npx wrangler login`.

1. Make sure `.env.local` has the **hosted** Supabase URL and publishable key, and no provider keys (the guard stops the deploy if it finds them).
2. Run `npm run check`, then `npm run deploy`.
3. Check `/api/health`, `/`, `/login` and that `/chat` redirects to `/login` when you are signed out.

`npm run upload` uploads a new version without sending traffic to it.

## Rules for coding agents

- Do not run `npm run deploy`, `npm run upload`, `wrangler deploy`, `wrangler secret put`, `wrangler preview` or any other command that changes Cloudflare, unless the owner asks for it in the current task.
- Do not merge pull requests. Do not push to `main`.
- Do not change DNS, routes, the custom domain, `workers_dev` or `preview_urls` without the owner's approval.
- Do not upgrade the Cloudflare or Supabase plan or turn on a paid feature.
- Keep this file, the README and `.env.example` correct when you change deployment settings.

## Known limits

- Next.js is pinned to 16.3.8 and `@opennextjs/cloudflare` to 1.20.11. Next 16.4.1 broke every page in the Workers runtime. Test a preview before you upgrade either one.
- `src/proxy.ts` uses Node.js middleware, which OpenNext supports only as experimental. Watch the session redirects after each deploy.
- Worker size limit: 64 MiB **uncompressed** on the Free and Paid plans. There is no compressed limit; the gzip number from Wrangler is for reference only. Check the `Total Upload` value from `npx wrangler deploy --dry-run --outdir <folder>`. The first deploy (2026-10-19) was 11,728 KiB uncompressed (2,344 KiB gzip). Source: https://developers.cloudflare.com/workers/platform/limits/#worker-size
- Logs: `npx wrangler tail pdot --format json` (owner account). Preview versions do not appear in `wrangler tail`.
- Model routing: each reply writes one `model_route` log line (tier, reason, models tried, attempts, hedge, `firstTokenMs`, `totalMs`, outcome). Use it to check the time to the first token and how often fallbacks happen. The circuit breaker lives in each isolate's memory only, so different isolates can decide differently for a short time.
- Spend caps: Previews use the production database, so Preview chats count against the same global caps. The `spend_limit_reached` log event shows when a cap refuses a request. Usage is in the `spend_counters` table (SQL editor, owner only).
