# nummioX production release checklist

Production remains a separate, explicitly approved release. Staging merges and deployments do not authorize a merge to `main`, a production migration, or a production deploy.

## 0. Verified staging baseline — 20 November 2026

The following items are verified on staging only. They do not certify or authorize production changes.

- [x] Latest staging application commit `1807a6d1956ae08e3deee7e8e762fd62e021863c` is deployed and Live on Render deploy `dep-dc057em7bikc739uvdj0`. It includes password-reset URL safety checks, referrer protection, the Prisma Effect security patch, Telegram webhook/commands/reminders, household collaboration and mobile navigation.
- [x] Render uses Node.js 22.23.3 from `.node-version`; staging service `nummiox-staging` is on the Free plan in Singapore.
- [x] Prisma 7.10.1 client generation and all 11 committed migrations complete in CI against ephemeral PostgreSQL 17.
- [x] The staging health probe runs a real PostgreSQL query through the runtime Prisma adapter; the latest Render deployment for the release commit is `live`.
- [x] Full CI passed for staging commit `1807a6d1956ae08e3deee7e8e762fd62e021863c`, including high/critical dependency audit, Prisma validation/generation, migration replay, server/client builds and tests, and PowerShell syntax validation.
- [x] Full repository and Render build dependency audits report zero vulnerabilities. Prisma 7.10.1 remains in place; its transitive `effect` dependency is pinned to patched `3.22.1`. CI now fails on high and critical findings across development/build tooling as well as runtime dependencies.
- [x] RLS is enabled on all 19 public application tables; `anon` and `authenticated` have no public-schema/table access.
- [x] All 11 previously missing foreign-key indexes are present; Supabase no longer reports unindexed foreign keys.
- [x] Household integration tests cover email/password accounts, shared finance access, third-account isolation, one-time invitations, concurrent profile assignment and immediate revocation.
- [x] Password recovery backend is deployed to staging: single-use 30-minute tokens, hashed storage, session invalidation, enumeration-safe responses, rate limits, token removal from the browser URL and a global `no-referrer` policy. Password-reset email delivery requires Resend credentials plus an explicit valid `APP_BASE_URL` (HTTPS in production); it fails closed if that URL is missing or invalid. Email delivery remains disabled until Resend is configured and a real mailbox test succeeds.
- [x] Login now offers **Remember me**: checked sessions receive a 30-day JWT; unchecked sessions retain the 7-day default. Tokens remain browser-local and this is not refresh-token rotation.
- [x] Obligation categories accept custom user-entered values and reuse saved values as future suggestions.
- [x] Telegram webhook, `/start`, `/help`, `/app`, read-only `/balance` and `/month`, and opt-in due-obligation reminder worker are implemented on staging. PR #162 is merged to the default branch; its 15-minute GitHub Actions workflow checks out the staging branch. The latest scheduled run failed because repository Actions secrets `DATABASE_URL` and `TELEGRAM_BOT_TOKEN` are not configured. PR #170 proposes skipping the worker until both secrets exist; it targets `main`, remains open and unmerged pending separate approval.
- [x] Browser household invitations use secure web links; Telegram deep links remain optional.

**Still required before production:** manual visual and two-account QA in RU/EN, Resend domain verification and a real mailbox password-reset test (including `APP_BASE_URL`), staging Telegram Actions secrets and a successful real reminder delivery, Telegram Mini App manual testing, production database/provider and secret separation verification, a verified production backup/restore rehearsal, and explicit approval for production migration/deploy. PR #170 must be separately approved before merging its workflow-only change to `main`.

---
## 1. Before production access is changed

- [ ] Confirm the production Render service, branch, region and current deployment.
- [ ] Confirm the production database project/provider, region, plan, PostgreSQL version and connection mode.
- [ ] Confirm production `DATABASE_URL`, `JWT_SECRET` and `CLIENT_ORIGIN` are configured in Render without exposing their values.
- [ ] Verify a production sending domain in Resend, then configure production-only `RESEND_API_KEY`, `RESEND_FROM_EMAIL` and `APP_BASE_URL`; send and complete a real password-reset email test before enabling public recovery.
- [ ] Verify production and staging use different database URLs and JWT secrets.
- [ ] Create a production database backup/snapshot and verify a restore path.
- [ ] Rehearse all pending Prisma migrations against a disposable database with the same PostgreSQL major version.
- [ ] Review the migration SQL for locks, destructive operations and compatibility with the currently deployed app.

