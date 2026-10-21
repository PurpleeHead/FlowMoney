# Dashboard performance refactor plan

## Why this needs a deliberate refactor

`GET /api/dashboard` currently loads every expense and exchange into Node.js. The result is used for two different purposes:

1. all-history financial calculations (totals, observed weighted exchange rates, and estimated VND balance);
2. rendering recent expense and exchange rows in the UI.

Expense creation/editing and receipt saving also load historical exchange and card-purchase observations up to the effective operation date. A simple `take` limit would make totals/rates incorrect and could change the RUB cost saved for new expenses.

## Target design

### 1. Keep accounting calculations complete

Move dashboard totals to database aggregates where the aggregate has exactly the same inclusion rules as the current TypeScript implementation:

- total VND expenses and current-month VND expenses, using the same local-month boundary;
- observed card-purchase VND and USDT totals, filtering to positive, non-null observations;
- RUB spent and USDT received for eligible RUB/USDT conversions, including `RUB_TARGET → USDT`;
- actual VND and USDT totals only for exchanges with a recorded actual VND outcome;
- confirmed and estimated VND budget components, keeping planned rates separate from actual outcomes.

Do not replace an observed weighted rate with an average of per-row rates. Preserve the formula `sum(numerator) / sum(denominator)` over the same eligible rows.

### 2. Preserve date-specific historical valuations

Expense create/edit and receipt save must only use exchange/purchase observations available at the operation's effective timestamp. Any aggregate query must retain the existing `createdAt <= expenseDate` and `date <= expenseDate` constraints. Editing must exclude the expense being edited from purchase observations.

Do not recalculate saved `amountRub` values on dashboard reads.

### 3. Separate summaries from history

Return a bounded recent-activity window from the dashboard, and use cursor pagination for full expense/exchange history. Keep the existing list response shape backward-compatible during the transition, or version the API explicitly before changing it. A bounded history window must never feed all-history financial totals.

