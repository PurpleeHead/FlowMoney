# FLOWMONEY — Technical Specification: Personal Finance

Status: approved scope for implementation
Target branch: feature/personal-finance-rework
Currency: RUB only
Timezone: user-configurable; default Europe/Moscow
Locale: Russian and English (retain existing i18n where practical)

## 1. Product goal

Replace the former RUB/USDT/VND exchange tracker with a personal/family income, expense, obligations, and budget planner. The application is a manual accounting tool; it does not connect to banks or initiate payments.

Core principles:
- Separate planned, actual, and forecast values.
- Never count a planned income as cash until marked received.
- Never deduct an obligation twice when it is paid.
- Keep historical transactions immutable except explicit user edits.
- All money values are RUB, stored as Decimal with kopecks.
- Family budget supports attribution to a household member and a shared/unassigned option.

## 2. Main areas

### 2.1 Income
Income sources support recurrence:
- daily
- weekly (weekday / interval)
- twice monthly (two configured days)
- monthly (configured day; clamp to month end)
- one-time

Each source has name, amount, recurrence, start date, optional end date, next planned date, active flag, owner/member, and notes.
Generate planned income occurrences for a bounded horizon (e.g. current month + next 2 months); avoid duplicate occurrences using a unique source/date key.
Each occurrence has due date, planned amount, status PLANNED / RECEIVED / SKIPPED, actual amount, received date, owner/member and optional note.
Only RECEIVED occurrences affect actual balance. Planned occurrences contribute to forecast only.
Allow manual one-off income and editing/deleting with confirmation.

### 2.2 Expenses
Each expense is a dated actual transaction with amount, category, optional description, person/member, createdAt and updatedAt.
Seed editable categories: groceries, cafes/restaurants, coffee, transport/taxi, fuel, car repair, car maintenance/TO, home, health, entertainment, shopping, subscriptions, education, travel, other.
Users can add, rename, archive categories. Historical expenses keep their category association; archived categories remain readable.
Support filters by date range, category, and person.

### 2.3 Obligations
An obligation is a recurring or one-time commitment, not itself a cash transaction.
Fields: title, category, amount, recurrence (once/weekly/monthly/yearly), due-date rule, start date, optional end date, owner/member, active flag, notes.
Create dated obligation occurrences with statuses UPCOMING / PAID / OVERDUE / SKIPPED.
When marked PAID, create exactly one linked expense transaction and store paidAt/actualAmount. Repeated requests must be idempotent. The linked expense is the only deduction from actual cash balance.
Monthly obligation total = sum of due occurrences in selected calendar month, including unpaid and paid amounts for burden reporting; show paid and unpaid subtotals separately.
Future obligations are displayed by month and in a payment calendar. Do not sum all future obligations into the current-month total.

### 2.4 Household members
Support a household with multiple members and a shared/unassigned category.
Each income, expense, income source, and obligation can be attributed to one member.
Provide household aggregate and member-specific filters. Archived members cannot be assigned to new income sources, income entries, expenses, obligations, or adjustments, but remain available in historical filters and retain attribution on existing records. A member is a simple profile/label, not a separate login in v1. Do not expose one household to other accounts.

### 2.5 Budgets and goals
Monthly budgets can be set globally and per expense category, optionally per member. Each household/month/member/category scope must have at most one budget, including shared (unassigned) scopes.
Savings goals have title, target amount, current amount (manual or derived from explicitly allocated contributions), target date and status.
Budgets/Goals are a later phase after core ledger correctness.

## 3. Dashboard and calculations

Selected period defaults to current calendar month.

Display:
1. Actual cash balance: household opening balance as of the configured start date + received incomes after that date + signed balance adjustments after that date - actual expenses after that date. When filtering a single member, do not apply the household-wide opening balance to that member.
   The actual balance is measured as of the current date/time and must never include future-dated ledger entries, regardless of the selected reporting period.
