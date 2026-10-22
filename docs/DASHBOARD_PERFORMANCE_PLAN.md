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

**Pagination status (PR #83):** `GET /api/journal` now supports a validated cursor and the client exposes a load-more control. The dedicated expense, exchange, and receipt endpoints now support opt-in cursor pages (`?limit=...` and `&cursor=...`) while preserving their legacy array response when pagination parameters are omitted. The expense CSV export now requests `/api/expenses?limit=500` and follows every `nextCursor` until `hasMore` is false, rather than exporting only the dashboard payload. The client uses a tested cursor-page collector with a safety cap and rejects missing/repeated cursors; tests cover a 625-record export. CSV cells are quoted and spreadsheet formula prefixes are neutralized. CI run [#1076](https://github.com/PurpleeHead/FlowMoney/actions/runs/39408940563) and security run [#135](https://github.com/PurpleeHead/FlowMoney/actions/runs/39408940545) passed on head `20ae5eee71ebbea8c113345ca0e4414a42f5eddb`, including server/client tests, production builds, dependency audits, and disposable-PostgreSQL migration/rollback/idempotency checks. This head includes the dashboard aggregate test-isolation cleanup. A further test-only commit `dc30ace47f1f178e40bc6cbf37538ad59a44a6d7` strengthens assertions for aggregate predicates; subsequent CI run [#1082](https://github.com/PurpleeHead/FlowMoney/actions/runs/39409162403) and security run [#138](https://github.com/PurpleeHead/FlowMoney/actions/runs/39409162456) both passed on current head `ce8bcfaf30808d05563fd140ad10e3ce19fef05d`. The client now fetches the first 100 expenses and exchanges separately and exposes cursor-based Load more controls for both lists. A saved-receipt history panel now loads the first 50 receipts, supports cursor continuation, and shows recognized items plus the original OCR text; receipt cursor continuation has a route regression test. The dashboard now uses user-scoped PostgreSQL aggregates for all-time VND spending, current-month VND spending, and weighted card-purchase VND/USDT totals; its expense-row query is limited to the last 12 calendar months required by the chart. This removes full-history expense row transfer while preserving all-time totals and weighted card rates. The endpoint still loads all exchanges to preserve exchange-derived rates and budget calculations, so the aggregate refactor is only partial. Code commits `e7f8eb3`, `0a000a1`, `0058bce`, `3914da6`, `bd2e5e9`, `bacf643`, and `dc30ace` make up the partial aggregate change and regression coverage. Latest verification before this documentation update: CI [#1087](https://github.com/PurpleeHead/FlowMoney/actions/runs/39409892759) and Security [#140](https://github.com/PurpleeHead/FlowMoney/actions/runs/39409892512) both passed on head `55fdd5c0afc6480d88f2875b462461258db380a1`. Earlier aggregate assertions also passed in CI #1082 / Security #138 on `ce8bcfaf30808d05563fd140ad10e3ce19fef05d`. These results verify tests/build/security on that exact head, but do not close production DB/backup/restore or live smoke-test gates. This note-only commit requires its own CI/security run. Cursor queries are scoped to the authenticated user and use deterministic timestamp/ID tie-breakers.

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

1. Add tests before changing query behavior (query-window regression coverage was added; aggregate equivalence still needs a PostgreSQL-backed fixture comparison).
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

## Follow-up verification — 2026-10-21 (historical edits and bounded exchange history)

The current test branch adds two more regression boundaries:

- A historical expense PATCH test asserts that exchange observations are bounded by exchange creation time, card-purchase observations are bounded by the effective expense date, and the edited expense is excluded from the card-purchase observation set.
- A dashboard API test supplies 101 exchange records and verifies that the response contains only 100 history rows while `totalExchangeCount` and the weighted RUB/USDT rate still include the 101st record. This protects summary correctness if the returned history window is later optimized independently.

Both the application verification and migration verification workflows passed for the tested commit. These tests do not implement the PostgreSQL exchange aggregate refactor. The old-vs-aggregate PostgreSQL fixture comparison, realistic query-plan/payload measurements, and operational production release gates remain open.

## Follow-up verification — 2026-10-21 (receipt valuation parity)

The receipt-save valuation path now reuses the same direct-VND and actual-VND exchange mappers as ordinary expense creation and editing. This fixes a legacy-data discrepancy: direct `RUB_TARGET → VND` rows with padded/lowercase currency codes, or with the actual VND amount stored in `targetReceived` / `vndReceived`, are now interpreted using the same precedence and normalization rules as expense valuation.

Regression coverage includes a legacy 500 RUB → 125,000 VND operation and verifies that a 50,000 VND receipt item stores a 200 RUB valuation. A separate receipt API test asserts that exchange and card-purchase observations are user-scoped and bounded to the receipt-save timestamp, and that planning-only rates remain excluded from factual saved RUB valuations.

CI and PostgreSQL migration verification passed on head `f49562b10ab96523d85769c61c913d4371e126d2` (runs [#39614851150](https://github.com/PurpleeHead/FlowMoney/actions/runs/39614851150) and [#39614859415](https://github.com/PurpleeHead/FlowMoney/actions/runs/39614859415)). This closes the receipt-vs-expense direct-VND mapping discrepancy; it does not close the separate dashboard exchange-aggregate refactor or production query-plan / operational release gates.

## Runtime aggregate implementation — 2026-10-22 (draft PR #96)

A draft runtime change now replaces the unbounded exchange-history read used for dashboard calculations with a single user-scoped PostgreSQL aggregate query. The API separately fetches only the newest 100 exchange rows for display; lifetime counts and summary calculations are not derived from that bounded list.

The SQL aggregate covers:
- actual RUB/USDT acquisitions, including normalized direct RUB_TARGET → USDT rows;
- actual indirect VND/USDT outcomes, separate from planning-only rates;
- planning weighted numerator and denominator;
- direct and indirect actual VND/RUB cost bases, including legacy direct-VND fallback precedence;
- confirmed VND, non-VND target estimates, unconverted USDT estimate input, and unpriced-top-up detection.

The first CI pass exposed a template-literal syntax error and, after that was fixed, two API tests correctly caught that the test double did not enforce Prisma's take: 100 behavior. Both were corrected and the latest CI runs pass. PostgreSQL-backed execution of the exact runtime helper and old-vs-new parity on the full mixed-mode fixture are covered. A disposable CI benchmark also measures the full helper on 25,000 rows across 10 tenants and records a tenant-scoped EXPLAIN (ANALYZE, BUFFERS) plan. This synthetic measurement is a regression baseline, not a substitute for production-like Render/database measurements or response-size measurement. Do not merge or deploy this draft PR.
## Runtime SQL parity follow-up — 2026-10-22

The runtime aggregate query has been extracted into `server/src/lib/dashboard-exchange-aggregate.ts` and is now called by the dashboard route. The disposable PostgreSQL equivalence fixture invokes this exact helper (not a separately re-created query) and compares its weighted RUB/USDT, actual VND/USDT, planning inputs, direct/indirect VND/RUB cost basis, confirmed VND, target estimates, unconverted USDT, and flags against the existing TypeScript formulas. The fixture also contains a legacy target with an empty currency string and a second user's high-value exchange to protect normalization and tenant isolation.

Both CI workflows passed on head `a78e2c338672f70db3f8b09c6d480d4a53e55454`: [application verification](https://github.com/PurpleeHead/FlowMoney/actions/runs/39702792501) and [PostgreSQL migration/equivalence verification](https://github.com/PurpleeHead/FlowMoney/actions/runs/39702786051). A follow-up API test additionally asserts that the runtime SQL binds the authenticated user ID and the response query uses `take: 100`; that latest CI run is still required before treating the newest head as validated.

Still open: run and record `EXPLAIN (ANALYZE, BUFFERS)` and response-size/timing measurements against representative history sizes, inspect the resulting plan, finish review/stabilization, and complete backup/restore/Render/smoke-test release gates. No merge or deployment is authorized by this work.

## Disposable PostgreSQL performance baseline — 2026-10-22

The CI workflow now runs `server/prisma/tests/benchmark-dashboard-exchange-aggregate.ts` after migrations and financial equivalence checks. It creates 25,000 exchange rows across 10 test tenants in the disposable PostgreSQL service, measures five executions of the exact `aggregateDashboardExchanges(userId)` runtime helper after warm-up, records a tenant-scoped `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` plan, and removes the test users in a `finally` block.

Latest successful CI run including bounded history payload measurement: [#39703902249](https://github.com/PurpleeHead/FlowMoney/actions/runs/39703902249). Results on GitHub's ephemeral runner:
- Runtime helper latency (five warm runs): 5.372, 5.260, 5.158, 5.259, 5.296 ms; median 5.260 ms (latest rerun).
- The representative tenant-scoped aggregate plan used `Exchange_userId_createdAt_idx` via Bitmap Index Scan + Bitmap Heap Scan; 2,500 matching rows, 47 shared buffer hits, 0 shared reads, 0 temp blocks, 0.546 ms execution time in the latest rerun for that EXPLAIN query.
- The bounded recent-history query returned exactly 100 rows in 3.495 ms and serialized to 34,879 bytes (JSON for the exchange-history rows only, not the full dashboard response).
- Full mixed-mode runtime aggregate parity and tenant-isolation fixture passed in the same run.

These figures are specific to a warm, local, synthetic CI database. They do not predict cold-cache, network, production-size, concurrent-load, or hosted PostgreSQL latency, and the EXPLAIN query is a representative tenant-scoped aggregate rather than a claim that every dashboard aggregate has an identical plan. Remaining before release: production-like query/response-size measurements, final review/stabilization, and operational backup/restore + Render + smoke-test gates. No merge or deployment is authorized by this work.


## Exact runtime aggregate plan — 2026-10-22 (head bc634d07)

The latest application-verification and PostgreSQL-verification workflows both passed on head `bc634d07d14f33cf88ed0738b5d2dacf633e74d6`: [application verification](https://github.com/PurpleeHead/FlowMoney/actions/runs/39704425531) and [PostgreSQL verification + benchmark](https://github.com/PurpleeHead/FlowMoney/actions/runs/39704428940). The benchmark now runs `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` against the exact `Prisma.Sql` query returned by `dashboardExchangeAggregateQuery(userId)`, which is also called by the runtime helper. A separate selective tenant aggregate retains an index-plan assertion; the planner is allowed to choose a sequential scan for the wider multi-column runtime aggregate when that is cheaper.

Latest disposable CI sample (25,000 rows / 10 tenants, warm runner):
- Exact runtime helper timings: 5.717, 5.467, 5.369, 5.336, 5.347 ms; median 5.369 ms.
- Exact runtime aggregate `EXPLAIN ANALYZE`: 4.691 ms execution time; 47 shared buffer hits, zero shared reads and zero temp blocks. PostgreSQL used a Bitmap Heap Scan over 2,500 rows for this tenant and chose `Exchange_userId_createdAt_idx` for the inner Bitmap Index Scan.
- Bounded history: 100 rows, 3.518 ms query time, 34,879 serialized JSON bytes (exchange-history rows only, not the entire dashboard response).

The exact aggregate plan is now recorded in CI output rather than inferred from a separate SUM-only query. This remains a synthetic, warm, disposable PostgreSQL measurement; it does not represent cold-cache behavior, hosted network latency, concurrency, production row distributions, or the full response payload. The latest application and PostgreSQL workflows are green, but hosted/production-like performance, final review/stabilization, and operational release gates remain open. PR #96 remains Draft and must not be merged or deployed without explicit authorization.


## Full dashboard API benchmark — 2026-10-22 (head 2aa231df)

The benchmark now also starts the real Express dashboard route against the disposable CI PostgreSQL database, authenticates a synthetic test user, and measures the complete `GET /api/dashboard` request and response. It asserts that the API returns HTTP 200, reports all 2,500 exchange records in `totalExchangeCount`, and includes only 100 exchange rows in the response. This complements the lower-level exact SQL plan and standalone history-query measurements.

Latest CI sample on head `2aa231dff87a86e5353e441e4e1cd572a5793f52` (25,000 exchange rows across 10 tenants):
- Full dashboard API latency: 50.404 ms; complete serialized response: 34,706 bytes.
- Dashboard exchange aggregate helper median: 5.478 ms.
- Exact runtime aggregate `EXPLAIN ANALYZE`: 4.985 ms execution time; selective tenant-only aggregate: 0.514 ms.
- Standalone recent-history query: 4.054 ms for 100 rows; serialized history: 34,879 bytes.
- Both application verification and PostgreSQL/migration verification passed: [application run](https://github.com/PurpleeHead/FlowMoney/actions/runs/39704742106), [PostgreSQL benchmark run](https://github.com/PurpleeHead/FlowMoney/actions/runs/39704745965).

These timings are one warm, synthetic CI sample and include local loopback HTTP but not a hosted network hop. They are a repeatable baseline, not a production SLA or a cold/concurrent-load result. The end-to-end payload is for the complete dashboard response for a tenant with 2,500 exchanges and no seeded expenses; realistic user data and hosted measurements are still needed. The benchmark only writes disposable CI data and cleans up its users; no production database or deployment was touched.


## Concurrent dashboard request baseline — 2026-10-22 (head 85052c6c)

The disposable PostgreSQL benchmark now sends ten simultaneous authenticated requests through the real `GET /api/dashboard` route. Every response is asserted to be HTTP 200, retain the tenant's full 2,500-exchange lifetime count, and return only 100 exchange rows. Application verification and the PostgreSQL benchmark/migration workflow both passed on this head: [application verification](https://github.com/PurpleeHead/FlowMoney/actions/runs/39704922744) and [PostgreSQL benchmark](https://github.com/PurpleeHead/FlowMoney/actions/runs/39704927393).

Latest synthetic sample:
- Single complete dashboard request: 45.270 ms; complete JSON payload: 34,706 bytes.
- Ten concurrent requests: p50 55.619 ms; p95 87.037 ms.
- Runtime aggregate helper median: 5.292 ms.
- Exact runtime aggregate `EXPLAIN ANALYZE`: 8.392 ms; selective tenant-only query: 0.891 ms.
- The 100-row standalone history query took 4.042 ms and serialized to 34,879 bytes.

The SQL-plan sample was captured after the concurrent requests, so its execution time may reflect the test's local contention and is not directly comparable to a separately warmed single-query sample. These are single-run synthetic baselines on an ephemeral runner, not an SLO or production estimate; real hosted PostgreSQL, cold cache, production row distributions, and longer concurrency/load profiles remain release gates. The benchmark is read-only against production: it only creates and deletes synthetic records in the disposable CI database.


## Expense-inclusive dashboard load baseline — 2026-10-22 (head 0b2297c4)

The disposable PostgreSQL benchmark now seeds both exchange and expense history for each of 10 tenants: 2,500 exchanges and 1,000 expenses per user (35,000 rows total). Expense dates span the last 300 days, so the real dashboard route serializes a populated 12-month expense chart/history window rather than a near-empty expense list. The script runs `ANALYZE` on both `Exchange` and `Expense`, and checks the complete API response for tenant-scoped lifetime expense totals, weighted card-purchase VND/USDT numerator and denominator, weighted observed rate, lifetime exchange count, and bounded 100-row exchange history. Ten concurrent requests also verify the full expense count and totals for every response.

Both CI workflows passed on head `0b2297c4f492bfe52c8d9d1d0c7af30c84003137`: [application tests/build](https://github.com/PurpleeHead/FlowMoney/actions/runs/39705356237) and [PostgreSQL/migration/benchmark](https://github.com/PurpleeHead/FlowMoney/actions/runs/39705360380).

Latest synthetic CI sample (35,000 seeded rows):
- Full `GET /api/dashboard`: 73.381 ms; complete JSON response 248,835 bytes, including 1,000 expense rows and 100 exchange rows.
- Ten concurrent full dashboard requests: p50 226.671 ms; p95 231.009 ms.
- Exact exchange aggregate helper median: 5.303 ms across five warm calls.
- Bounded 100-row exchange-history query: 3.437 ms; history-only JSON 34,879 bytes.
- Exact runtime aggregate `EXPLAIN ANALYZE`: 5.011 ms; selective tenant-only query: 0.478 ms.

This is a synthetic, single-run, warm ephemeral CI baseline. It does not include a hosted app-to-database network hop, cold-cache measurements, realistic expense distributions or long-duration concurrency. The benchmark is confined to the disposable CI PostgreSQL service and deletes its synthetic users in cleanup. Hosted performance/load testing, final financial review/stabilization, and operational backup/restore/Render/smoke-test gates remain outstanding. PR #96 remains Draft and must not be merged or deployed without explicit authorization.
