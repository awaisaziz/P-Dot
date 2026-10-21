# Deploying on a virtual machine with an internal database

This guide puts the whole product on one virtual machine (a cloud VM, for example on Nebius Cloud, or any Linux server) with Docker Compose. The database and the account service run inside the machine; nothing but the app is reachable from the internet. Model inference runs on Nebius Token Factory and web search on Tavily, both called from the app with server-side keys.

Production today runs on Cloudflare Workers with a hosted Supabase project ([DEPLOYMENT.md](DEPLOYMENT.md)). This is the self-hosted alternative; the application code is the same.

```text
Internet ──443──▶ caddy (TLS) ──▶ app (P-Dot, Node.js) ──▶ Nebius Token Factory (models)
                                     │                   ──▶ Tavily (web search)
                                     ▼ private Docker network
                                   kong ──▶ auth (Supabase Auth)  ──▶ db (Postgres + pgvector)
                                        ──▶ rest (PostgREST, RLS) ──▶ db
```

Everything is in `deploy/`:

| File | Purpose |
| --- | --- |
| `docker-compose.yml` | The services above, plus `migrate` (applies the migrations once) and an optional `studio` profile |
| `.env.example` | Every setting, with comments; copy to `deploy/.env` |
| `generate-keys.mjs` | Makes the database password, the JWT secret and the two API keys |
| `kong.yml` | The gateway routes (`/auth/v1`, `/rest/v1`) with API-key checks |
| `db/roles.sql`, `db/jwt.sql` | First-start database setup (service role passwords, JWT settings) |
| `db/migrate.sh` | Applies `supabase/migrations/*.sql` in order, recording each version |
| `Caddyfile` | HTTPS with automatic certificates, proxying to the app |

## 1. The machine

- Linux with Docker Engine 24+ and the Compose plugin (`docker compose version`). 2 vCPU and 4 GB of RAM are enough for a few users; the database image is about 1.7 GB.
- A DNS name pointing at the machine (`DOMAIN`), and ports 80 and 443 open. Nothing else needs to be open.
- Git, to pull the repository: `git clone https://github.com/PATELOM925/P-Dot.git && cd P-Dot`.

On a Nebius Cloud VM, create the instance with a public IP, attach a security group that allows 22, 80 and 443, install Docker with the distribution's packages, and point an A record at the IP.

## 2. Keys and settings

```bash
cp deploy/.env.example deploy/.env
node deploy/generate-keys.mjs      # paste the four lines it prints into deploy/.env
```

Fill in `deploy/.env`:

| Setting | Value |
| --- | --- |
| `DOMAIN`, `SITE_URL`, `ACME_EMAIL` | The site name, `https://<DOMAIN>`, and an email for the certificate |
| `POSTGRES_PASSWORD`, `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY` | From `generate-keys.mjs`. The anon key is the app's publishable key; the service role key is used only by the gateway and the optional Studio, never by the app |
| `NEBIUS_API_KEY` | From the Nebius Token Factory console. Set a spending limit on the account first |
| `TAVILY_API_KEY` | From the Tavily dashboard. Empty disables web search cleanly |
| Model chains and spend caps | Empty lines use the defaults from [decision 0007](decisions/0007-model-routing.md) and [decision 0006](decisions/0006-global-spend-guard.md) |
| `ENABLE_EMAIL_AUTOCONFIRM`, `SMTP_*` | Without SMTP, accounts are confirmed at sign-up and password reset cannot send mail. With SMTP, set `ENABLE_EMAIL_AUTOCONFIRM=false` |
| `DISABLE_SIGNUP` | `true` once everyone who should have an account has one |

`deploy/.env` holds secrets: keep it readable by root only (`chmod 600 deploy/.env`) and never commit it (it is git-ignored).

## 3. Start

```bash
cd deploy
docker compose --profile public up -d --build
docker compose logs -f migrate     # "migrate: done (N applied)"
```

The first start creates the database (about a minute), applies every migration, starts Auth, PostgREST and the gateway, builds the app image and starts Caddy, which gets the certificate. Then:

```bash
docker compose ps                                   # every service "running" or "healthy"; migrate "exited (0)"
curl -sS https://<DOMAIN>/api/health                # {"status":"ok","configured":{"auth":true,"inference":true,"webSearch":true}}
```

Open `https://<DOMAIN>`, create an account and send one message. The reply names the Nebius model under it (for example "Nemotron 3.5 Lightning · everyday request"). Turn on web search in the "+" menu and ask about something recent: sources appear under the reply.

## 4. Operate

| Task | Command |
| --- | --- |
| Logs | `docker compose logs -f app` (metadata only; no message text), `docker compose logs auth`, `docker compose logs kong` |
| Update the app | `git pull && docker compose --profile public up -d --build app` (new migrations apply on the next `up`, by `migrate`) |
| Change a setting | Edit `deploy/.env`, then `docker compose --profile public up -d` |
| Back up | `docker compose exec db pg_dump -U postgres postgres > backup-$(date +%F).sql` (contains every user's data; store it encrypted). Stopping the stack keeps the data in `deploy/data/db` |
| Restore | On an empty stack: `docker compose up -d db` then `docker compose exec -T db psql -U postgres postgres < backup.sql` |
| Admin UI | `docker compose --profile studio up -d` and open `http://127.0.0.1:54323` through an SSH tunnel (`ssh -L 54323:127.0.0.1:54323 user@host`). It shows every user's data; never expose it |
| Spend | The caps in `deploy/.env` apply to all users together. The `spend_counters` table holds the usage; the `spend_limit_reached` log event shows refusals |

The migrations are applied by `deploy/db/migrate.sh`, once each, in the order of their names, each in its own transaction, and recorded in `supabase_migrations.schema_migrations` (the table the Supabase CLI uses). A migration that fails stops the stack from starting the app, so the error is visible in `docker compose logs migrate`. Migrations are never applied by hand and never edited after they ran (`tests/integration/frozen-migrations.test.ts`).

## 5. What is different from Cloudflare

- One always-on Node.js process instead of Workers isolates. The circuit breaker and `waitUntil` behave the same way in both (the breaker is per process; `waitUntil` runs the work directly outside Workers).
- Session tokens are signed with `JWT_SECRET` (HS256). `getClaims()` then verifies each request with the Auth service instead of a local key, which is one extra internal request per API call.
- Email: hosted Supabase sends email for you; here, email works only with SMTP settings.
- Backups and updates are yours to run (above). Keep the machine patched and `docker compose pull` the images from time to time, testing on a copy first.

## 6. Dry run before paying

To check the stack before adding a Nebius key, run Ollama on the host and set in `deploy/.env` the same values as in [LOCAL-SIMULATION.md](LOCAL-SIMULATION.md): `OLLAMA_BASE_URL=http://host.docker.internal:11434/v1`, `OLLAMA_EMBEDDING_MODEL=qwen3-embedding:0.6b` and every chain `ollama/qwen3-vl:2b-instruct`. The app container reaches the host through `host.docker.internal`. Switch the chains back and set the Nebius key for production.
