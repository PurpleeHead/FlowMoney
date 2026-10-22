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


## Latest PR #83 verification — 2026-10-20 (planning-rate regression)

- [x] CI workflow run [#1111](https://github.com/PurpleeHead/FlowMoney/actions/runs/39412100339) passed on `08351e9b15135fd5436d508c8f01a2acebe715af`; both `verify` and `verify-migrations` succeeded.
- [x] Security dependency workflow run [#152](https://github.com/PurpleeHead/FlowMoney/actions/runs/39412100300) passed on the same commit.
- [x] Added dashboard API regression coverage confirming a planning-only VND/USDT rate does not become an observed/effective rate when actual VND outcome is missing; only the estimated balance may use it.
- [ ] PostgreSQL aggregate-equivalence comparison and realistic query/payload measurements remain open.
- [ ] Production DB identity, encrypted backup/restore, live Render configuration reconciliation, and production smoke tests remain release blockers. PR #83 remains Draft; no merge or deployment is authorized by these checks.


## Latest PR #83 verification — 2026-10-20 (legacy direct-target stale-field regression)

- [x] CI workflow run [#1165](https://github.com/PurpleeHead/FlowMoney/actions/runs/39417174682) passed on head `3892e757ad4833579f1e6bd16f86861df389a50b`; both `verify` and `verify-migrations` succeeded.
- [x] Security dependency workflow run [#179](https://github.com/PurpleeHead/FlowMoney/actions/runs/39417174796) passed on the same head.
- [x] Added a dashboard API regression assertion that a legacy direct `RUB_TARGET → VND` record with a stale `usdtReceived` value cannot produce a fictitious effective RUB/USDT rate.
- [ ] PostgreSQL aggregate-equivalence comparison and realistic query/payload measurements remain open.
- [ ] Production DB identity, encrypted backup/restore, live Render configuration reconciliation, legacy wallet preflight, and production smoke tests remain release blockers. PR #83 remains Draft; no merge or deployment is authorized by CI.

## Latest release-candidate check — 2026-10-20

- [x] On PR #83 head `d56fa7d25ef3a5ef524353390f7e342aa1a4ba0e`, CI run [#1181](https://github.com/PurpleeHead/FlowMoney/actions/runs/39421191957) and security/dependency run [#187](https://github.com/PurpleeHead/FlowMoney/actions/runs/39421191964) both passed.
- [x] The latest UI fix prevents the direct-exchange preview from displaying a VND equivalent when the target-currency-to-VND conversion rate is missing, and prevents a VND/RUB preview without a valid rate. The API's direct RUB → USDT flow continues to preserve actual USDT without inventing a VND conversion.
- [ ] These checks are code-level evidence only. The release remains blocked on confirming the intended production database, encrypted backup plus successful restore drill, read-only legacy wallet reconciliation, Render configuration reconciliation, and target-environment smoke tests.
- [ ] The live Render service still reports branch `review/pr-3-fix`, auto-deploy enabled, and `/api/health`; repository configuration specifies auto-deploy off and `/api/ready`. Do not change the live service or deploy until the configuration plan and target database are explicitly approved.
- [ ] PR #83 remains Draft and unmerged. No production deployment, production database access/mutation, or live Render configuration change was performed as part of this check.

## Operational risk re-confirmed — live Render service inspection (2026-10-20)

- [x] Read-only Render inspection reconfirmed service `flowmoney-app` is live on branch `review/pr-3-fix`, with automatic deploys triggered by commits and health check `/api/health`. The most recent recorded live deploy is commit `bb2bb41d801f466049c9c50e7bd2da02e007d235` (2026-10-17).
- [x] The live start command is `npx prisma migrate deploy --schema server/prisma/schema.prisma && npm start`. Therefore a deployment can execute pending migrations at process startup. Combined with automatic deploys enabled, this makes the branch/configuration mismatch a high-priority operational risk until the intended database and migration plan are verified.
- [x] The only Postgres instance returned by the current Render workspace listing is `flowmoney-test-db` / `flowmoney_test_db`, a Free test database with expiry `2026-11-15T09:36:23Z`. This is not evidence that the web service is connected to it, and it must not be assumed to be production.
- [ ] Owner-approved operational action is required to disable live auto-deploy or otherwise prevent unreviewed startup migrations while the database target and release configuration are reconciled. No Render settings were changed during this inspection.
- [ ] Do not run the read-only legacy wallet preflight against any database until the intended target is explicitly identified and access is confirmed; never infer the service's `DATABASE_URL` from the workspace database list.


## Latest verification — 2026-10-20 (operator-controlled runbook)

- [x] Added [`docs/PRODUCTION_RELEASE_RUNBOOK.md`](./PRODUCTION_RELEASE_RUNBOOK.md) on commit `87f481cff80cb14a49835d6502c6f8b9074f7db9`. It specifies hard-stop conditions, secret-safe database identity verification, encrypted backup and isolated restore, read-only legacy wallet preflight, pre-deploy approval gates, and financial smoke tests.
- [x] CI run #1187 and security/dependency run #190 passed on that commit. The workflow results verify repository checks only; they are not production validation.
- [x] A fresh read-only Render inspection reconfirmed `flowmoney-app` is configured on `review/pr-3-fix`, with automatic deploys enabled on commits, `/api/health`, and a startup command that runs `prisma migrate deploy` before `npm start`. Latest recorded live deploy remains `bb2bb41d801f466049c9c50e7bd2da02e007d235` from 2026-10-17.
- [x] The workspace's only listed PostgreSQL instance remains `flowmoney-test-db` / `flowmoney_test_db` (Free plan, expires 2026-11-15). This does not establish which database the live service uses.
- [ ] Production database identity, backup/restore proof, legacy wallet reconciliation, Render configuration approval, PostgreSQL aggregate-equivalence comparison, realistic query/payload measurements, and production smoke tests remain open.
- [ ] PR #83 remains Draft and unmerged. No production database access, deployment, or live Render setting change was performed.


## Latest checklist verification — 2026-10-20

- [x] CI run #1191 passed on checklist update commit `024e78a0fea2e6e47ac51f747b4224e39906aad9`.
- [x] Security/dependency workflow #192 passed on the same commit.
- [x] These are repository-level checks only. No production database, backup/restore, Render configuration change, deploy, or smoke test was performed.
- [ ] Production database identity, encrypted backup and isolated restore drill, legacy wallet reconciliation, Render config approval, PostgreSQL aggregate-equivalence comparison, realistic query/payload measurements, and target-environment smoke tests remain open.
- [ ] PR #83 remains Draft and unmerged. Do not merge or deploy based on CI success alone.


## Latest checklist-only verification — 2026-10-20

- [x] CI workflow run [#1193](https://github.com/PurpleeHead/FlowMoney/actions/runs/39424319112) passed on head `266b3352fa1205aa08ed741850135047454344ba`.
- [x] Security dependency workflow run [#193](https://github.com/PurpleeHead/FlowMoney/actions/runs/39424319156) passed on the same head.
- [x] A fresh read-only Render inspection reconfirmed that `flowmoney-app` is live on `review/pr-3-fix`, auto-deploys on commits, checks `/api/health`, and runs `prisma migrate deploy` at startup. Latest recorded live commit remains `bb2bb41d801f466049c9c50e7bd2da02e007d235` from 2026-10-17.
- [x] The only PostgreSQL resource listed in the Render workspace is `flowmoney-test-db`, which expires 2026-11-15. Its presence does not identify the database configured for the live service.
- [ ] No production database identity/backup/restore proof, legacy-wallet reconciliation, owner-approved Render change, aggregate-equivalence comparison, realistic query measurements, or production smoke test has been completed by these repository checks.
- [ ] PR #83 remains Draft and unmerged. No production database access, deployment, or live configuration change was performed.


## Latest aggregate-gate documentation verification — 2026-10-20

- [x] CI workflow run [#1197](https://github.com/PurpleeHead/FlowMoney/actions/runs/39425529984) passed on commit `ed83d44fdb331ed2dd818df24a242acabf9c8814`.
- [x] Security dependency workflow run [#195](https://github.com/PurpleeHead/FlowMoney/actions/runs/39425529832) passed on the same commit.
- [x] Added `docs/DASHBOARD_AGGREGATE_EQUIVALENCE.md` describing the required mixed-mode PostgreSQL fixture, exact aggregate eligibility rules, user/time isolation assertions, and before/after query-plan and response-size measurements.
- [ ] These checks do not mean the PostgreSQL-backed aggregate equivalence test or realistic performance measurements have been implemented; both remain open.
- [ ] Production DB identity, encrypted backup and isolated restore, legacy wallet reconciliation, approved Render configuration reconciliation, and production smoke tests remain open. PR #83 remains Draft/unmerged; no production DB access, deploy, or live configuration change was performed.


## Dashboard regression test — 2026-10-20

- [x] Added `dashboard.api.test.ts` regression coverage for a direct RUB → VND record with canonical `targetVndEquivalent` and a stale, conflicting legacy `vndReceived` value. Expected confirmed VND and balance count the canonical amount exactly once.
- [x] CI and Security workflows passed on the follow-up commit `16f499dcc826721f883b455940ed7cec3e01b9ee` (CI run [#39427185868](https://github.com/PurpleeHead/FlowMoney/actions/runs/39427185868), Security run [#39427185869](https://github.com/PurpleeHead/FlowMoney/actions/runs/39427185869)).
- [ ] This is mocked route-level regression coverage, not the outstanding PostgreSQL-backed aggregate-equivalence fixture or performance evidence.
- [x] The latest documentation-only commit `868cbe6d6d2ae16ca315786053bc753cf3921428` also passed CI [#39427595583](https://github.com/PurpleeHead/FlowMoney/actions/runs/39427595583) and Security [#39427595610](https://github.com/PurpleeHead/FlowMoney/actions/runs/39427595610).


- [x] Extended the canonical direct-VND regression assertion to verify the observed VND/RUB rate remains `250` (1,000,000 VND / 4,000 RUB) even when stale legacy `vndReceived` is 9,999,999.
- [x] Follow-up TypeScript annotation fix is included in `16f499dcc826721f883b455940ed7cec3e01b9ee`; both CI and Security are green on that commit. The intermediate commit `905a25fa244c6a204932e9fd1083dd799f190468` failed build because the test response type omitted `effectiveVndPerRub`; the annotation is now corrected.


## Receipt payable-total regression — 2026-10-22

- [x] Receipt OCR total detection now prefers explicit payable labels (for example, `Tổng thanh toán`, `Phải trả`, or `Grand total`) over an earlier generic `Tổng cộng` line. It also excludes common Vietnamese pre-total labels such as `Tạm tính` and `Tổng tiền hàng`, reducing the risk that OCR review compares line items with a subtotal instead of the amount actually charged.
- [x] Added a regression with `Tổng cộng 120.000`, a discount, and `Tổng thanh toán 108.000`; the expected printed total is 108,000 VND.
- [x] CI run [#39710111507](https://github.com/PurpleeHead/FlowMoney/actions/runs/39710111507) passed on commit `95c25d43bb54241e7fb5d596d64ae17216aafd4f`: both `verify` and `verify-migrations` succeeded, including tests and production bundle build.
- [ ] This is parser-level regression evidence only. OCR accuracy/translation quality must still be reviewed with representative real receipts in the target environment; no production receipt data was accessed or changed.
