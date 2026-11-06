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

It seeds shared default expense categories. Existing `Wallet`, `Exchange`, `Expense` and `Receipt` tables and their records are not dropped or rewritten. It also adds a PostgreSQL expression-based unique index for budget scope, so shared budgets with nullable member/category fields cannot be duplicated by concurrent requests.

## Before applying to any persistent database

1. Take a provider-native PostgreSQL backup or snapshot.
2. Verify that the backup is restorable; a successful backup job alone is not enough.
3. Record the current migration status and database version.
4. Apply migrations first to a disposable copy or staging database.
5. Run Prisma validation, API tests and a smoke test against that copy.
6. Obtain explicit approval before applying to production.

Do not run `prisma migrate dev` against production. The committed migration command is `npx prisma migrate deploy --schema server/prisma/schema.prisma`. Render service startup is deliberately configured to run only the application; it does not apply migrations automatically. Apply the migration as a separate, approved release step after backup and staging verification.

## Local backup and restore rehearsal

For the local Docker database only, the repository includes two PowerShell helpers:

1. Run `./BACKUP-LOCAL-FLOWMONEY.ps1` to create a PostgreSQL custom-format backup in `%USERPROFILE%\\FlowMoneyBackups`. The script checks that `server/.env` points to `localhost:5433`, creates the dump inside the local container, copies it to the host and verifies that PostgreSQL can read the archive.
2. Run `./VERIFY-LOCAL-BACKUP.ps1 -BackupPath "C:\\path\\to\\flowmoney-local-YYYYMMDD-HHMMSS.dump"` with the exact path printed by the backup script.
3. The verification script restores the archive into a disposable database named `flowmoney_restore_check`, checks for the core user and personal-finance tables, then removes the temporary database.

The verification script does not overwrite the active local database. Both helpers refuse to run when `DATABASE_URL` is not a local address on port 5433. These scripts are not a substitute for provider-native production backups and do not access Render.

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
