# Personal finance migration notes

Migration: `20261106130000_personal_finance_core`

## What it changes

This migration is additive. It creates the personal-finance tables:

- `HouseholdMember`
- `IncomeSource` and `IncomeEntry`
- `ExpenseCategory`
- `LedgerExpense`
- `Obligation` and `ObligationOccurrence`
- `BalanceAdjustment`
- `Budget`
- `SavingsGoal`
- User preferences: IANA timezone (default `Europe/Moscow`) and locale (default `ru`)
- Household opening balance (`openingBalance`), effective calendar date (`openingBalanceDate`) and explicit setup flag (`openingBalanceConfigured`, false until the user saves settings)

It seeds shared default expense categories. Existing `Wallet`, `Exchange`, `Expense` and `Receipt` tables and their records are not dropped or rewritten.

## Before applying to any persistent database

1. Take a provider-native PostgreSQL backup or snapshot.
2. Verify that the backup is restorable; a successful backup job alone is not enough.
3. Record the current migration status and database version.
4. Apply migrations first to a disposable copy or staging database.
5. Run Prisma validation, API tests and a smoke test against that copy.
6. Obtain explicit approval before applying to production.

Do not run `prisma migrate dev` against production. The committed migration command is `npx prisma migrate deploy --schema server/prisma/schema.prisma`.

## Rollback

There is no automatic down migration. The SQL below removes only the tables created by this migration, in dependency-safe order. **It permanently deletes every personal-finance record created after rollout.** Export the new data first and obtain explicit approval before running it.

```sql
DROP TABLE IF EXISTS "SavingsGoal";
DROP TABLE IF EXISTS "Budget";
DROP TABLE IF EXISTS "BalanceAdjustment";
DROP TABLE IF EXISTS "ObligationOccurrence";
DROP TABLE IF EXISTS "LedgerExpense";
DROP TABLE IF EXISTS "Obligation";
DROP TABLE IF EXISTS "ExpenseCategory";
DROP TABLE IF EXISTS "IncomeEntry";
DROP TABLE IF EXISTS "IncomeSource";
DROP TABLE IF EXISTS "HouseholdMember";
ALTER TABLE "User" DROP COLUMN IF EXISTS "openingBalanceConfigured";
ALTER TABLE "User" DROP COLUMN IF EXISTS "openingBalanceDate";
ALTER TABLE "User" DROP COLUMN IF EXISTS "openingBalance";
ALTER TABLE "User" DROP COLUMN IF EXISTS "locale";
ALTER TABLE "User" DROP COLUMN IF EXISTS "timezone";
```

After rollback, Prisma's migration history must be reconciled deliberately for the target environment. Do not delete migration history rows blindly; restore the pre-migration snapshot if a fully consistent rollback is required.

## Operational boundary

This document does not authorize a production backup, migration, rollback, Render configuration change, deploy, or merge. Those actions require separate explicit approval.
