# Dashboard exchange-summary aggregation — implementation gate

Status: runtime PostgreSQL aggregates and bounded recent exchange rows are implemented on PR #83. `server/prisma/tests/verify-dashboard-aggregate-equivalence.ts` seeds disposable PostgreSQL and checks user-scoped reads, weighted RUB/USDT, actual-vs-planned VND observations, direct-VND legacy fallback behavior, confirmed/estimated/planned balance buckets, weighted card-purchase rates, and cross-user exclusion. The CI workflow runs this fixture after migrations. Production release remains blocked by operational gates; this document does not authorize a deployment.

## Current query responsibilities

- Exchange accounting summaries are computed from a user-scoped PostgreSQL aggregate across the full exchange history.
- The dashboard's exchange activity list is limited to the latest 100 records; complete history is loaded through cursor-paginated exchange/journal endpoints. Summary totals and rates must never be derived from this bounded list.
- Expense rows returned for dashboard charts/category insights are limited to the last 12 calendar months, while all-time totals, current-month totals, and card-purchase weighted-rate inputs use database aggregates. The 12-month expense window can still be large for high-volume accounts and remains part of the payload/query-plan measurement gate.
- Dashboard expense rows preserve stored `amountRub` snapshots; reads must not revalue historical expenses using current rates.

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

## Remaining implementation/performance gates

1. Keep the disposable-PostgreSQL equivalence fixture authoritative for mixed exchange modes, estimates, planning rates, and cross-user isolation.
2. Extend boundary coverage for timezone/local-month chart behavior and the effective timestamp of expense purchase observations.
3. Capture `EXPLAIN (ANALYZE, BUFFERS)`, timings, row counts, and serialized response sizes on representative small/medium/large histories. Do not claim measured speedups before this evidence exists.
4. Review the 12-calendar-month expense-row query for high-volume users; any response contract change must provide equivalent chart/category data rather than silently truncating history.
5. Keep PR #83 Draft until both code review/performance gates and the operational gates in `PRODUCTION_RELEASE_RUNBOOK.md` are independently satisfied. No production DB inspection, migration, merge, or deploy is implied by this plan.


## Fixture implementation update — 2026-10-20

- [x] Disposable PostgreSQL fixture is wired into `.github/workflows/ci.yml` immediately after migration deployment.
- [x] The fixture seeds two users and mixed exchange/expense histories, including a direct RUB→USDT acquisition, a direct RUB→VND record, a direct VND target with conflicting legacy `vndReceived`, a non-VND target estimate, a planning-only exchange, card purchases, unpriced expense data, and a second user's rows.
- [x] CI run [#1223](https://github.com/PurpleeHead/FlowMoney/actions/runs/39429935414) passed on `6daa9115a8166ee446fa2de3aee334656c3ab8e7`; its disposable-PostgreSQL fixture, migration/rollback/idempotency checks, test suite, production build, and dependency audits passed. Security workflow [#208](https://github.com/PurpleeHead/FlowMoney/actions/runs/39429935408) also passed.
- [ ] This is the first equivalence slice, not the complete release gate. Extend database-side aggregate comparisons to canonical direct-target VND totals, confirmed/estimated budget components, and planning-rate aggregates before changing `dashboard.ts` summary calculations or bounding its exchange query.
- [ ] Capture realistic `EXPLAIN (ANALYZE, BUFFERS)`, query timings, and response payload sizes before claiming a performance improvement.


## Regression follow-up — 2026-10-22 (actual VND outcome vs stale estimate)

- [x] Runtime budget aggregation now includes a non-VND target's stored VND estimate only while `vndReceived IS NULL` and the estimate is positive. An actual VND outcome wins over a stale estimate and is not counted twice.
- [x] The `hasUnpricedUsdtTopUps` flag now excludes direct RUB→USDT targets that already have an actual `vndReceived` outcome; otherwise the API could incorrectly return an unknown (`null`) balance despite a recorded VND result.
- [x] `balanceIsEstimated` no longer labels an actual VND outcome as estimated solely because a stale target estimate remains on the record.
- [x] Added route-level regressions for both stale positive estimates and absent estimates when actual VND has been recorded; extended the disposable PostgreSQL fixture to assert actual/estimated buckets remain disjoint.
- [ ] New code commit `200f27ad28fdf59cd45417dbafb2bf8bc28ed34c` awaits CI and Security confirmation. Performance evidence and operational production gates remain outstanding.
