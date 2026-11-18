# nummioX staging environment

## Current resources

Staging is isolated from production and is the only environment used for feature-branch deployments.

- Render web service: `nummiox-staging`
- URL: `https://nummiox-staging.onrender.com`
- Render service ID: `srv-dbq6q26tlv9c73eooo7g`
- Region / plan: Singapore / Free
- Deploy branch: `feature/household-collaboration`
- Auto-deploy: only after GitHub checks pass
- Database: dedicated Supabase project `nummioX-staging-db`
- Supabase project ref: `ygfzftyxgizeyrkgrfsx`
- Supabase region: `ap-southeast-1`
- PostgreSQL: 17.11

The Render service's `DATABASE_URL` is a secret that connects to the dedicated Supabase staging database through its pooler. Its value must remain in Render's environment settings; never commit it, print it in logs, or send it in chat. The staging JWT secret is independently generated in Render. `CLIENT_ORIGIN` must remain the staging URL.

The database is not a Render-managed PostgreSQL resource. The staging Blueprint therefore declares `DATABASE_URL` as a manual secret and does not provision a second database.

## Build and migration behavior

The staging Render build command is:

```sh
npm ci && npm run db:generate && npm run db:migrate && npm run build
```

Prisma migrations run during the staging build. This is intentional for staging only. The production Blueprint does **not** run migrations automatically; production migrations require a separate backup, rehearsal and explicit approval.

The repository pins Node.js through `.node-version`. GitHub Actions reads the same file so CI and Render use the same runtime.

## Database security boundary

- All 19 application/public tables have Row Level Security enabled.
- The browser does not access Supabase Data API tables directly.
- `anon` and `authenticated` have no usage on the `public` schema and no direct table access.
- Server-side `postgres` and privileged `service_role` access are preserved.
- RLS is intentionally enabled without client policies because finance data is served through the authenticated Express API.
- New application tables must enable RLS in their migration. CI checks this invariant.

The dedicated staging database currently has eight successful Prisma migrations, including the household access lockdown and foreign-key indexes.

## Telegram

Telegram Mini App end-to-end setup is deliberately deferred. Before testing it, rotate the previously exposed bot token in BotFather, add the new token directly to the staging Render secret `TELEGRAM_BOT_TOKEN`, and configure the staging Main Mini App URL. Never paste the token into chat or commit it.

## Staging verification

- [ ] Render deployment is `live` and its `/api/health` readiness probe confirms PostgreSQL connectivity.
- [ ] Prisma migrations are all applied with no failed or rolled-back entries.
- [ ] Registration and email/password login work.
- [ ] Income, expenses, categories, budgets, obligations and savings goals can be created, edited and deleted.
- [ ] Household invitation, acceptance, profile attribution and immediate revocation work.
- [ ] A third account cannot read or mutate another household's records.
- [ ] Russian and English copy is correct.
- [ ] Manual responsive QA covers 320px, 360px, 390px, 768px and desktop.
- [ ] Keyboard navigation, dialogs, focus indicators and cancel/confirm paths work.
- [ ] Telegram-specific login and invite deep links are tested after BotFather setup.

No production service, production database or production migration is part of staging verification.
