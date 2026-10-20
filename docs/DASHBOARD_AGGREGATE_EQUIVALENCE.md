# Dashboard exchange-summary aggregation — implementation gate

Status: design and test contract only. This document does not change runtime accounting behavior or authorize a deployment.

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
