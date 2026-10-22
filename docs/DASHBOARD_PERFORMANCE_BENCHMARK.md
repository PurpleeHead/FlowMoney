# Dashboard performance benchmark runbook

## Goal

Collect reproducible evidence before changing dashboard indexes or query shape. Correctness tests are not performance evidence. Do not infer a speedup from moving work into SQL alone.

## Safety boundary

- Run only against an explicitly disposable PostgreSQL database created for this benchmark. Never point this procedure at Render, a developer's working database, staging with real user data, or production.
- Confirm `DATABASE_URL` manually before running. The database must be disposable and contain no user data.
- Use a fresh database restored/created from the current reviewed schema and migrations.
- Use synthetic data only. Record PostgreSQL version, CPU/RAM/container limits, Node version, Prisma version, and commit SHA.
- Do not run `EXPLAIN ANALYZE` against production: it executes the query.

## Data-volume matrix

Seed deterministic synthetic data at three scales, preferably with a repeatable seed:

| Profile | Expenses per user | Exchanges per user | Purpose |
|---|---:|---:|---|
| Small | 1,000 | 250 | Sanity / developer baseline |
| Medium | 25,000 | 5,000 | Typical growth profile |
| Large | 100,000 | 25,000 | Stress and scaling trend |

Include at least 10 synthetic users, a mix of expense dates spanning multiple years, mixed exchange modes, null and actual VND outcomes, direct RUB→USDT and RUB→VND targets, planning-only rates, and skewed account sizes. Keep one user's rows isolated from the others.

## Measurements to record

For each profile, run at least five warm repetitions after one unrecorded warm-up. Report median and p95; never report only the fastest run.

1. Dashboard HTTP latency, including response serialization.
2. Response byte size (UTF-8 JSON bytes), expense-row count, exchange-row count, and all-history counts.
3. Query wall time and returned rows for the expense chart window, expense aggregates, exchange activity page, and exchange summary aggregate.
4. `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` for the date-bounded expense query and user-scoped exchange activity query; capture plan, actual rows, shared hit/read blocks, and execution time.
5. Explain plans for the all-history aggregate only on the disposable dataset. Record planning and execution times and buffer counts.
6. Verify the response totals/rates against the PostgreSQL correctness fixture and existing weighted-rate formula: `sum(numerator) / sum(denominator)`.

## Comparisons and acceptance

- Compare the reviewed baseline and candidate on the same database snapshot, hardware limits, seed, and query parameters.
- Keep correctness checks mandatory: chart rows are date-bounded, activity is capped at 100, summary totals and weighted rates cover all eligible history, and every aggregate is user-scoped.
- Report raw observations plus median/p95. Treat small differences within run-to-run noise as inconclusive.
- Do not add indexes until plans show a repeatable bottleneck that the proposed index can address. Existing indexes include `Expense(userId, date)` and `Exchange(userId, createdAt)`; a new index must justify write/storage cost and include before/after plans.
- Do not set a hard CI latency threshold from shared-hosted runner timings. CI should validate correctness; controlled benchmarks should inform performance decisions.

## Current code facts (PR #83 head)

- Dashboard expense chart rows are filtered from the first day of the month eleven months before the current month.
- All-history expense total, current-month total, positive card-purchase totals, and expense count are separate user-scoped aggregates.
- Exchange activity rows are user-scoped and capped at the latest 100; the all-history exchange count and financial summary are separate.
- Exchange-derived summary values use a user-scoped PostgreSQL aggregate, while card purchase weighted rate uses aggregated VND/USDT sums.
- Existing schema indexes support the principal user/date filters. No new index is justified until benchmark plans are captured.

## Current evidence status

As of 2026-10-22, CI and the disposable-PostgreSQL aggregate-equivalence fixture verify behavior, but no representative-volume latency, p95, payload-size, or `EXPLAIN (ANALYZE, BUFFERS)` results have been recorded. Do not claim quantified performance gains until this runbook has been executed and its results attached to the PR.
