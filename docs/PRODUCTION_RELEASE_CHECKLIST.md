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

## Latest verification — 2026-10-21 (dashboard aggregate scaling)

- [x] CI run [#1271](https://github.com/PurpleeHead/FlowMoney/actions/runs/39531725700) passed on `e8c5345304307441e5b9b7b7b458ea6fbd4e7116`: standard verification, production build, dependency audits, disposable-PostgreSQL migration verification, aggregate-equivalence checks, rollback checks, and 1k/10k/50k-row-per-user aggregate benchmarks all succeeded.
- [x] The aggregate benchmark compares the exact parameterized dashboard SQL query with a full-history Node reference and checks equivalent totals before timing. It uses five synthetic users in disposable CI PostgreSQL; it does not access production data.
- [x] Recorded median aggregate timings: 1k rows for target user, 3.26 ms SQL vs 8.36 ms full-history Node (2.6×); 10k, 12.74 ms vs 95.60 ms (7.5×); 50k, 35.57 ms vs 547.65 ms (15.4×). At 50k target-user rows, the query plan used `Exchange_userId_createdAt_idx`. These are synthetic query timings, not production HTTP latency.
- [ ] Production release remains blocked by target database identity, encrypted backup and a successful isolated restore drill, legacy wallet reconciliation against a production snapshot, live Render configuration reconciliation, and target-environment smoke tests. CI success does not waive these gates.
- [ ] The benchmark addresses dashboard all-history aggregate work only; date-specific historical cost-basis calculations and exchange-derived rates/budget calculations still require review before claiming the entire dashboard has bounded database work.
- PR #83 remains Draft/unmerged. No production deployment, Render setting change, or production database operation was performed as part of this verification.

## Historical valuation regression coverage — 2026-10-21

- [x] Normalized the receipt route's historical direct-VND exchange mapping to the shared money helpers in commit [`c417e2b`](https://github.com/PurpleeHead/FlowMoney/commit/c417e2b4cbecf49a726f9054268edffd2cca93f0). CI [run](https://github.com/PurpleeHead/FlowMoney/actions/runs/39532332365) passed, including build and disposable-PostgreSQL migration verification.
- [x] Added money-helper regression tests for legacy direct-target currency casing and exclusion of direct VND target exchanges from indirect VND/USDT observations in commit [`726b716`](https://github.com/PurpleeHead/FlowMoney/commit/726b716dc4e5bb3666623a4b13d79b2283bd1b0b). CI [run](https://github.com/PurpleeHead/FlowMoney/actions/runs/39532347600) passed.
- [x] Added receipt API coverage for a legacy direct VND exchange whose `targetCurrency` is stored as ` vNd ` and whose VND outcome exists only in `targetReceived`, commit [`fe2080e`](https://github.com/PurpleeHead/FlowMoney/commit/fe2080ef41f3977be35c2a7f1b08fe634e9f1087). CI [run](https://github.com/PurpleeHead/FlowMoney/actions/runs/39532508866) passed.
- [ ] Added the same legacy-casing regression to the expense PATCH API fixture in commit `8a86924`; CI [run](https://github.com/PurpleeHead/FlowMoney/actions/runs/39532638230) was pending when this checklist entry was written.
- [ ] Expense/receipt valuation still loads date-bounded historical rows before reducing them in application code. A safe SQL aggregate replacement remains open; it must preserve effective-date limits, weighted ratios, direct-target legacy precedence, and the distinction between actual and planning rates.
- [ ] Production database identity, encrypted backup plus isolated restore drill, legacy wallet reconciliation, live Render configuration reconciliation, and target-environment smoke tests remain release blockers. PR #83 remains Draft and unmerged. No production database operation, deployment, or live configuration change was performed.

## Historical valuation regression follow-up — 2026-10-21

- [x] CI run [#1277](https://github.com/PurpleeHead/FlowMoney/actions/runs/39532638230) passed on `8a8692426295b6a9607dd3cbbb99629990820caf`; both `verify` and `verify-migrations` succeeded for the legacy direct-VND PATCH regression.
- [x] CI run [#1278](https://github.com/PurpleeHead/FlowMoney/actions/runs/39532678556) passed on `5a9004e73314c86f19f071e30c79d3bebf04805f`; both `verify` and `verify-migrations` succeeded, including PostgreSQL aggregate-equivalence, 1k/10k/50k dashboard aggregate benchmarks, transaction rollback checks, and legacy wallet preflight fixture.
- [x] Added a card-expense API regression test ensuring a direct RUB→VND observation cannot be used as a substitute for a missing USDT RUB acquisition cost basis. This protects the rule that a recorded USDT debit with unknown RUB cost must remain unpriced instead of receiving an unrelated confirmed valuation.
- [ ] The new card-expense regression test requires its own CI run before it can be considered verified.
- [ ] Date-aware PostgreSQL aggregate helpers are used by expense create/edit and receipt-save routes. The disposable PostgreSQL fixture compares weighted aggregates and derived rates with legacy mapping; retain exact-head CI verification and production-like performance evidence as separate gates.

- [ ] Added a receipt API assertion that historical exchange and card-purchase queries remain scoped to the authenticated user and bounded by the receipt valuation time. Commit `848ab2e`; awaiting CI.

## Historical valuation follow-up — 2026-10-21 (latest CI reconciliation)

- [x] CI run [#1281](https://github.com/PurpleeHead/FlowMoney/actions/runs/39532974731) passed for receipt valuation query assertions: historical Exchange and card-purchase reads are scoped to the user and bounded by the receipt valuation timestamp.
- [x] Corrected expense test syntax in commit `2568de4`; CI [#1285](https://github.com/PurpleeHead/FlowMoney/actions/runs/39533375920) passed. The intermediate commit `960d6a0` failed parsing and is superseded by the passing correction.
- [x] Added direct RUB→USDT target normalization coverage, including trimmed/case-insensitive currency and exclusion of stale USDT fields on direct-VND legacy rows, in commit `e089aaf`; CI [#1286](https://github.com/PurpleeHead/FlowMoney/actions/runs/39533392231) passed.
- [x] CI #1286 confirms repository verification and disposable-PostgreSQL migration checks for the direct-USDT normalization regression. It does not verify production data or deployment readiness.
- [ ] Expense create/edit and receipt-save routes now use the date-aware PostgreSQL aggregate helper. Preserve per-operation date cutoffs, weighted numerator/denominator totals, and direct-target legacy precedence in any future changes; exact-head CI evidence is tracked below.
- [ ] Production database identity, encrypted backup and isolated restore, legacy wallet reconciliation, approved Render configuration reconciliation, and target-environment smoke tests remain release blockers. PR #83 remains Draft/unmerged; no production database access, deployment, or live configuration changes were performed.


## Money arithmetic hardening — 2026-10-21

- [x] CI runs [#1290](https://github.com/PurpleeHead/FlowMoney/actions/runs/39533707782) and [#1291](https://github.com/PurpleeHead/FlowMoney/actions/runs/39533714928) passed. Weighted RUB/USDT, VND/USDT, and VND/RUB rate helpers now reject overflowed aggregate totals/results instead of returning Infinity.
- [ ] Added a follow-up guard so expense valuation helpers return `null` if otherwise valid finite inputs overflow during multiplication/division. Regression coverage includes USDT expenses, card debits, VND estimates, and direct VND/RUB valuation; CI for this follow-up is pending.
- [ ] Normalized whitespace-padded VND target currency before equivalent conversion, so values like ` vNd ` use the base-currency rate of 1 rather than requiring a supplied conversion rate. Regression coverage and CI are pending.
- [ ] These changes are money-calculation hardening only. Historical expense/receipt date-aware SQL aggregation and all operational production release gates remain open. No production DB operation, deployment, or live Render configuration change was performed.


## Follow-up numeric boundary verification — 2026-10-21

- [x] CI #1292–#1296 passed on the money valuation overflow guards and VND target normalization, including both `verify` and `verify-migrations`: [#1292](https://github.com/PurpleeHead/FlowMoney/actions/runs/39534159470), [#1293](https://github.com/PurpleeHead/FlowMoney/actions/runs/39534168132), [#1294](https://github.com/PurpleeHead/FlowMoney/actions/runs/39534182186), [#1295](https://github.com/PurpleeHead/FlowMoney/actions/runs/39534189347), [#1296](https://github.com/PurpleeHead/FlowMoney/actions/runs/39534208819).
- [ ] Additional regression coverage now checks invalid direct VND/RUB observations, overflow in card-derived weighted totals, and underflow of a derived VND/USDT rate. CI for these newest commits is pending.
- [ ] Date-aware SQL aggregate helpers and a PostgreSQL fixture are present, but expense/receipt route callers still need to adopt them. Preserve per-operation `createdAt <= expenseDate` / `date <= expenseDate`, user isolation, weighted totals, direct VND legacy fallback, and unknown RUB/USDT basis behavior during route migration.
- [ ] Production DB identity, encrypted backup plus isolated restore, legacy wallet reconciliation, Render configuration approval, and production smoke tests remain blockers. No production database operation, deployment, or live Render configuration change was performed.


## Numeric boundary CI reconciliation — 2026-10-21 (verified)

- [x] CI runs [#1297](https://github.com/PurpleeHead/FlowMoney/actions/runs/39534615332), [#1298](https://github.com/PurpleeHead/FlowMoney/actions/runs/39534627250), [#1299](https://github.com/PurpleeHead/FlowMoney/actions/runs/39534635795), [#1300](https://github.com/PurpleeHead/FlowMoney/actions/runs/39534647299), and [#1301](https://github.com/PurpleeHead/FlowMoney/actions/runs/39534668662) all completed successfully. This confirms invalid direct/card observations, overflow/underflow rate handling, and the follow-up documentation correction on the respective commits.
- [ ] Date-aware PostgreSQL aggregate helpers and a disposable fixture are implemented, but expense create/edit and receipt-save callers still need to adopt them; no claim of route-level SQL equivalence is made.
- [ ] Production DB identity, encrypted backup and isolated restore, legacy wallet reconciliation, Render configuration approval, and production smoke tests remain release blockers. No production database operation, deployment, or live Render configuration change was performed.
## Dashboard non-finite expense total hardening — 2026-10-21

- [x] Replaced Prisma aggregate filters that excluded only PostgreSQL numeric NaN with a single user-scoped SQL aggregate for all-time and current-month VND totals. The SQL excludes NaN, Infinity, and -Infinity before summing.
- [x] Expanded mocked dashboard API regression coverage with positive and negative infinity. The persistent financial columns are precision-constrained numeric types, so PostgreSQL cannot store Infinity in those columns; PostgreSQL fixtures use NaN, while SQL predicates retain defensive Infinity exclusions.
- [ ] CI was not confirmed for the dashboard hardening code commit `637b81777569a8b4a0f83044d34c85c084674164` at the time of this entry. A later date-aware fixture extension is recorded below; do not infer a passing run from an empty status endpoint.
- [x] Expense create/edit and receipt-save routes already call the date-aware helper, with API coverage for effective-date cutoffs, user scoping, and PATCH self-exclusion. [ ] Full route-level end-to-end equivalence against disposable PostgreSQL remains open.
- [ ] Production database identity, encrypted backup plus isolated restore, legacy wallet reconciliation, owner-approved Render configuration, and target-environment smoke tests remain release blockers. No production database operation, deployment, merge, or live Render configuration change was performed.


## Date-aware route adoption reconciliation — 2026-10-21

- [x] Re-inspected the current branch: expense POST and PATCH call `getDateAwareValuationAggregate` with the effective expense date; PATCH excludes the edited expense from card-rate evidence.
- [x] Receipt POST calls the same aggregate using its receipt valuation timestamp before creating the receipt and expenses in one transaction.
- [x] Existing API tests assert a single aggregate query, authenticated-user scoping, effective-date cutoffs, PATCH self-exclusion, and preservation of actual USDT debits. Existing PostgreSQL fixture compares the aggregate numerators/denominators and derived rates against legacy mappers.
- [x] Checked historical aggregate fixture compatibility against the actual `numeric(p,s)` schema and removed unsupported Infinity inserts. The PostgreSQL fixture separately verifies that the finite-safe predicate excludes NaN and both Infinity signs on unconstrained `numeric`, then checks persisted NaN, cutoff boundaries, user isolation, and weighted-total equivalence.
- [ ] The latest fixture and predicate-test changes (code commit `9f5b61b249f47c1369a2f5c60a77e90d9458b591`) still need a confirmed CI run; repository write success is not test evidence.
- [ ] Production release blockers remain unchanged: target database identity, encrypted backup and isolated restore, legacy wallet reconciliation, owner-approved Render configuration, and target-environment smoke tests. No production database operation, deployment, merge, or live Render configuration change was performed.

## PostgreSQL numeric fixture correction — 2026-10-21

- [x] Removed unsupported `Infinity` inserts from precision-constrained `Expense` columns in the date-aware aggregate fixture; expected same-user cutoff row count is now eight.
- [x] Kept coverage for `NaN`, `Infinity`, and `-Infinity` using an unconstrained PostgreSQL `numeric` expression, and retained persisted `NaN` cases for actual schema aggregate equivalence.
- [ ] CI for fixture correction commit `e85a6faa10e1b870f2c9b5f061973a3a263ba46e` and the follow-up documentation commits is not yet confirmed; no green result is inferred from empty status endpoints.
- [ ] PR #83 remains Draft and unmerged. Production database identity, encrypted backup and isolated restore, wallet reconciliation, approved Render configuration, and production smoke tests remain blockers.

## Dashboard aggregate result alignment — 2026-10-21

- [x] Fixed a result-order mismatch in `server/src/routes/dashboard.ts`: all-time and current-month expense totals are returned by one raw SQL query, so the `Promise.all` destructuring now expects one expense-total result followed by card-purchase and exchange aggregates. The previous six-variable destructuring could leave `exchangeAggregates` undefined and misassign subsequent results.
- [x] Existing Dashboard API tests cover all-time/month totals, weighted card rates, balance values, and non-finite expense inputs; they should fail if the route cannot resolve the aggregate outputs.
- [ ] CI verification for the fix commit `43bc4a4c8253f33266a766cf63ceb730010f974d` and the latest fixture/docs commits is not yet confirmed through the available status endpoint.
- [ ] No production deployment or database operation was performed. PR #83 remains Draft/unmerged and production operational gates remain open.


## Dashboard aggregate regression CI reconciliation — 2026-10-21

- [x] CI run [#1523](https://github.com/PurpleeHead/FlowMoney/actions/runs/39594824374) passed on code commit `19c62ba8f33edf225df764048b8711b0a2941cc0`: all 262 server tests passed, TypeScript production build passed, and disposable-PostgreSQL migration/equivalence, transaction rollback, wallet reconciliation, and 1k/10k/50k dashboard aggregate benchmark steps passed.
- [x] Corrected dashboard API test expectations to match the SQL-aggregate architecture instead of the retired pair of Prisma aggregate calls; parameterized SQL assertions now check Prisma's actual placeholder format and authenticated user value.
- [x] Made the dashboard exchange aggregate test double wait on the same bounded recent-activity fixture, avoiding a race between parallel `Promise.all` calls. Corrected the weighted-rate fixture to explicitly model indirect `RUB_USDT_VND` records instead of inheriting the direct-target mode from a generic fixture.
- [x] These were test-harness corrections; no production code changes were needed after the aggregate result-alignment fix. The prior red runs are superseded by the passing run above.
- [ ] Production database identity, encrypted backup plus isolated restore drill, legacy wallet reconciliation against a production snapshot, approved Render configuration reconciliation, and target-environment smoke tests remain release blockers. PR #83 remains Draft/unmerged. No production database operation, deployment, or live Render configuration change was performed.


## Historical valuation benchmark and CI reconciliation — 2026-10-21

- [x] CI run [#1531](https://github.com/PurpleeHead/FlowMoney/actions/runs/39595652881) passed on `4c325f6943dd2c586bae2b3808803857604691df`: server test/build job and disposable-PostgreSQL verification/benchmark job both succeeded.
- [x] Corrected the historical aggregate query-template syntax after the first benchmark-enabled run exposed a parse error. Re-ran CI; SQL equivalence, date cutoff, user isolation, and migration/transaction checks pass.
- [x] Added guarded, disposable-database-only date-aware aggregate benchmarks at 1k, 10k, and 50k exchange/expense rows per user, including `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` and SQL-vs-TypeScript equivalence assertions.
- [x] Recorded benchmark results in `docs/DASHBOARD_AGGREGATE_EQUIVALENCE.md`: at 50k rows/table, SQL aggregate median 121.33 ms vs fetch-and-aggregate in TypeScript 652.59 ms in CI's disposable PostgreSQL environment. This is directional microbenchmark evidence, not a production latency guarantee.
- [x] Synthetic end-to-end dashboard HTTP payload/latency benchmark is now recorded below; production-like database distribution, target-host measurements, and telemetry remain open.
- [ ] Production release blockers remain: verify target database identity, encrypted backup and isolated restore drill, reconcile legacy wallet balances against an approved production snapshot, confirm owner-approved Render configuration, and complete target-environment smoke tests. PR #83 remains Draft/unmerged; no production database or live deployment operation was performed.


## Dashboard HTTP response benchmark — 2026-10-21

- [x] CI run [#1545](https://github.com/PurpleeHead/FlowMoney/actions/runs/39599000187) passed on `44c9a1c16d684ad687dfcae96fa9b58e9681384f`. The guarded benchmark starts the actual Express `GET /api/dashboard` route on localhost, authenticates as the disposable fixture user, and measures seven rounds after two warm-ups at 1k, 10k, and 50k exchanges per user.
- [x] Results from disposable PostgreSQL 16:

  | Exchanges for target user | Current HTTP response | Full-history activity projection | Reduction | HTTP median / max of 7 |
  |---:|---:|---:|---:|---:|
  | 1,000 | 34,606 bytes | 341,484 bytes | 89.87% | 11.22 ms / 13.16 ms |
  | 10,000 | 34,593 bytes | 3,418,353 bytes | 98.99% | 31.86 ms / 36.30 ms |
  | 50,000 | 34,596 bytes | 17,090,184 bytes | 99.80% | 100.39 ms / 104.42 ms |

- [x] The full-history projection changes only the `exchanges` array, replacing the bounded 100 records with all selected exchange rows while retaining the measured response's other fields. It compares payload size, not legacy endpoint latency. Seven-sample maximum is not a statistically stable p95.
- [ ] These are synthetic same-host CI results. They do not close production database identity, encrypted backup/restore, legacy wallet reconciliation, approved Render configuration, target-host smoke tests, or representative production-like latency/telemetry gates.

## Bounded dashboard activity payload benchmark — 2026-10-21

- [x] CI run [#1538](https://github.com/PurpleeHead/FlowMoney/actions/runs/39596366505) passed on `496598e6bcdd79823529fb56e9f59c79ec809deb`: server tests/build and all disposable-PostgreSQL equivalence, date-aware aggregate, dashboard aggregate, rollback, and wallet reconciliation checks succeeded.
- [x] Extended the guarded dashboard benchmark to run `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` for the actual latest-100 activity query and measure serialized exchange-segment payload sizes against a full-history baseline using the same response field conversion.
- [x] Synthetic fixture results: at 1k exchanges, latest-100 payload was 34,198 bytes vs 341,076 bytes (89.97% smaller), and query median 3.54 ms vs 18.22 ms; at 10k, 34,198 vs 3,417,958 bytes (99.00% smaller), and 6.86 ms vs 203.48 ms; at 50k, 34,198 vs 17,089,786 bytes (99.80% smaller), and 8.14 ms vs 960.06 ms.
- [x] Exchange-segment payload and query timing were measured in disposable CI; see the separate Dashboard HTTP response benchmark section above for the real route's response size and latency.
- [ ] Realistic production data distribution and target-host measurements remain open.
- [ ] Production release gates remain open: target database identity, encrypted backup and isolated restore drill, legacy wallet reconciliation against approved production snapshot, owner-approved Render configuration, and target-environment smoke tests. PR #83 remains Draft/unmerged; no production DB operation or live deployment was performed.

## Checklist consistency pass — 2026-10-21

- [x] Reconciled earlier checklist entries that incorrectly described expense/receipt route adoption as pending; current route code imports and calls `getDateAwareValuationAggregate` for expense create/edit and receipt save.
- [x] Kept production release gates explicitly open: production DB identity, encrypted backup plus isolated restore, legacy wallet reconciliation, owner-approved Render configuration, and target-environment smoke tests.
- [ ] Latest exact-head CI for the most recent fixture/docs changes must be confirmed before marking the branch release-ready. Earlier passing runs are recorded by exact commit in the sections above and do not automatically validate later commits.
- [ ] PR #83 remains Draft/unmerged; no production deployment or live database operation was performed.