2. Forecast balance at selected horizon: actual cash balance + planned incomes expected by horizon - unpaid obligations due by horizon - planned variable expenses (only if entered as plans; don't invent an estimate).
3. Income: planned total, received total, remaining expected.
4. Expenses: actual total and category breakdown.
5. Obligations: total due this month, paid, unpaid, overdue; also next upcoming payments.
6. Coverage: received income vs total obligations due this month. If received income < obligations, show shortfall; otherwise show surplus. Also show planned-income coverage separately to avoid implying unreceived money is available.
7. Period net: actual received income minus actual expenses.

Opening balance and its effective date must be explicitly visible and editable in settings; explain that ledger movements before the effective date are excluded to prevent double counting. New accounts default to zero on the account creation date, but the user should be prompted to set the real amount. Support signed balance adjustment entries with date, amount and reason to preserve an audit trail.

Avoid double counting: paid obligation occurrence links to one expense; monthly obligation burden report includes the occurrence but dashboard actual expenses includes the linked expense once.

## 4. Dates and recurrence

Store timestamps in UTC and calendar dates as date-only values where appropriate; interpret recurrence using the household/user timezone. Default timezone Europe/Moscow, editable in settings. API report date parameters must be valid calendar dates (invalid or impossible dates return 400), and report ranges / forecast horizons are bounded to two years to prevent unbounded occurrence generation and expensive aggregate queries.
Daily: every day from start to end.
Weekly: selected weekday(s) or interval.
Twice monthly: two selected day numbers; clamp invalid days to month end; if same date, reject.
Monthly: selected day; clamp to month end.
Yearly: selected month/day; Feb 29 clamps to Feb 28 in non-leap years.
One-time: one occurrence.
Provide a deterministic occurrence generator and unique constraints to prevent duplicates. Never generate unlimited future rows; generate a rolling horizon.

## 5. Data model proposal (Prisma)

- HouseholdMember: id, userId, name, color?, isArchived, timestamps.
- IncomeSource: id, userId, memberId?, title, amount Decimal(14,2), recurrence, recurrenceConfig Json, startDate, endDate?, isActive, timestamps.
- IncomeEntry: id, userId, sourceId?, memberId?, plannedDate, plannedAmount Decimal(14,2), status, actualAmount Decimal(14,2)?, receivedAt?, note?, unique(sourceId, plannedDate) where supported.
- ExpenseCategory: id, userId nullable for system defaults, name, slug, isArchived, timestamps.
- Expense: id, userId, memberId?, categoryId?, title, amount Decimal(14,2), date, note?, obligationPaymentId? unique, timestamps.
- Obligation: id, userId, memberId?, title, category, amount Decimal(14,2), recurrence, recurrenceConfig Json, startDate, endDate?, isActive, notes, timestamps.
- ObligationOccurrence: id, userId, obligationId, dueDate, plannedAmount Decimal(14,2), status, paidAt?, actualAmount?, expenseId? unique, timestamps, unique(obligationId,dueDate).
- BalanceAdjustment: id, userId, memberId?, amount Decimal(14,2) signed, date, reason, createdAt.
- Budget: id, userId, memberId?, categoryId?, periodMonth, limitAmount Decimal(14,2), timestamps.
- SavingsGoal: id, userId, title, targetAmount Decimal(14,2), currentAmount Decimal(14,2), targetDate?, status, timestamps.

Final schema may be simplified during implementation but must preserve the above invariants.

## 6. API outline

Authenticated endpoints:
- GET/POST/PATCH/DELETE /api/income-sources
- GET/POST/PATCH/DELETE /api/income-entries
- POST /api/income-entries/:id/receive
- GET/POST/PATCH/DELETE /api/expenses
- GET/POST/PATCH/DELETE /api/expense-categories
- GET/POST/PATCH/DELETE /api/obligations
- GET /api/obligations/occurrences
- POST /api/obligations/occurrences/:id/pay
- GET/POST/PATCH/DELETE /api/household-members
- GET/POST /api/balance-adjustments
- GET/POST/PATCH/DELETE /api/budgets
- GET/POST/PATCH/DELETE /api/savings-goals
- GET /api/dashboard?from=&to=&horizon=

Every endpoint must scope records by authenticated userId and validate all input with Zod. Use database transactions for receive/pay operations and idempotency protections.

## 7. UI
Navigation:
- Overview
- Income
- Expenses
- Obligations
- Calendar
- Analytics
- Budgets & goals
- Settings

Dashboard should prioritize actual balance, forecast balance, income/expense summaries, obligation coverage, next due payments, and a monthly trend chart.
All forms support date selection, RUB formatting, validation, edit/delete, empty/loading/error states, and mobile layouts without horizontal scrolling.
Keep RU/EN language support if already present.

## 8. Migration and legacy data
- Take a database backup before any migration.
- Do not run production migrations or deploy without explicit user approval.
- Do not delete legacy Exchange/Receipt data in the first migration. Keep old tables temporarily or archive them; new UI/API should stop using them.
- Add a reversible or carefully staged migration and document rollback.
- Do not merge to main until user approves.

## 9. Implementation phases and acceptance criteria

Phase 0 — branch and specification:
- Create feature/personal-finance-rework from main.
- Commit this specification.
Acceptance: branch exists; main untouched.

Phase 1 — schema and core domain:
- Add the new Prisma models and migrations.
- Implement deterministic recurrence utilities and financial calculation services.
- Add unit tests for month-end dates, leap years, duplicate generation, actual vs planned balance, shortfall, and no double counting.
Acceptance: migration validates; server/client build and tests pass.

Phase 2 — API:
- Implement authenticated CRUD and receive/pay flows with transactions.
Acceptance: user isolation, validation, idempotency, and API tests pass. Integration coverage includes registration/login, unauthorized access, household isolation, future-dated transaction exclusion from actual balance, and duplicate budget creation.

Phase 3 — UI:
- Implement income, expense, obligations and dashboard screens.
Acceptance: all operations can be performed on mobile and desktop; actual and forecast are clearly distinguished.

Phase 4 — analytics/calendar:
- Add month selector, charts, calendar, category and member filters.
Acceptance: figures reconcile with ledger and linked obligation expenses are counted once.

Phase 5 — budgets/goals and polish:
- Add budgets, goals, settings, accessibility, localization and final regression.
Acceptance: no critical errors; documented migration and rollback; user reviews PR.

## 10. Explicit non-goals
- No USDT/VND conversion or exchange logic.
- No bank integrations or automatic bank synchronization in initial release.
- No real payment processing.
- No automatic financial advice or assumptions about unentered future expenses.
