-- Store the RUB equivalent calculated at the time an expense is recorded.
-- Existing expenses are backfilled only when a rate available at their date can support it.
ALTER TABLE "Expense" ADD COLUMN "amountRub" DECIMAL(20,4);

UPDATE "Expense" AS e
SET "amountRub" = CASE
  WHEN e."currency" = 'RUB' THEN ROUND(e."amount"::numeric, 4)
  WHEN e."usdtCharged" IS NOT NULL THEN (
    SELECT ROUND((e."usdtCharged" * SUM(x."rubSpent") / NULLIF(SUM(x."usdtReceived"), 0))::numeric, 4)
    FROM "Exchange" AS x
    WHERE x."userId" = e."userId" AND x."createdAt" <= e."date"
  )
  WHEN e."currency" = 'USDT' THEN (
    SELECT ROUND((e."amount" * SUM(x."rubSpent") / NULLIF(SUM(x."usdtReceived"), 0))::numeric, 4)
    FROM "Exchange" AS x
    WHERE x."userId" = e."userId" AND x."createdAt" <= e."date"
  )
  ELSE (
    SELECT ROUND((e."amountVnd" / NULLIF(SUM(x."vndReceived") / NULLIF(SUM(x."rubSpent"), 0), 0))::numeric, 4)
    FROM "Exchange" AS x
    WHERE x."userId" = e."userId"
      AND x."createdAt" <= e."date"
      AND x."vndReceived" IS NOT NULL
  )
END;
