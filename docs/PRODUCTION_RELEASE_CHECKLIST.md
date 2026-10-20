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

- **Render configuration mismatch found during the 2026-10-20 audit:** the live `flowmoney-app` service was configured with auto-deploy enabled, branch `review/pr-3-fix`, and health check `/api/health`, while this repository's `render.yaml` specifies auto-deploy off and `/api/ready`. Reconcile the live Dashboard settings with the reviewed release configuration before any production release; verify the target branch and readiness endpoint explicitly. Do not assume editing `render.yaml` has changed an existing service's live settings.
- A successful CI run covers code tests, build, dependency audit, and disposable-PostgreSQL migration verification only.
- The target production database, backup credentials/storage, and a successful production-data restore drill must be verified separately.
- The dashboard loads all of a user's expenses and exchanges to compute full-history totals and weighted rates. Expense create/edit and receipt save also read historical exchange and card-purchase observations to calculate date-specific cost bases. Do not add arbitrary query limits: first move these calculations to date-aware database aggregates, preserve the saved historical RUB valuations, and separately paginate history/export APIs. The implementation sequence and mandatory regression tests are documented in `docs/DASHBOARD_PERFORMANCE_PLAN.md`.
- History pagination is partially implemented in PR #83: `/api/journal` has cursor pagination plus a client load-more control; expense, exchange, and receipt APIs support opt-in cursor pages while preserving legacy array responses. The expense CSV export now follows all cursor pages rather than relying on the dashboard's loaded rows; a 625-record pagination regression test, cursor-loop guards, and spreadsheet formula-injection defenses were added. CI on the current head must pass before release. The client supports cursor-based continuation for expense and exchange history, plus a saved-receipt history panel with item details and original OCR text. Receipt cursor continuation has a route regression test. CI on the current head must pass before release. The exchange editor also allows a direct RUB → USDT top-up to be saved when its VND outcome is still unknown; a PATCH regression test verifies that no VND rate or equivalent is invented. The dashboard endpoint still loads full history, so performance work remains open.
