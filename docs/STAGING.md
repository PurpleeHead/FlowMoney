# nummioX staging environment

## Live architecture

- Render service: `nummiox-staging`
- URL: https://nummiox-staging.onrender.com
- Region: Singapore
- Plan: Free
- Deploy branch: `feature/household-collaboration`
- Auto-deploy: only after GitHub checks pass
- Health check: `/api/health` (includes a database readiness query)

The live staging database is the separate Supabase project `nummioX-staging-db` in Singapore (`ap-southeast-1`). Render connects through the Supabase shared session pooler on port 5432. The complete `DATABASE_URL` is a Render server-side secret and must never be copied into source control, browser variables, logs, or chat.

The staging service has its own `JWT_SECRET` and `CLIENT_ORIGIN`. Never point it at the production database or production origin.

## Build and migrations

The live Render staging service builds with:

```sh
npm ci && npm run db:generate && npm run db:migrate && npm run build
```

Prisma 7 configuration is in `server/prisma7.config.ts`. Migrations are applied by the staging build, not by application startup. CI separately validates the schema, generates the client, applies all committed migrations to an ephemeral PostgreSQL database, builds both workspaces, and runs server/client tests.

The current staging database has eight successful Prisma migrations, including:
- Prisma 7-compatible client and PostgreSQL driver adapter
- public-schema access lockdown and RLS
- indexes for remaining foreign-key columns

## Database access boundary

All finance data is accessed through the authenticated Express API. The browser must not query Supabase tables directly.

- RLS is enabled on all 19 current public tables.
- `anon` and `authenticated` have no schema usage or table read/write grants.
- No client RLS policies are defined intentionally; the public Data API is not an application access path.
- The server-only PostgreSQL role retains access. The `service_role` remains privileged and must never be exposed to the client.
- CI checks that every public table has RLS enabled. New public tables must preserve this rule.

Supabase's remaining `rls_enabled_no_policy` notices are informational and expected for this backend-only access model. Performance advisor notices about unused indexes are expected on an almost-empty staging database; do not remove the foreign-key indexes just because they have not yet been exercised.

## Telegram

Telegram Mini App setup is intentionally deferred. Email/password web authentication remains available. Before enabling Telegram, rotate the previously exposed bot token in BotFather and add the new token directly to the staging Render secret. Never send the token in chat or commit it.

## Important configuration warning

The checked-in `render.staging.yaml` still contains an older Render-Postgres `fromDatabase` template. It does **not** describe the live Supabase-backed staging database. Do not re-sync or apply that Blueprint until it has been reconciled with the live architecture and reviewed separately.

## Staging smoke-test plan

1. Confirm Render reports the service as live and the `/api/health` database readiness check passes.
2. Verify email/password registration and login.
3. Create and edit income, expense, account, budget, and savings records.
4. Verify category selection, receipt translation, analytics, and date filters.
5. Verify household invitation, acceptance, shared visibility, profile attribution, revocation, and outsider isolation.
6. Check Russian and English copy and responsive layouts at 320, 360, 390, 768, and desktop widths.
7. Confirm production resources and data remain untouched.

The free Render web service may spin down while idle; the first request after inactivity can be slower. Staging is for verification, not the production data store.
