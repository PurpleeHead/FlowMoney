# Dashboard exchange-summary aggregation — implementation gate

Status: PostgreSQL fixture implemented for the first equivalence slice. `server/prisma/tests/verify-dashboard-aggregate-equivalence.ts` now seeds disposable PostgreSQL and checks user-scoped reads, weighted RUB/USDT, actual-vs-planned VND observations, direct-VND legacy fallback behavior, weighted card-purchase rates, and cross-user exclusion. CI runs it after migrations. This does not change runtime dashboard accounting or authorize a deployment.

## Why the dashboard still has an unbounded exchange query

The dashboard currently fetches all exchange rows because the same rows feed both recent-activity UI and all-history financial calculations. The expenses query is already bounded to the last 12 calendar months, while all-time expense totals and card-purchase weighted rates use PostgreSQL aggregates. Replacing the exchange query with a simple `take` or date window would silently change balances and weighted rates for long-lived accounts.

## Safe split of query responsibilities

Before bounding the dashboard exchange rows, split the response into two independent data paths:

1. **All-history summary aggregates**, scoped by authenticated `userId`, computed in PostgreSQL.
2. **Bounded recent exchange rows** for the dashboard display, with full history served only by the cursor-paginated exchange/journal endpoints.

Do not derive accounting summaries from the bounded activity rows.

## Required aggregate buckets

Implement with explicit predicates that match the existing helpers in `server/src/lib/money.ts`. Prefer separate, named aggregate queries or a reviewed parameterized SQL query over a single opaque expression.

- RUB/USDT cost basis: sum eligible `rubSpent` and `usdtReceived` only for modes accepted by `mapRubUsdtExchanges`; include direct RUB → USDT target records only when their actual received USDT is known.
- Confirmed VND outcomes through USDT: sum `vndReceived` and matching `usdtReceived` only for eligible non-direct-VND modes with actual VND recorded.
- Direct RUB → VND: sum RUB spend and actual VND received for `RUB_VND` records with known outcomes.
- Direct RUB → target VND: count the canonical target VND amount once, preferring `targetVndEquivalent`, then `targetReceived`, then the supported legacy `vndReceived` fallback; never double-count a stale legacy field.
- Estimated non-VND target value: keep it separate from confirmed VND and include only records with an explicit positive stored `targetVndEquivalent`.
- Unpriced USDT top-ups: preserve the existing `null`/unknown-balance behavior if neither actual nor planned VND/USDT rate exists.
- Planned rates: calculate a separate USDT-weighted planning rate only from eligible records with missing actual VND outcomes and a non-null planning rate. Never feed this bucket into factual observed rates.
- Card purchases: retain the current expense aggregates for positive `amountVnd` and positive `usdtCharged`; calculate weighted rate as sum(VND) / sum(USDT), never average row rates.
- User and time scoping: every aggregate must include `userId`; historical cost-basis queries must preserve the effective operation timestamp cutoffs and exclude the edited expense where applicable.

## PostgreSQL-backed equivalence gate

Use a disposable PostgreSQL fixture, not production data. Seed mixed cases covering:

1. Direct RUB → VND exchange.
2. Direct RUB → USDT with no VND outcome.
3. RUB → USDT → VND with actual VND outcome.
4. RUB → target VND using the canonical target field and a stale legacy field.
5. RUB → non-VND target with explicit VND estimate.
6. A planning-only rate with no actual VND outcome.
7. A card purchase with actual USDT debit.
8. A record owned by a second user.
9. Backdated exchange/purchase observations around the expense effective timestamp.
10. Zero/missing outcome fields and decimal amounts.

For the same seeded rows, calculate expected results with the existing TypeScript helper path and compare to aggregate-query results. Assert exact row eligibility and monetary values within the project's established decimal tolerance. Assert the second user's rows never affect the first user's results. Assert a recent-row page limit does not change any all-history summary value.

## Performance evidence gate

On the same disposable PostgreSQL dataset, capture:

- `EXPLAIN (ANALYZE, BUFFERS)` for each new aggregate and bounded recent-activity query;
- row counts and serialized response sizes for the existing and proposed dashboard responses;
- timings for representative small, medium, and large histories;
- confirmation that existing indexes are used where expected, before adding indexes.

Do not claim a performance improvement without recorded before/after evidence. Avoid redundant indexes without a query-plan reason.

## Rollout order

1. Add the fixture and equivalence tests first.
2. Implement summary aggregates while leaving the existing full exchange query in place.
3. Run CI, migration verification, and security workflow.
4. Compare all response summary fields against the old implementation on the fixture.
5. Only then bound the exchange activity query and rerun the full test matrix.
6. Keep PR #83 Draft until the operational gates in `PRODUCTION_RELEASE_RUNBOOK.md` are independently satisfied. No production DB inspection, migration, merge, or deploy is implied by this plan.


## Fixture implementation update — 2026-10-20

