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

## Verification recorded on 2026-10-20

- [x] CI workflow run [#1076](https://github.com/PurpleeHead/FlowMoney/actions/runs/39408940563) passed on `20ae5eee71ebbea8c113345ca0e4414a42f5eddb`: tests, production builds, dependency audits, and disposable-PostgreSQL migration/rollback/idempotency checks.
- [x] Security dependency workflow run [#135](https://github.com/PurpleeHead/FlowMoney/actions/runs/39408940545) passed on the same head: lockfile remediation checks, exact lockfile install, tests, build, audit, and review artifact upload.
- [x] CI workflow run [#1082](https://github.com/PurpleeHead/FlowMoney/actions/runs/39409162403) passed on `ce8bcfaf30808d05563fd140ad10e3ce19fef05d`: `verify` and `verify-migrations` jobs succeeded, including the stricter aggregate-query assertions.
- [x] Security dependency workflow run [#138](https://github.com/PurpleeHead/FlowMoney/actions/runs/39409162456) passed on `ce8bcfaf30808d05563fd140ad10e3ce19fef05d`: lockfile refresh/audit workflow succeeded.
- [x] Earlier baseline CI #1047 and security run #122 also passed; see [CI #1047](https://github.com/PurpleeHead/FlowMoney/actions/runs/39363113820) and [Security #122](https://github.com/PurpleeHead/FlowMoney/actions/runs/39363113932).
- [ ] These CI results do **not** establish production DB identity, encrypted backup availability, restore success, live Render configuration, or production smoke-test success. Those remain release blockers.

## Current known gates

- **Render configuration mismatch found during the 2026-10-20 audit:** the live `flowmoney-app` service was configured with auto-deploy enabled, branch `review/pr-3-fix`, and health check `/api/health`, while this repository's `render.yaml` specifies auto-deploy off and `/api/ready`. Reconcile the live Dashboard settings with the reviewed release configuration before any production release; verify the target branch and readiness endpoint explicitly. Do not assume editing `render.yaml` has changed an existing service's live settings.
- A successful CI run covers code tests, build, dependency audit, and disposable-PostgreSQL migration verification only.
- The target production database, backup credentials/storage, and a successful production-data restore drill must be verified separately.
- The dashboard now uses user-scoped PostgreSQL aggregates for all-time expense totals and card-purchase weighted rates, and fetches expense rows only for the last 12 calendar months needed by the chart. It still loads all exchanges for exchange-derived rates and budget calculations. Expense create/edit and receipt save also read historical exchange and card-purchase observations to calculate date-specific cost bases. Do not add arbitrary query limits: first move these calculations to date-aware database aggregates, preserve the saved historical RUB valuations, and separately paginate history/export APIs. The implementation sequence and mandatory regression tests are documented in `docs/DASHBOARD_PERFORMANCE_PLAN.md`.
- History pagination is partially implemented in PR #83: `/api/journal` has cursor pagination plus a client load-more control; expense, exchange, and receipt APIs support opt-in cursor pages while preserving legacy array responses. The expense CSV export now follows all cursor pages rather than relying on the dashboard's loaded rows; a 625-record pagination regression test, cursor-loop guards, and spreadsheet formula-injection defenses were added. CI #1082 and Security #138 passed on current head `ce8bcfaf30808d05563fd140ad10e3ce19fef05d`; this does not close the operational gates. The client supports cursor-based continuation for expense and exchange history, plus a saved-receipt history panel with item details and original OCR text. Receipt cursor continuation has a route regression test. CI on the current head must pass before release. The exchange editor also allows a direct RUB → USDT top-up to be saved when its VND outcome is still unknown; a PATCH regression test verifies that no VND rate or equivalent is invented. The dashboard endpoint still loads full history, so performance work remains open.

## Latest PR #83 verification — 2026-10-20

- [x] CI workflow run [#1097](https://github.com/PurpleeHead/FlowMoney/actions/runs/39410914486) passed on head `bcf1cef6f28460dc53f20f87115bb29acf875ef2`, including the standard verification and migration verification jobs.
- [x] Security dependency workflow run [#145](https://github.com/PurpleeHead/FlowMoney/actions/runs/39410914440) passed on the same head.
- [ ] These results do not close the production database identity, encrypted backup/restore, live Render configuration reconciliation, or production smoke-test gates. PR #83 remains Draft; no merge or deployment is authorized by these checks.


## Latest PR #83 verification — 2026-10-20 (combined source observations)

- [x] CI workflow run [#1105](https://github.com/PurpleeHead/FlowMoney/actions/runs/39411632978) passed on `b6f1b13cbc4efcf1fb077bf20be9876054e11a8c`, including `verify` and `verify-migrations`.
- [x] Security dependency workflow run [#149](https://github.com/PurpleeHead/FlowMoney/actions/runs/39411632655) passed on the same head.
- [ ] PostgreSQL aggregate-equivalence comparison and realistic query/payload measurements remain open.
- [ ] Production database identity, encrypted backup/restore, Render configuration reconciliation, and production smoke tests remain release blockers. PR #83 remains Draft; no merge or deployment is authorized by CI.
