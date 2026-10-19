# FLOWMONEY production release checklist

This checklist is intentionally conservative. Passing CI does not prove that the production database has been backed up or that historical balances are correct.

## Before any production migration

- [ ] Confirm the target database is the intended production database; never use the expiring Render free test database as production.
- [ ] Create an encrypted database backup and verify that the uploaded object is non-empty.
- [ ] Complete a restore drill into an isolated database and verify that the restored schema and key records are readable.
- [ ] Record the current deployed commit and the database migration status.
- [ ] Run the read-only legacy wallet check in [preflight-legacy-wallet-balances.sql](../server/prisma/tests/preflight-legacy-wallet-balances.sql) against the target database.
- [ ] If any legacy `Wallet.balance` is non-zero, stop and reconcile it manually against source operations and the intended real balance. Do not copy balances into `WalletMovement` blindly: doing so can double-count historical activity or conceal stale snapshots.
- [ ] Confirm all migrations apply successfully to a disposable PostgreSQL instance and the migration rollback/idempotency tests pass.
- [ ] Review the exact release diff and approve the migration plan before touching production.

## Deploy and verify

- [ ] Keep Render automatic deploys disabled until all release gates are complete.
- [ ] Deploy only the reviewed commit.
- [ ] Verify `/api/health` returns liveness and `/api/ready` returns ready only when PostgreSQL is reachable.
- [ ] Run smoke tests for registration/login, exchange creation, card expense creation, receipt save, wallet balances, and deletion/edit rollback behavior.
- [ ] Check server logs and confirm no migration, authentication, or database errors.
- [ ] Confirm a fresh encrypted backup after the release and record the restore-test outcome.

## Current known gates

- A successful CI run covers code tests, build, dependency audit, and disposable-PostgreSQL migration verification only.
- The target production database, backup credentials/storage, and a successful production-data restore drill must be verified separately.
- The dashboard loads all of a user's expenses and exchanges to compute full-history totals and weighted rates. Expense create/edit and receipt save also read historical exchange and card-purchase observations to calculate date-specific cost bases. Do not add arbitrary query limits: first move these calculations to date-aware database aggregates, preserve the saved historical RUB valuations, and separately paginate history/export APIs.
