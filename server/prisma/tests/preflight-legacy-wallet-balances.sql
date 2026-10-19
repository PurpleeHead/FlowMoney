-- READ-ONLY RELEASE PREFLIGHT.
-- Run against the target database before applying wallet-movement migrations.
-- Do not infer or insert opening balances automatically from this output.
-- Any non-zero row must be reconciled against the owner's real balances and
-- historical operations before proceeding with the ledger backfill.

\echo 'Legacy wallet balance summary by currency'
SELECT
  upper(trim("currency")) AS currency,
  count(*) AS wallet_count,
  count(*) FILTER (WHERE "balance" <> 0) AS nonzero_wallet_count,
  sum("balance") AS legacy_balance_total
FROM "Wallet"
GROUP BY upper(trim("currency"))
ORDER BY upper(trim("currency"));

\echo 'Wallets requiring explicit review (expected: zero rows for a fresh/test database)'
SELECT
  "id" AS wallet_id,
  "userId" AS user_id,
  upper(trim("currency")) AS currency,
  "balance" AS legacy_balance,
  "updatedAt" AS last_updated_at
FROM "Wallet"
WHERE "balance" <> 0
ORDER BY "userId", upper(trim("currency"));

\echo 'Source record counts that the ledger backfill will inspect'
SELECT 'Expense' AS source_table, count(*) AS row_count FROM "Expense"
UNION ALL
SELECT 'Exchange' AS source_table, count(*) AS row_count FROM "Exchange"
ORDER BY source_table;
