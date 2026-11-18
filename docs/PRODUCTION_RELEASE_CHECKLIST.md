# Production release checklist

This checklist is the gate between the verified staging branch and production. Production database changes and deployments require a separate explicit approval.

## 1. Staging release gate

- [ ] Latest staging branch CI is green.
- [ ] Server and client production dependency audits report zero critical/high/moderate vulnerabilities.
- [ ] Prisma schema validation, client generation, migrations, both builds, and integration tests pass.
- [ ] Render staging deploy is live; `/api/health` verifies database connectivity.
- [ ] All current public tables have RLS enabled.
- [ ] Supabase `anon` and `authenticated` have no access to the public finance schema.
- [ ] Prisma migration history matches the repository.
- [ ] Household authorization, invite lifecycle, revoked access, and outsider isolation pass.
- [ ] Finance flows pass: income, expenses, categories, budgets, obligations, savings, receipts, analytics.
- [ ] Manual visual QA completed at 320/360/390/768px and desktop, in RU and EN.
- [ ] Telegram setup is either explicitly deferred for the first web release or completed and tested separately.

## 2. Production preflight

Before any production change:

- [ ] Confirm the production Render service, deploy branch, health-check path, and current live commit.
- [ ] Confirm production `DATABASE_URL` points to the production database, never staging.
- [ ] Confirm production `JWT_SECRET` is unique and server-only.
- [ ] Confirm `CLIENT_ORIGIN` is the production URL.
- [ ] Confirm any Telegram token is rotated and stored only as a server secret; Telegram can remain disabled for the first web release.
- [ ] Take and verify a production database backup/snapshot.
- [ ] Review every pending Prisma migration and its lock/availability impact.
- [ ] Confirm the production deployment can be rolled back to the previous application build.
- [ ] Confirm no production setting, data, or billing change is bundled unintentionally.

## 3. Migration and deployment order

1. Announce a short maintenance window if required.
2. Take the final backup and record the current production migration state.
3. Apply the reviewed Prisma migrations manually to the production database.
4. Verify migration history and database security invariants.
5. Deploy the approved application commit to the production Render service.
6. Wait for the production health check.
7. Run smoke tests for login, dashboard, create/edit/delete expense, income, budgets, and household access.
8. Check Render logs and database errors.
9. Keep the previous Render deploy and backup available until the release is accepted.

The production `render.yaml` intentionally does not run migrations automatically. Do not add automatic production migrations to application startup.

## 4. Rollback

- Application rollback: restore the previous known-good Render deployment.
- Database rollback: Prisma migrations are not automatically reversible. Do not attempt ad-hoc reverse SQL. If a migration or data change caused damage, stop writes and restore from the verified backup using a reviewed recovery plan.
- Do not roll back application code across a migration unless the old code is compatible with the new schema.

## 5. Explicit approval

Staging verification does not authorize production changes. Before applying production migrations or deploying, obtain explicit approval for the exact production release and migration set.
