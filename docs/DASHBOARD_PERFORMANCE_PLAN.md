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