- [x] Disposable PostgreSQL fixture is wired into `.github/workflows/ci.yml` immediately after migration deployment.
- [x] The fixture seeds two users and mixed exchange/expense histories, including a direct RUB→USDT acquisition, a direct RUB→VND record, a direct VND target with conflicting legacy `vndReceived`, a non-VND target estimate, a planning-only exchange, card purchases, unpriced expense data, and a second user's rows.
- [x] CI run [#1223](https://github.com/PurpleeHead/FlowMoney/actions/runs/39429935414) passed on `6daa9115a8166ee446fa2de3aee334656c3ab8e7`; its disposable-PostgreSQL fixture, migration/rollback/idempotency checks, test suite, production build, and dependency audits passed. Security workflow [#208](https://github.com/PurpleeHead/FlowMoney/actions/runs/39429935408) also passed.
- [ ] This is the first equivalence slice, not the complete release gate. Extend database-side aggregate comparisons to canonical direct-target VND totals, confirmed/estimated budget components, and planning-rate aggregates before changing `dashboard.ts` summary calculations or bounding its exchange query.
- [ ] Capture realistic `EXPLAIN (ANALYZE, BUFFERS)`, query timings, and response payload sizes before claiming a performance improvement.


## Runtime aggregate rollout — 2026-10-20

- [x] Added `server/src/lib/dashboard-aggregates.ts`, a user-scoped PostgreSQL aggregate query for exchange count, weighted RUB/USDT acquisition totals, actual VND/USDT outcomes, planning-rate numerator/denominator, confirmed VND, non-VND target estimates, USDT awaiting VND valuation, and exchange contribution to observed VND/RUB.
- [x] Expanded the disposable-PostgreSQL fixture to compare these aggregate buckets with existing TypeScript helpers and verify the full confirmed-plus-estimated balance.
- [x] Switched `GET /api/dashboard` financial summary calculations to the aggregate result while keeping the response shape stable.
- [x] Bounded dashboard exchange activity to the latest 100 rows with deterministic `createdAt`/ID ordering. All-history summaries are independent of that activity window; the full exchange history remains available through cursor-paginated endpoints.
- [ ] Final CI verification for the latest bounded-query commit is still required before treating this stage as complete.
- [ ] Performance measurements and `EXPLAIN (ANALYZE, BUFFERS)` evidence are not yet recorded. No performance gain is claimed until those measurements are captured.
- [ ] Production DB, merge, and deployment gates remain unchanged.

## Stale legacy exchange-field audit — 2026-10-21

- Corrected the PostgreSQL summary so `confirmedVnd` only includes canonical direct VND-target records, direct RUB→VND records, and documented RUB→USDT→VND records. A stale `vndReceived` value on a direct USDT/foreign-target row or unknown legacy mode is not a confirmed VND receipt.
- Restricted VND/RUB rate inputs and planning-rate buckets to the documented exchange modes. A legacy `RUB_TARGET` record with target currency RUB is not treated as a foreign-currency valuation.
- Kept a direct USDT acquisition in the unconverted-USDT estimate when `targetVndEquivalent` is missing, even if a stale legacy `vndReceived` field is populated.
- Expanded the PostgreSQL equivalence fixture with stale VND fields on direct USDT and foreign-target rows, unknown-mode rows, an unknown-mode planning-only row, and an invalid legacy RUB target. Updated the Node-side benchmark reference and dashboard API aggregate mock to use the same explicit eligibility rules.
- [ ] CI must pass on the updated work branch before this audit is considered verified. The benchmark remains a disposable-database microbenchmark, not a production latency guarantee.
- Production database access, migrations, merge, and deployment remain outside this work.

## Non-finite numeric hardening — 2026-10-21

- The dashboard exchange aggregate now derives finite-safe numeric values in a user-scoped CTE before calculating sums, weighted rates, and estimates. PostgreSQL `numeric` supports `NaN`, which compares greater than ordinary numbers; relying on `> 0` alone can therefore poison sums and rates.
- Non-finite values are treated as unavailable for that numeric field, not as evidence of an actual receipt. Balance totals may use a finite legacy target amount when the canonical equivalent is malformed, but historical rate observations preserve the `money.ts` nullish-precedence rule: a present-but-invalid canonical VND value invalidates that observation rather than falling back and changing the historical rate.
- The disposable PostgreSQL equivalence fixture now creates malformed numeric values with raw SQL and asserts that every numeric aggregate remains finite, actual outcomes exclude invalid amounts, and valid planning estimates remain separate.
- Dashboard route regression tests now also distinguish finite legacy fallbacks used for balance totals from strict canonical precedence used for historical rates, and verify that a malformed actual VND amount can use a valid planning rate without being mislabeled as an observed outcome.
- The route-test aggregate mock uses finite-safe conversions for balance, planned estimates, unpriced/unknown flags, and target-estimate detection so malformed fixtures cannot make the mock disagree with PostgreSQL semantics.
- The date-aware valuation rate unit tests now inject non-finite SQL aggregate outputs and verify that malformed card/direct observations are ignored without suppressing valid exchange evidence or returning non-finite rates.
- [ ] CI must pass on the updated work branch before this audit is considered verified. Production database and release operations remain untouched.

- The Dashboard API also excludes PostgreSQL numeric `NaN` from all-time/month expense totals and from weighted card-purchase aggregates. Regression coverage verifies that malformed VND or USDT on one row cannot make the returned financial totals/rates `NaN`.
- Weighted exchange observations now require a finite positive RUB cost basis and positive USDT/VND amounts, matching `mapActualVndUsdtExchanges` and the existing `money.ts` validity rules. Planning estimates require a positive RUB basis, USDT amount, and planning rate; an invalid cost-basis row cannot make the VND balance unknown or distort the effective rate.
- The aggregate separately reports an unknown acquired amount versus a known USDT amount awaiting VND valuation. A malformed/missing USDT receipt cannot silently produce a zero VND balance; the Dashboard now returns an unknown balance when the quantity itself cannot be established.
