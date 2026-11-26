# One-time Supabase → Neon import

This utility imports the current nummioX staging dataset from Supabase into Neon. It does not modify the source database.

## Required GitHub repository configuration

Add these Actions secrets (never paste connection strings into chat or commit them):

- `SOURCE_DATABASE_URL`: Supabase project `nummioX-staging-db` → Project Settings → Database → Connection string → URI.
- `TARGET_DATABASE_URL`: Neon project `nummiox-staging` → Connect → connection string for the default `staging` branch and database `nummiox`.

Add repository variable:

- `ALLOW_NUMMIOX_DATA_IMPORT` = `true`

A push to this branch starts the guarded one-time import. The workflow is intentionally not merged into the app's staging or production branches.

## Safety behavior

- Reads source rows in a repeatable-read, read-only transaction.
- Writes to Neon in one transaction; any failed validation rolls back the import.
- Preserves the existing Neon account ID and password for the matching email, while attaching the source account's financial records to that account.
- Maps the primary household to the already-created Neon household.
- Maps built-in categories by slug to avoid duplicate default categories.
- Keeps the source database unchanged.
- Verifies imported primary keys and household access before commit.
- A Neon backup branch was created before the migration: `backup-before-supabase-import-20261126`.

After successful import, set `ALLOW_NUMMIOX_DATA_IMPORT` to `false` and delete both Actions secrets.
