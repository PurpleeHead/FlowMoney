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

**Pagination status (PR #83):** `GET /api/journal` now supports a validated cursor and the client exposes a load-more control. The dedicated expense, exchange, and receipt endpoints now support opt-in cursor pages (`?limit=...` and `&cursor=...`) while preserving their legacy array response when pagination parameters are omitted. The dedicated-list client continuation and any export workflow still need verification/implementation before claiming full-history access. Until then, never describe capped legacy lists or exports as complete. Cursor queries are scoped to the authenticated user and use deterministic timestamp/ID tie-breakers.

### 4. Add query support only after measuring

Existing indexes on `Expense(userId, date)` and `Exchange(userId, createdAt)` already support the main user/date filters. Capture representative `EXPLAIN (ANALYZE, BUFFERS)` output before adding more indexes; avoid redundant indexes that increase write and storage costs.

## Required regression tests

- Compare aggregate-backed totals and weighted rates against the existing pure TypeScript formulas over a fixture containing mixed exchange modes, missing VND outcomes, direct RUB→USDT top-ups, and actual card purchases.
- Confirm planned VND rates never enter factual observed rates.
- Confirm direct VND exchanges and non-VND target estimates are not double-counted as confirmed VND.
- Confirm current-month totals use the same month boundary and timezone behavior as before.
- Confirm expenses created/edited in the past only use observations available at that timestamp.
- Confirm a history pagination limit does not alter any summary total or weighted rate.
- Confirm user scoping applies to every aggregate and page query.

## Release gates

1. Add tests before changing query behavior.
2. Compare old and new results against the same PostgreSQL fixture.
3. Run unit/API tests, production build, migration CI, and dependency audit.
4. Inspect query plans and payload sizes with realistic history sizes.
5. Keep the refactor in a reviewed PR; do not merge or deploy until every gate passes.
