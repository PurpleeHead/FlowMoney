# FLOWMONEY production release runbook (operator-controlled)

Status: preparation only. This runbook does not authorize a merge, deployment, Render setting change, or production database operation. Execute only after the owner confirms the target database and approves the change window.

## 0. Hard stop conditions

Do not proceed if any of the following is true:

- The intended production database is not identified by its exact Render resource ID and database name.
- The web service's `DATABASE_URL` cannot be matched to that approved database without printing or sharing credentials.
- The latest reviewed release commit differs from the commit intended for deployment.
- A verified encrypted backup and a successful restore to a disposable database are missing.
- The legacy wallet preflight reports unexplained non-zero balances or a mismatch between legacy Wallet balances and WalletMovement totals.
- CI, migration verification, or dependency/security checks are failing or still running.

The currently observed Render workspace listing contains `flowmoney-test-db` (`flowmoney_test_db`, Free plan, expires 2026-11-15). This is a test database, not an approved production target. Never infer the live service's database from this listing.

## 1. Stabilize the service configuration

1. Open the Render dashboard and inspect `flowmoney-app` without exposing secret values.
2. Record the service ID, configured branch, current live commit, health-check path, start command, auto-deploy setting, and the database resource referenced by `DATABASE_URL`.
3. Note that the live start command currently runs `prisma migrate deploy` before `npm start`. A new deploy may apply pending migrations during process startup.
4. Before any merge or release, obtain explicit owner approval to disable auto-deploy or otherwise prevent an unreviewed commit from triggering a deploy. Do not change the setting as part of this checklist without that approval.
5. Reconcile the live service configuration with the reviewed `render.yaml` (manual deploy, `/api/ready`) and record the approved differences.

## 2. Create and verify a backup

1. Use the approved database provider's supported backup/export process from a trusted environment. Prefer a native backup/snapshot where available.
2. Encrypt any exported dump before it leaves the trusted environment. Keep encryption keys separate from the backup and never commit backups, connection strings, or keys to Git.
3. Record backup timestamp, database identity, dump format, file size, and a SHA-256 checksum in the private operations log (not this repository).
4. Verify the artifact is readable, for example with `pg_restore --list` for a custom-format dump. A checksum/readability check alone does not prove restorability.
5. Restore the backup into a separate disposable PostgreSQL database with no production write access. Confirm schema and expected row counts/integrity checks. Do not restore over the source database.

## 3. Run the legacy wallet preflight

Only after the database identity is explicitly approved and the backup restore succeeds:

1. Connect using a protected environment variable or trusted secret manager; do not place credentials directly in shell history or logs.
2. Run the read-only SQL in `server/prisma/tests/preflight-legacy-wallet-balances.sql` against the approved target before any wallet-movement migration.
3. Save the result privately. Reconcile every non-zero legacy `Wallet.balance` and compare it with `WalletMovement` totals. Do not invent opening balances or insert adjustment rows automatically.
4. Stop if any row is unexplained. Obtain an explicit, reviewed reconciliation plan before proceeding.

## 4. Pre-deploy gate

- [ ] PR reviewed and approved; no unresolved financial-accounting or security findings.
- [ ] CI `verify` and `verify-migrations` green on the exact release commit.
- [ ] Dependency/security workflow green on the same commit.
- [ ] Migration diff reviewed; migration has been applied successfully to a disposable restored copy.
- [ ] Backup and restore evidence recorded privately.
- [ ] Legacy wallet preflight reconciled and signed off.
- [ ] Render branch, auto-deploy, health-check, environment variables, and database identity approved.
- [ ] Owner explicitly approves the production deployment window.

## 5. Controlled deploy and smoke tests

After the pre-deploy gate is complete and deployment is explicitly approved:

1. Deploy only the exact reviewed commit using the approved manual release procedure.
2. Verify readiness using `/api/ready` and liveness using `/api/health`. Readiness must report a reachable database; liveness alone is not proof of database health.
3. Run smoke tests with a dedicated test account and reversible/test data where possible:
   - registration and login;
   - direct RUB → USDT exchange with no VND outcome (must not invent VND);
   - direct RUB → VND and RUB → USDT → VND with actual outcomes;
   - expense with and without actual USDT card debit;
   - edit/delete exchange and expense, verifying no duplicate ledger movements;
   - receipt OCR review and explicit save;
   - journal pagination and CSV export beyond the first page.
4. Confirm totals, weighted rates, and wallet movements are consistent before opening access to users.
5. If readiness, migrations, or financial smoke tests fail, stop further changes and follow the approved rollback/restore plan. Do not improvise a production data repair.

## 6. Release evidence

Record privately: approved database resource ID (never credentials), release commit SHA, migration status, backup checksum and restore result, preflight outcome, smoke-test outcomes, deployment ID, and approver/time. Update the repository checklist with non-sensitive results only.


## Configuration safety update — 2026-10-22

- The proposed Render Blueprint now starts the web process with `npm start` only. It no longer runs `prisma migrate deploy` as an application startup side effect.
- This repository change does **not** change the currently configured live Render service. The live service must be inspected and reconciled separately; do not assume the Blueprint has been applied.
- Because the currently configured service uses the Free plan, do not assume Render pre-deploy commands are available. Run production migrations only as a separately approved, operator-controlled release step from a trusted environment after the target database identity, encrypted backup, isolated restore drill, and legacy wallet preflight are signed off.
- Use the exact reviewed commit and approved database connection from a protected secret source. Never paste connection strings into chat, source code, CI logs, or shell history. Verify the migration result before manually deploying the matching application commit.
- CI and dependency-remediation workflows for commit `94e77840d1f420ae9577afa8ed31f33da68566f4` were still running at the time of this note; no green result is claimed here. The PostgreSQL migration/equivalence job had completed successfully, while the main test/build and dependency-install jobs were still in progress.
- No live Render settings, production database, or deployment were changed by this update.
