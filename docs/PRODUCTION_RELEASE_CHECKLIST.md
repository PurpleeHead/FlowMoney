# nummioX production release checklist

Production remains a separate, explicitly approved release. Staging merges and deployments do not authorize a merge to `main`, a production migration, or a production deploy.

## 0. Verified staging baseline — 18 November 2026

The following items are verified on staging only. They do not certify or authorize production changes.

- [x] Staging application runtime is live on commit `85192b4b5b1953b54b15d4bd726f520ddd1296a3` (including the Prisma 7 runtime, RLS lockdown, foreign-key indexes and database readiness probe).
- [x] Render uses Node.js 22.23.3 from `.node-version`.
- [x] Prisma 7.10.1 client generation and all 8 committed migrations complete; no pending migrations remain.
- [x] The staging health probe runs a real PostgreSQL query through the runtime Prisma adapter and Render reports the service live.
- [x] CI passes on PostgreSQL 17: schema validation, migration replay, server/client builds, 21 server tests, 2 client test files and PowerShell syntax checks.
- [x] Isolated server and client production dependency audits report zero vulnerabilities.
- [x] RLS is enabled on all 19 public tables; `anon` and `authenticated` have no public-schema/table access.
- [x] All 11 previously missing foreign-key indexes are present; Supabase no longer reports unindexed foreign keys.

**Known non-blocking item:** the full development-toolchain audit still reports 5 high-severity findings (0 critical) in build/test dependencies. The isolated production dependency trees remain clean. A forced downgrade of Vitest introduced critical advisories, so it was not applied.

**Still required before production:** manual visual QA in RU/EN at the listed viewport widths, production database/provider and secret separation verification, a verified production backup/restore rehearsal, and explicit approval for production migration/deploy. Telegram setup remains deferred as recorded below.

---
## 1. Before production access is changed

- [ ] Confirm the production Render service, branch, region and current deployment.
- [ ] Confirm the production database project/provider, region, plan, PostgreSQL version and connection mode.
- [ ] Confirm production `DATABASE_URL`, `JWT_SECRET` and `CLIENT_ORIGIN` are configured in Render without exposing their values.
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

## 6. Deliberately deferred

Telegram BotFather token rotation and Main Mini App configuration are deferred by the user. Browser-based household invitations now use secure `#invite=...` links and can be accepted after email/password sign-in, so family invitations do not require the bot. Telegram Main Mini App configuration is only a blocker if Telegram itself is required as an initial sign-in or launch channel; otherwise it can be enabled in a separate approved release after the web application is stable.

## 7. Manual product QA

Before inviting real users, manually test Russian and English at 320px, 360px, 390px, 768px and desktop widths. Cover keyboard navigation, dialogs, empty/error/success states, long labels and currency amounts, date filters, household invitation flows and cancellation of destructive actions.
