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

The dedicated staging database has nine committed Prisma migrations in the current release baseline, including household access lockdown and foreign-key indexes. CI replays the committed migration history against ephemeral PostgreSQL 17 before a staging change can deploy.

## Authentication and account recovery

- Login includes **Remember me**. When selected, the JWT lifetime is 30 days; otherwise it remains 7 days.
- The token is still stored by the browser client. This is a longer-lived login session, not refresh-token rotation.
- Password-reset request/confirmation endpoints are deployed. Email delivery remains disabled until `RESEND_API_KEY`, `RESEND_FROM_EMAIL` and `APP_BASE_URL` are configured on staging and a real mailbox reset is tested. See `docs/EMAIL_SETUP.md`.

## Telegram

The staging code now includes the secure webhook, `/start`, `/help`, `/app`, read-only `/balance` and `/month` commands, and opt-in payment reminders. Keep the bot token in the Render secret `TELEGRAM_BOT_TOKEN`; never paste it into chat or commit it. Configure BotFather's staging Main Mini App URL only after verifying the staging URL inside Telegram.

The one-shot reminder worker is implemented. Automated scheduling uses the GitHub Actions workflow proposed in PR #162, which must be merged into the repository default branch and requires repository Actions secrets `DATABASE_URL` (staging database only) and `TELEGRAM_BOT_TOKEN`. Until that setup is completed and a scheduled/manual workflow run succeeds, saved reminder preferences do not guarantee automatic delivery.

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
