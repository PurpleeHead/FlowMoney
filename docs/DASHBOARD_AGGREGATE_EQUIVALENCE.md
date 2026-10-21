# Dashboard exchange-summary aggregation — implementation gate

Status: Runtime aggregate split and PostgreSQL equivalence fixture are implemented. `GET /api/dashboard` computes all-history financial summaries through user-scoped PostgreSQL aggregates and limits recent exchange activity to 100 rows; `server/prisma/tests/verify-dashboard-aggregate-equivalence.ts` checks weighted rates, actual-vs-planned VND, direct-VND legacy fallback, card-purchase rates, and cross-user exclusion. CI runs the fixture after migrations. These repository checks do not authorize a production deployment.

## Why the dashboard originally had an unbounded exchange query

The original implementation fetched all exchange rows because the same rows fed both recent-activity UI and all-history financial calculations. That coupling has been removed: the runtime now reads only the latest 100 exchanges for activity, while user-scoped PostgreSQL aggregates independently calculate all-history accounting and weighted rates. The expenses chart is bounded to the last 12 calendar months, and all-time expense totals/card-purchase rates use PostgreSQL aggregates. A simple `take` or date window on the accounting source would still silently change balances and weighted rates for long-lived accounts.

## Implemented split of query responsibilities

The dashboard response uses two independent data paths:

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

## Rollout and remaining gates

- [x] Add a disposable PostgreSQL fixture and compare aggregate results against the TypeScript reference path.
- [x] Move all-history financial summaries into user-scoped SQL aggregates while keeping recent activity separate.
- [x] Bound dashboard exchange activity to the latest 100 rows with deterministic timestamp/ID ordering.
- [x] Run CI, migration verification, rollback/idempotency checks, and aggregate benchmarks on disposable PostgreSQL.
- [ ] Record `EXPLAIN (ANALYZE, BUFFERS)`, historical expense/receipt valuation query timings, and response payload-size comparisons before claiming a performance improvement for the whole application.
- [ ] Keep PR #83 Draft until the operational gates in `PRODUCTION_RELEASE_RUNBOOK.md` are independently satisfied. No production DB inspection, migration, merge, or deploy is implied by this document.


## Date-aware valuation aggregate benchmark — 2026-10-21

- [x] Added `server/prisma/tests/benchmark-date-aware-valuation-aggregates.ts` and wired 1k/10k/50k rows-per-user runs into disposable PostgreSQL CI. Each run first checks SQL bucket sums against the legacy TypeScript mapper path, then records `EXPLAIN (ANALYZE, BUFFERS)` and compares query time with fetching and aggregating the same user's full history in Node.
- [x] CI run [#1314](https://github.com/PurpleeHead/FlowMoney/actions/runs/39595538617) passed on `47f184bd7be6761f66200ad8ab42745b2a51054d`, including the date-aware fixture, all three benchmarks, the existing dashboard aggregate benchmarks, rollback tests, and wallet reconciliation checks.
- [x] Synthetic disposable-PostgreSQL medians (5 measured rounds after warm-up): 1k rows/user per table — SQL 5.07 ms vs Node full-history 12.28 ms; 10k — 36.36 ms vs 131.51 ms; 50k — 120.23 ms vs 687.55 ms. At 50k this is about 5.7× lower median time for the aggregate query. These are same-host microbenchmarks, not production HTTP latency or a service-level guarantee.
- [x] The query plans used `Exchange_userId_createdAt_idx` and `Expense_userId_date_idx` at the small and large fixture sizes. PostgreSQL selected a sequential Expense scan at the medium synthetic size; the available plans do not justify adding a redundant index without production-like evidence.
- [ ] End-to-end expense/receipt request timings and before/after serialized response payload sizes remain unmeasured. Do not claim a whole-application performance gain from aggregate microbenchmarks alone.
- [ ] Production database identity, encrypted backup/restore, legacy wallet reconciliation, approved Render configuration, and target-environment smoke tests remain release blockers. No production database operation, deployment, merge, or live Render configuration change was performed.

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
- All-time and current-month expense totals now use one user-scoped PostgreSQL aggregate that excludes `NaN`, `Infinity`, and `-Infinity` before `SUM`. The mocked API regression covers positive and negative infinite expense amounts and asserts the SQL predicate. The persisted financial columns use precision-constrained `numeric(p,s)`, so the disposable PostgreSQL fixture verifies all three special values on unconstrained `numeric` and uses persisted `NaN` rows for schema-realistic aggregate equivalence.
- The Dashboard weighted card-purchase aggregate is now restricted to VND-denominated expenses (case-insensitive), preventing stale `amountVnd`/`usdtCharged` fields on RUB or other-currency expenses from contaminating observed VND/USDT and VND/RUB rates. The API test fixture includes such a malformed legacy RUB expense.
- A dedicated PostgreSQL integration fixture also verifies trimming/case normalization (`' vNd '`), excludes stale RUB conversion fields, and rejects rows with non-finite VND or USDT amounts from the weighted card aggregate.
- Weighted exchange observations now require a finite positive RUB cost basis and positive USDT/VND amounts, matching `mapActualVndUsdtExchanges` and the existing `money.ts` validity rules. Planning estimates require a positive RUB basis, USDT amount, and planning rate; an invalid cost-basis row cannot make the VND balance unknown or distort the effective rate.
- The aggregate separately reports an unknown acquired amount versus a known USDT amount awaiting VND valuation. A malformed/missing USDT receipt cannot silently produce a zero VND balance; the Dashboard now returns an unknown balance when the quantity itself cannot be established.


## Historical valuation query benchmark — 2026-10-21

CI run [#1312](https://github.com/PurpleeHead/FlowMoney/actions/runs/39595652881) passed on `4c325f6943dd2c586bae2b3808803857604691df`. The new benchmark runs `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` on the exact date-aware aggregate query, verifies SQL results against the existing TypeScript mapping path, and measures five warmed rounds after two warm-up rounds on disposable PostgreSQL.

| Rows per table for the measured user | PostgreSQL aggregate median / p95 | Fetch + TypeScript aggregation median / p95 | PostgreSQL execution time from EXPLAIN |
| ---: | ---: | ---: | ---: |
| 1,000 | 4.78 ms / 6.49 ms | 14.40 ms / 16.46 ms | 3.72 ms |
| 10,000 | 38.98 ms / 45.47 ms | 128.42 ms / 133.02 ms | 36.09 ms |
| 50,000 | 121.33 ms / 129.92 ms | 652.59 ms / 704.77 ms | 118.42 ms |

- [x] Historical aggregate query plan and timing evidence recorded for 1k/10k/50k fixtures.
- [x] SQL output matches the established TypeScript reference calculations within the fixture's decimal tolerance at each size.
- [ ] End-to-end dashboard response payload and latency comparison remains outstanding; these microbenchmarks do not prove production latency or hosting-tier performance.
- [ ] Repeat with representative production-like data distribution and target PostgreSQL configuration before making a production capacity claim.