## 2. Code and infrastructure gates

- [ ] All required GitHub checks pass on the exact release commit.
- [ ] Production dependency audits show no high or critical runtime vulnerabilities in either server or client workspaces.
- [ ] Prisma schema validation, client generation, migration rehearsal, build and integration tests pass.
- [ ] Render Node.js runtime matches the repository `.node-version`.
- [ ] Production `/api/health` checks PostgreSQL readiness, not just Express process liveness.
- [ ] The production Blueprint keeps migrations manual; do not add automatic production migrations to the build or start command.
- [ ] Database access remains backend-only; no Supabase service-role or database secret is exposed to the browser.

## 3. Migration and deployment sequence

1. Take and verify the production backup.
2. Record the current production commit and deployment ID.
3. Review the exact pending migration list and rehearse it once more.
4. With explicit approval, run `npm run db:migrate` against production using the approved production environment.
5. Verify migration history and database access controls.
6. With explicit approval, deploy the reviewed application commit to the production service.
7. Wait for Render's readiness probe to pass before declaring the release live.

Do not use a staging `DATABASE_URL` for a production migration. Do not copy credentials between environments.

## 4. Post-deploy smoke tests

- [ ] `/api/health` returns `status: ok` and `database: ok`.
- [ ] Existing account login and session renewal work.
- [ ] Dashboard and historical balances load correctly.
- [ ] Create, edit and delete a test income and expense.
- [ ] Categories, budgets, obligations and savings goals work.
- [ ] Household owner/member permissions and immediate revocation work.
- [ ] A third account cannot read another household's data.
- [ ] Create a household invitation, open its web link in a separate browser session, sign in/register, preview it, and accept it.
- [ ] No database connection, Prisma or unhandled API errors appear in Render logs.
- [ ] Verify production data and balances were not altered by smoke tests; remove only explicitly created test records.

## 5. Rollback

- Redeploy the recorded previous application commit if the application release is unhealthy.
- Do not assume a Prisma schema migration can be rolled back by deploying old code.
- If a database rollback is required, stop writes and follow the verified backup restore procedure.
- Never run an unreviewed destructive or reverse migration during an incident.

## 6. Telegram workstream (implemented on staging; operational verification pending)

The staging implementation includes signed Mini App authentication, account linking, household invite deep links, webhook handling, `/start`, `/help`, `/app`, read-only `/balance` and `/month`, opt-in payment reminders, and a reminder worker. PR #162 adds a 15-minute GitHub Actions schedule on the default branch; the workflow explicitly checks out `feature/household-collaboration` and uses staging credentials only.

- [ ] Add repository Actions secret `DATABASE_URL` pointing to the staging database and `TELEGRAM_BOT_TOKEN`; the latest run confirmed both were empty. Never paste either secret into chat or use production values.
- [ ] Run the workflow manually once after adding both secrets, confirm a successful worker result, then verify a real opted-in reminder in Telegram.
- [ ] Manually test `/start`, `/help`, `/app`, `/balance`, `/month`, Mini App authentication and household access.
- [ ] Before production, rotate/create a separate production bot token, configure the production webhook and BotFather Main Mini App URL only after explicit production approval.

The reminder window tolerates delayed scheduled runs up to 60 minutes; idempotency prevents ordinary duplicate sends. Abrupt worker termination between claiming a reminder and sending it remains a reliability edge case to monitor. See `docs/TELEGRAM_MINI_APP.md` and `docs/TELEGRAM_REMINDERS.md`.

## 7. Manual product QA

Before inviting real users, manually test Russian and English at 320px, 360px, 390px, 768px and desktop widths. Cover keyboard navigation, dialogs, empty/error/success states, long labels and currency amounts, date filters, household invitation flows and cancellation of destructive actions.