**Pagination status (PR #83):** `GET /api/journal` now supports a validated cursor and the client exposes a load-more control. The dedicated expense, exchange, and receipt endpoints now support opt-in cursor pages (`?limit=...` and `&cursor=...`) while preserving their legacy array response when pagination parameters are omitted. The expense CSV export now requests `/api/expenses?limit=500` and follows every `nextCursor` until `hasMore` is false, rather than exporting only the dashboard payload. The client uses a tested cursor-page collector with a safety cap and rejects missing/repeated cursors; tests cover a 625-record export. CSV cells are quoted and spreadsheet formula prefixes are neutralized. CI run [#1076](https://github.com/PurpleeHead/FlowMoney/actions/runs/39408940563) and security run [#135](https://github.com/PurpleeHead/FlowMoney/actions/runs/39408940545) passed on head `20ae5eee71ebbea8c113345ca0e4414a42f5eddb`, including server/client tests, production builds, dependency audits, and disposable-PostgreSQL migration/rollback/idempotency checks. This head includes the dashboard aggregate test-isolation cleanup. A further test-only commit `dc30ace47f1f178e40bc6cbf37538ad59a44a6d7` strengthens assertions for aggregate predicates; subsequent CI run [#1082](https://github.com/PurpleeHead/FlowMoney/actions/runs/39409162403) and security run [#138](https://github.com/PurpleeHead/FlowMoney/actions/runs/39409162456) both passed on current head `ce8bcfaf30808d05563fd140ad10e3ce19fef05d`. The client now fetches the first 100 expenses and exchanges separately and exposes cursor-based Load more controls for both lists. A saved-receipt history panel now loads the first 50 receipts, supports cursor continuation, and shows recognized items plus the original OCR text; receipt cursor continuation has a route regression test. The dashboard now uses user-scoped PostgreSQL aggregates for all-time VND spending, current-month VND spending, and weighted card-purchase VND/USDT totals; its expense-row query is limited to the last 12 calendar months required by the chart. This removes full-history expense row transfer while preserving all-time totals and weighted card rates. The dashboard now uses a user-scoped PostgreSQL aggregate for exchange-derived rates and budget calculations, while the activity query is bounded to the latest 100 exchanges. The full exchange list is available through the cursor-paginated endpoint. Measured disposable-PostgreSQL aggregate benchmarks are now recorded below, including 1k/10k/50k rows per target user and the exact SQL plan. These are query microbenchmarks only; end-to-end dashboard HTTP latency/payload and representative production-like load remain unmeasured. Code commits `e7f8eb3`, `0a000a1`, `0058bce`, `3914da6`, `bd2e5e9`, `bacf643`, and `dc30ace` make up the partial aggregate change and regression coverage. Latest verification before this documentation update: CI [#1087](https://github.com/PurpleeHead/FlowMoney/actions/runs/39409892759) and Security [#140](https://github.com/PurpleeHead/FlowMoney/actions/runs/39409892512) both passed on head `55fdd5c0afc6480d88f2875b462461258db380a1`. Earlier aggregate assertions also passed in CI #1082 / Security #138 on `ce8bcfaf30808d05563fd140ad10e3ce19fef05d`. These results verify tests/build/security on that exact head, but do not close production DB/backup/restore or live smoke-test gates. This note-only commit requires its own CI/security run. Cursor queries are scoped to the authenticated user and use deterministic timestamp/ID tie-breakers.

### 4. Add query support only after measuring

Existing indexes on `Expense(userId, date)` and `Exchange(userId, createdAt)` already support the main user/date filters. Capture representative `EXPLAIN (ANALYZE, BUFFERS)` output before adding more indexes; avoid redundant indexes that increase write and storage costs.

## Required regression tests

- Compare aggregate-backed totals and weighted rates against the existing pure TypeScript formulas over a fixture containing mixed exchange modes, missing VND outcomes, direct RUB→USDT top-ups, and actual card purchases.
- Confirm planned VND rates never enter factual observed rates.
- Confirm direct VND exchanges and non-VND target estimates are not double-counted as confirmed VND.
- Confirm current-month totals use the same month boundary and timezone behavior as before.
- Confirm expenses created/edited in the past only use observations available at that timestamp. A route regression test now asserts both exchange `createdAt` and card-purchase `date` cutoffs for a backdated expense; keep this test when moving calculations to aggregates.
- Confirm a history pagination limit does not alter any summary total or weighted rate.
- Confirm user scoping applies to every aggregate and page query.

## Release gates

1. Add tests before changing query behavior (query-window regression coverage was added; PostgreSQL-backed aggregate equivalence has been checked against the TypeScript reference on disposable fixtures, including mixed modes and legacy currency casing).
2. Compare old and new results against the same PostgreSQL fixture.
3. Run unit/API tests, production build, migration CI, and dependency audit.
4. Inspect query plans and payload sizes with realistic history sizes.
5. Keep the refactor in a reviewed PR; do not merge or deploy until every gate passes.


## Follow-up verification — 2026-10-20

On head `f4c2562acab3a81f494b2ea85bdd3e3cb894ef44`, CI run [#1091](https://github.com/PurpleeHead/FlowMoney/actions/runs/39410151728) and dependency/security run [#142](https://github.com/PurpleeHead/FlowMoney/actions/runs/39410151781) passed. The follow-up adds an API regression test for a direct `RUB_TARGET → VND` exchange: its `targetVndEquivalent` is counted as confirmed VND once, does not create an unconverted-VND estimate, and does not mark the resulting balance as estimated. This verifies the direct-target shape where `vndReceived` is null and `targetVndEquivalent` carries the actual VND amount; it does not replace the still-required PostgreSQL aggregate-equivalence comparison or production release gates.

The remaining dashboard performance work is to move exchange-history-derived summary calculations into user-scoped PostgreSQL aggregates without changing eligibility rules for actual versus planned outcomes. Do not implement a row limit as a substitute. Compare aggregate results against the current calculation on mixed-mode fixtures before changing runtime behavior.

## Follow-up verification — 2026-10-20 (latest head)

On PR #83 head `bcf1cef6f28460dc53f20f87115bb29acf875ef2`, CI run [#1097](https://github.com/PurpleeHead/FlowMoney/actions/runs/39410914486) and dependency/security run [#145](https://github.com/PurpleeHead/FlowMoney/actions/runs/39410914440) both passed. The added mixed-mode dashboard regression test combines a direct `RUB_VND` operation and a `RUB_TARGET → VND` operation, then asserts the confirmed VND balance and weighted observed VND/RUB rate count each actual outcome exactly once. This is a regression test only; the required old-vs-PostgreSQL aggregate equivalence fixture, realistic query-plan/payload measurements, and production DB/backup/restore/smoke-test gates remain open.


## Follow-up verification — 2026-10-20 (combined source observations)

On PR #83 head `b6f1b13cbc4efcf1fb077bf20be9876054e11a8c`, CI run [#1105](https://github.com/PurpleeHead/FlowMoney/actions/runs/39411632978) and dependency/security run [#149](https://github.com/PurpleeHead/FlowMoney/actions/runs/39411632655) both passed. The new dashboard API regression scenario combines direct `RUB_VND`, direct `RUB_TARGET → VND`, an exchange with an actual VND outcome, and a card purchase. It asserts the weighted observed VND/RUB rate, confirmed exchange VND, and that card spending reduces the budget balance without being counted as exchange proceeds. This closes that specific regression scenario only; PostgreSQL aggregate equivalence, realistic query-plan/payload measurements, and operational production gates remain open. This documentation update itself requires fresh CI/security checks.


## Follow-up verification — 2026-10-20 (planning-rate regression)

On head `08351e9b15135fd5436d508c8f01a2acebe715af`, CI run [#1111](https://github.com/PurpleeHead/FlowMoney/actions/runs/39412100339) and dependency/security run [#152](https://github.com/PurpleeHead/FlowMoney/actions/runs/39412100300) both passed. The added API regression test verifies that a planning-only VND/USDT rate does not leak into factual `observedVndPerUsdt` or `effectiveVndPerUsdt` when an exchange has no actual VND outcome; it remains available only for the estimated balance. This closes that specific test case, not the required PostgreSQL aggregate-equivalence comparison. Realistic query-plan/payload measurements and production DB/backup/restore/Render/smoke-test gates remain open.


## Runtime aggregate rollout — 2026-10-20

The dashboard now uses a user-scoped PostgreSQL aggregate query for exchange-derived financial summaries and caps its exchange activity payload at 100 recent records. The dedicated paginated exchange endpoint remains the source for full history. The new PostgreSQL fixture compares SQL buckets with the existing TypeScript formulas, including actual/planned rates, direct VND legacy precedence, estimates, and the resulting budget balance.

This is a correctness-oriented implementation step, not yet a performance claim. Capture query plans, response payload sizes, and timings across small/medium/large disposable histories before claiming a speedup or adding indexes. Verify the latest CI after the bounded activity change. No production data, merge, or deployment was touched.


## Follow-up verification — 2026-10-20

The PostgreSQL aggregate implementation now also normalizes legacy `targetCurrency` casing/whitespace in SQL predicates, matching the currency normalization used by the shared money helpers. A dedicated fixture includes `" usdt "` and asserts the RUB/USDT weighted acquisition totals include it. CI run [39436007312](https://github.com/PurpleeHead/FlowMoney/actions/runs/39436007312) passed on `15621183488c6599276ffb3af297015e1e4815ec`, including the disposable-PostgreSQL aggregate-equivalence job and production build/tests.

Still open: benchmark old row-loading calculations against the aggregate implementation over realistic disposable histories; capture `EXPLAIN (ANALYZE, BUFFERS)`; confirm response-size/latency improvements; and close the independent production database, backup/restore, legacy reconciliation, and smoke-test gates.


## Reproducible disposable-DB microbenchmark

A guarded benchmark is available at `server/prisma/tests/benchmark-dashboard-aggregates.ts`. It creates a temporary user and synthetic exchange rows, checks representative SQL aggregate values against a Node-side full-history reference, warms up both paths, and reports median/p95 timings for seven measured rounds. It refuses to write unless all safeguards pass:

- `FLOWMONEY_BENCHMARK_DATABASE=disposable` is explicitly set;
- `DATABASE_URL` points to localhost/127.0.0.1 and a database name containing `test`, `bench`, or `disposable`;
- schema migrations have already been applied to that disposable database.

Example from the repository root (replace the credentials only with local disposable PostgreSQL credentials):

```bash
FLOWMONEY_BENCHMARK_DATABASE=disposable \
DASHBOARD_BENCHMARK_ROWS=10000 \
DATABASE_URL='postgresql://postgres:postgres@localhost:5432/flowmoney_test?schema=public' \
npx tsx server/prisma/tests/benchmark-dashboard-aggregates.ts
```

Use the same machine, PostgreSQL instance, row count, and warm-up policy for comparisons. Record the JSON output with the commit SHA and database version. The benchmark deliberately does not run against Render or any non-local database. It is a microbenchmark of exchange aggregation/fetch cost, not a substitute for end-to-end HTTP latency measurements or production telemetry.


## First benchmark result — CI disposable PostgreSQL

Commit `495a12429e74aa2ea1bc2358bdab6761373e8f75`, workflow run [39437597709](https://github.com/PurpleeHead/FlowMoney/actions/runs/39437597709) completed successfully on 2026-10-20. The benchmark seeded 10,000 exchange rows for one temporary test user in the CI PostgreSQL 16 service, verified selected SQL aggregate values against the Node-side reference, ran two warm-up rounds and then seven measured rounds.

| Path | Median | Highest of 7 measured rounds (reported as p95) |
|---|---:|---:|
| PostgreSQL aggregate query | 15.01 ms | 17.09 ms |
| Fetch full history + aggregate in Node | 100.71 ms | 104.62 ms |

In this CI environment, the aggregate path was about **6.7× faster by median** and reduced the measured operation by about **85%**. This is a directional microbenchmark: it includes one database round trip per path and Node-side transfer/aggregation work, but does not measure the full HTTP endpoint, production database contention, network conditions, or realistic multi-user load. The p95 label is only the maximum of seven samples and should not be interpreted as a statistically stable latency percentile.

The CI workflow and disposable benchmark passed. Still required before any production performance claim: capture `EXPLAIN (ANALYZE, BUFFERS)` against a representative disposable history, compare end-to-end `GET /api/dashboard` response latency/payload size, and repeat locally with documented hardware/database details. Do not add indexes or claim production p95 from this benchmark alone.


## Repeat benchmark and representative EXPLAIN — CI disposable PostgreSQL

Workflow [39438237855](https://github.com/PurpleeHead/FlowMoney/actions/runs/39438237855) passed on 2026-10-20 at commit `72cba02d675f39db71d8e47a18a17f5cdac12e5a`. With planner statistics refreshed after inserting 10,000 rows, a second seven-round run reported:

| Path | Median | Highest of 7 measured rounds (reported as p95) |
|---|---:|---:|
| PostgreSQL aggregate query | 21.65 ms | 23.99 ms |
| Fetch full history + aggregate in Node | 128.81 ms | 134.59 ms |

That run measured approximately **5.9× faster by median** for the SQL aggregate path. Absolute timings differed from the first run, reinforcing that these are CI microbenchmark numbers rather than stable service latency SLOs.

The benchmark also records `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` for a representative user-scoped `COUNT`/sum query. After `ANALYZE`, PostgreSQL estimated and scanned 10,000 rows with a sequential scan, reported about 1.53 ms for the scan and 2.60 ms for the aggregate node, 179 shared buffer hits and zero shared reads. Because every row in this disposable table belonged to the one benchmark user, a sequential scan is reasonable; this is not evidence that a multi-user production query should avoid the existing `Exchange(userId, createdAt)` index.

**Still open:** obtain `EXPLAIN (ANALYZE, BUFFERS)` for the complete multi-bucket aggregate statement on a representative multi-user disposable fixture; measure end-to-end dashboard HTTP latency and response size; and repeat at multiple history sizes. Do not add indexes or claim production latency improvement based solely on this access-path sample.


## Exact dashboard aggregate SQL plan — CI disposable PostgreSQL

Workflow [39438766807](https://github.com/PurpleeHead/FlowMoney/actions/runs/39438766807) passed on 2026-10-20 at commit `26220c8dc2e1e83d32d676adf758d51b9efbccf3`. The benchmark now calls `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` on the **same parameterized SQL fragment used by `getDashboardExchangeAggregates`**, rather than a simplified representative query.

With 10,000 synthetic rows for the temporary user, the complete aggregate statement reported:

- Aggregate node execution: **20.304 ms**.
- **179 shared buffer hits**, zero shared buffer reads, and zero temp blocks.
- PostgreSQL used a sequential scan and read all 10,000 fixture rows. The benchmark table contains only that one user, so this plan is expected for the fixture; it does not establish the optimal plan for a multi-user database.

The same CI run measured median **20.62 ms** for the SQL aggregate path versus **113.97 ms** for fetching all rows and aggregating in Node.js, about **5.5× faster** in this run. As above, these timings are a directional microbenchmark on a disposable CI database, not a production latency guarantee.

The exact aggregate query plan is now captured automatically in CI output. Remaining performance evidence: run the benchmark with multiple users and realistic per-user history sizes, capture dashboard HTTP response time and payload size, and repeat locally or on a representative staging database. No production database, Render configuration, or deployment was changed.


## Multi-user benchmark — 2026-10-21

Workflow [39531463974](https://github.com/PurpleeHead/FlowMoney/actions/runs/39531463974) passed on commit `802c28d0ca31c4c0782c2cdb33c088bc3f60091f`. The guarded CI benchmark now creates **five synthetic users and 50,000 total exchange rows** (10,000 per user), then compares the aggregate path with the full-history Node reference for one user.

| Path | Median | Highest of 7 measured rounds (reported as p95) |
|---|---:|---:|
| PostgreSQL aggregate | 21.53 ms | 24.97 ms |
| Fetch 10,000 rows + aggregate in Node | 118.27 ms | 137.01 ms |

This run is approximately **5.5× faster by median** for the SQL aggregate path. The full aggregate query plan used the existing `Exchange_userId_createdAt_idx` index via a Bitmap Index Scan, then a Bitmap Heap Scan of 10,000 matching rows. The aggregate node took 19.839 ms; the heap scan node took 2.001 ms. There were 190 shared buffer hits, zero shared reads, and no temporary blocks. The table contained 50,000 rows split evenly among five users; this remains synthetic CI data.

The measured result supports retaining the current user-scoped aggregate design and existing index; it does **not** justify adding an index or promise the same speedup in production. The “p95” column above is the maximum of seven samples, not a stable statistical p95. Full HTTP latency, response payload size, and measurements at multiple history sizes remain unverified.


## Scaling benchmark — 1k, 10k, and 50k rows per user

Workflow [39531588634](https://github.com/PurpleeHead/FlowMoney/actions/runs/39531588634) passed on commit `99a4ecd8f34f42e1e69a9146c94a989c95ef487a`. CI ran the same guarded benchmark at three history sizes, with five synthetic users at each size and the aggregate targeted to one user.

| Rows for target user | Total fixture rows | SQL aggregate median | Fetch + Node aggregate median | Median ratio |
|---:|---:|---:|---:|---:|
| 1,000 | 5,000 | 3.26 ms | 8.36 ms | 2.6× |
| 10,000 | 50,000 | 12.74 ms | 95.60 ms | 7.5× |
| 50,000 | 250,000 | 35.57 ms | 547.65 ms | 15.4× |

All three runs verified the selected aggregate totals against the Node-side reference before timing. PostgreSQL used the existing `Exchange_userId_createdAt_idx` for the user filter at all sizes. At 50,000 rows for the target user, the exact aggregate statement took about 30.4 ms in the captured plan and touched 946 shared buffers, with zero shared reads.

These results show the expected benefit of not transferring every historical exchange row to Node.js as user history grows. They remain CI microbenchmarks on one ephemeral PostgreSQL instance with synthetic, uniformly distributed user histories. They do not establish production response latency, cold-cache behavior, multi-tenant skew, or a service-level p95. The reported “p95” field is the maximum of seven samples and is retained only for trend visibility.
