# Self-hosting Supahound

Status: **alpha.** Flywheel's hosted deploy (2026-11-10) followed these steps. Nobody has run this
guide from zero on clean accounts yet (#67). The items under "Not verified yet" can still change.

Supahound is fair source under [FSL-1.1-ALv2](../LICENSE.md). You may run it for your own apps and
for your company. You may not offer it to others as a commercial hosted service (decision 025).
Flywheel runs the hosted version.

You supply every account, key and ID. Supahound never calls a Flywheel service.

## The five-minute path: one scan from your laptop

You need Node.js 22+ and pnpm 10.

```bash
pnpm install
cp .env.example packages/core/.env     # set SUPABASE_ACCESS_TOKEN (scope analytics:read)
pnpm -s print-sql                      # the last query reads your RLS policies
# Run that query in your project's SQL editor and save the rows as JSON, then:
pnpm scan --project <ref> --ownership "$PWD/policies.json"
```

`pnpm scan` reads the last 15 minutes of your project's edge logs once and prints the findings.
It runs inside `packages/core`, so pass absolute paths and keep `.env` there.

**Warning:** a personal access token gives full access to your Supabase account and does not
expire. Use one only on your own machine, and revoke it when you are done. The deployed version
uses read-only OAuth instead.

## What the full deployment is

| Part | Runs on | Does |
| --- | --- | --- |
| `apps/web` | A Cloudflare Worker | Sign-in (magic links), workspaces, Connect Supabase, dashboard |
| `apps/poller` | A Cloudflare Worker, cron every minute plus a queue | Reads each project's edge logs, runs the detectors, opens incidents |
| Supahound database | Your own Supabase project | Schema `supahound` with forced RLS, reached through Hyperdrive |

The Supahound database is a separate Supabase project from the apps it watches. Use a new
project for it.

## What you need

| Item | Where you get it | Used by | Kind | Required |
| --- | --- | --- | --- | --- |
| A Supabase project for Supahound's own data | supabase.com | both Workers | account | yes |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | That project: Settings → API | web | var | yes |
| Two database login users and their passwords | `supabase/setup/login-users.sql` (step 3) | Hyperdrive | — | yes |
| `SEND_EMAIL_HOOK_SECRET` | That project: Auth → Hooks → Send Email Hook | web | secret | yes |
| A Supabase OAuth app: `SUPABASE_OAUTH_CLIENT_ID`, `SUPABASE_OAUTH_CLIENT_SECRET` | Your Supabase org: Settings → OAuth Apps | both Workers | var, secret | yes |
| A Cloudflare account with Workers, Queues and Hyperdrive | dash.cloudflare.com | both Workers | account | yes |
| Two Hyperdrive configs, caching off | `wrangler hyperdrive create` (step 4) | `HYPERDRIVE_APP` (both), `HYPERDRIVE_SCHEDULER` (poller) | binding | yes |
| A queue and a dead-letter queue | `wrangler queues create` (step 5) | poller | binding | yes |
| A sending domain on Cloudflare Email Service, `EMAIL_FROM_ADDRESS`, `EMAIL_FROM_NAME` | `wrangler email sending enable` (step 6) | web (sign-in), poller (incident alerts) | binding, var | yes |
| `SUPAHOUND_MASTER_KEYS` | `pnpm -s master-key` (step 2) | both Workers, the same value | secret | yes |
| `APP_URL` | Your app's origin, for example `https://supahound.example.com` | both Workers | var | yes |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway | poller | secret | no |
| `SUPAHOUND_BILLING` | `off` for self-hosting; `stripe` needs the Stripe items below (decision 028) | both Workers | var | yes |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PRO` | Your Stripe account, only with `SUPAHOUND_BILLING=stripe` | web (all), poller (key and prices) | secret, var | no |
| `SUPAHOUND_BILLING_EXEMPT_DOMAINS` | Your staff email domains, comma-separated; workspaces whose only owner uses one need no card (decision 029). Empty: none | web | var | no |
| `SUPPORT_EMAIL`, `TERMS_URL`, `PRIVACY_URL` | Your own | web | var | no |

Without `AI_GATEWAY_API_KEY`, incident summaries use template text and no model is called. With
it, every call asks for zero data retention (decision 005), which needs a Vercel Pro or
Enterprise team. Billing (Stripe) is part of the hosted product only.

Check Cloudflare's and Supabase's current pricing pages for plan limits on Workers, Queues,
Hyperdrive, Email Service and database size.

## Steps

### 1. The Supahound database

1. Create a Supabase project for Supahound.
2. Apply the migrations in order, as the database owner (`postgres`):

   ```bash
   export SUPAHOUND_DB_URL='postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres'
   for f in supabase/migrations/*.sql; do psql "$SUPAHOUND_DB_URL" -v ON_ERROR_STOP=1 -f "$f"; done
   ```

   The Postgres tests apply the same files in the same order on every CI run.
3. Settings → API → Exposed schemas: make sure `supahound` is **not** listed. Only the Workers
   reach this schema.
4. Settings → JWT keys: use asymmetric signing keys. Then `getClaims()` verifies sessions locally.
5. Auth → URL configuration: set the site URL to `APP_URL`. Add `<APP_URL>/auth/confirm` to the
   redirect URLs.

### 2. Master keys

```bash
pnpm -s master-key        # prints 1:<32 random bytes, base64>
```

This value seals every Supabase OAuth token at rest, per tenant (decision 004). Store it in a
password manager. If you lose it, every connected org must connect again. Set the same value in
both Workers.

To rotate: `SUPAHOUND_MASTER_KEYS='<current value>' pnpm -s master-key --rotate`. It keeps the
old keys, so existing tokens still open, and adds a new version that seals new tokens.

### 3. Database login users

```bash
psql "$SUPAHOUND_DB_URL" \
  -v app_password="$(openssl rand -hex 32)" \
  -v scheduler_password="$(openssl rand -hex 32)" \
  -f supabase/setup/login-users.sql
```

Pass your own saved passwords instead of `openssl` if you need them again in step 4. The file
creates `supahound_app_login` and `supahound_scheduler_login`. They inherit the `supahound_app` and
`supahound_scheduler` roles and nothing more: no superuser, no BYPASSRLS. Running it again changes
the passwords.

Optional, only if you email a subprocessor notice to your workspace owners (decision 037):
`psql "$SUPAHOUND_DB_URL" -v notifier_password="$(openssl rand -hex 32)" -f supabase/setup/notifier-user.sql`
creates `supahound_notifier_login`, which reads owners' addresses and nothing else. Set the notice
variables in `.env.example`, then run `pnpm subprocessor-notice --name … --purpose … --location …
--effective YYYY-MM-DD --contact …`. Without `--send` it only counts.

### 4. Hyperdrive

Use the Supabase **session pooler**. Copy its host from the dashboard (Connect → Session
pooler), for example `aws-0-eu-west-1.pooler.supabase.com`, port 5432. The prefix (`aws-0`,
`aws-1`) differs between projects, and the wrong one answers "tenant/user not found". On the
pooler the user name carries the project ref: `supahound_app_login.<ref>`. The direct host `db.<ref>.supabase.co` has an IPv6
address only. Never use the transaction pooler (port 6543): the app sets the tenant per
transaction, and Hyperdrive already pools.

```bash
wrangler hyperdrive create supahound-app --caching-disabled \
  --connection-string 'postgresql://supahound_app_login.<ref>:<app password>@<pooler host>:5432/postgres'
wrangler hyperdrive create supahound-scheduler --caching-disabled \
  --connection-string 'postgresql://supahound_scheduler_login.<ref>:<scheduler password>@<pooler host>:5432/postgres'
```

Test each login with `psql` before you create the config. `hyperdrive create` also connects
once and fails on a wrong host or password.

Put the IDs in `apps/web/wrangler.jsonc` (`HYPERDRIVE_APP`) and `apps/poller/wrangler.jsonc`
(`HYPERDRIVE_APP` and `HYPERDRIVE_SCHEDULER`). Caching must stay off (decision 008): a cached
query result could serve one tenant's rows to another.

### 5. Queues

```bash
wrangler queues create supahound-polls
wrangler queues create supahound-polls-dlq
```

### 6. Email

```bash
wrangler email sending enable <your domain>
```

Set `EMAIL_FROM_ADDRESS` (an address on that domain) and `EMAIL_FROM_NAME` in
`apps/web/wrangler.jsonc` (sign-in links) and in `apps/poller/wrangler.jsonc` (incident alerts,
decision 030). They may differ, for example `login@` and `alerts@`.

### 7. The Supabase OAuth app

In the Supabase org that will own the app: Settings → OAuth Apps → add an app.

- Scopes: `analytics:read` (edge logs), `database:read` (the RLS policies) and `projects:read`
  (the project picker lists your projects; decision 023). All three are read-only. Ask for no others.
- Redirect URI: `<APP_URL>/api/supabase/callback`.

Put the client ID in both `wrangler.jsonc` files as `SUPABASE_OAUTH_CLIENT_ID`.

### 8. Deploy

Set the vars in both `wrangler.jsonc` files: `APP_URL`, and in the web app `SUPABASE_URL`,
`SUPABASE_PUBLISHABLE_KEY` and the optional brand links. Then set the secrets and deploy. Wrangler
is a dev dependency, so run it with `pnpm exec`:

```bash
cd apps/web
pnpm exec wrangler secret put SUPAHOUND_MASTER_KEYS
pnpm exec wrangler secret put SUPABASE_OAUTH_CLIENT_SECRET
pnpm exec wrangler secret put SEND_EMAIL_HOOK_SECRET
pnpm build && pnpm run deploy      # "pnpm deploy" is a different, built-in pnpm command

cd ../poller
pnpm exec wrangler secret put SUPAHOUND_MASTER_KEYS
pnpm exec wrangler secret put SUPABASE_OAUTH_CLIENT_SECRET
pnpm exec wrangler secret put AI_GATEWAY_API_KEY       # optional
pnpm exec wrangler deploy
```

The `wrangler` commands in steps 4 to 6 work the same way: run them from `apps/poller` with
`pnpm exec wrangler`.

### 9. The Send Email Hook

In the Supahound Supabase project: Auth → Hooks → Send Email Hook → HTTPS,
`<APP_URL>/api/auth/send-email-hook`. Copy its secret (`v1,whsec_…`) into
`SEND_EMAIL_HOOK_SECRET` (step 8), then redeploy the web Worker.

### 10. First sign-in

Open `APP_URL`, sign in with a magic link, create a workspace, connect your Supabase org and pick
the projects to watch. The poller reads them on the next minute.

### 11. Speed: run the web Worker next to your database

A signed-in page makes about ten Postgres round trips in a row. Without a placement hint the Worker
runs next to the visitor, and each trip crosses to your database region. Add your Supabase region
to `apps/web/wrangler.jsonc` before you deploy, for example
`"placement": { "region": "aws:eu-west-1" }`. Turn on asymmetric JWT signing keys in the Supabase
dashboard (Project Settings → JWT Keys) so `getClaims()` verifies sign-ins without a call to Auth.
Decision 039.

## Never do these

- Never enable Hyperdrive query caching, or page caching for the app.
- Never expose the `supahound` schema through the Supabase Data API.
- Never connect the Workers as `postgres` or any role with BYPASSRLS.
- Never commit `.dev.vars`, passwords, the master keys or the hook secret. CI runs gitleaks on
  every push (`.gitleaks.toml`).

## Data retention

The poller runs a data job once a day at 00:40 UTC, in every billing mode (decision 037). It keeps
incidents, findings and poll runs for 30 days after their last activity, and deletes a closed
workspace's logs and history 30 days after it closed; the workspace record and audit log stay.
With billing off no workspace counts as paying, so these rules always apply. Nothing to configure:
the cron that polls every minute runs it.

## The scan funnel

The repo includes the scan funnel's authorization code (decision 016): DNS-TXT proof of domain
control and a scope guard. If you run scans, you are responsible for having permission to scan
each domain, and for the law where you run them. The active-scan engine is not built.

## Not verified yet

The rehearsal (#67) checks these:

- Whether a Supabase OAuth app in one org can authorize other orgs without a review step.
- Whether `supabase_read_only_user` can read `pg_policies` through the read-only SQL endpoint (#4).
- The JWT subject and role field names in live edge logs (#3).
