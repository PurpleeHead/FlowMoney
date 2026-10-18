-- Backfill existing source records into the unified wallet ledger.
-- Additive and idempotent: source keys already synchronized by the live API are preserved.
-- This migration is not applied automatically by application startup.
INSERT INTO "WalletMovement" (
  "id", "userId", "currency", "amountDelta", "kind", "sourceKey", "note", "occurredAt"
)
SELECT
  gen_random_uuid()::text,
  e."userId",
  CASE
    WHEN e."usdtCharged" IS NOT NULL AND e."usdtCharged" > 0 THEN 'USDT'
    ELSE upper(trim(e."currency"))
  END,
  CASE
    WHEN e."usdtCharged" IS NOT NULL AND e."usdtCharged" > 0 THEN -e."usdtCharged"
    ELSE -e."amount"
  END,
  'EXPENSE',
  'expense:' || e."id" || ':' ||
    CASE
      WHEN e."usdtCharged" IS NOT NULL AND e."usdtCharged" > 0 THEN 'USDT'
      ELSE upper(trim(e."currency"))
    END,
  'Expense ' || e."id",
  e."date"
FROM "Expense" e
WHERE e."amount" > 0
  AND (
    (e."usdtCharged" IS NOT NULL AND e."usdtCharged" > 0)
    OR upper(trim(e."currency")) IN ('RUB', 'USDT', 'VND')
  )

UNION ALL

SELECT
  gen_random_uuid()::text,
  x."userId",
  'RUB',
  -x."rubSpent",
  'EXCHANGE',
  'exchange:' || x."id" || ':RUB',
  'Exchange ' || x."id",
  x."createdAt"
FROM "Exchange" x
WHERE x."rubSpent" > 0

UNION ALL

SELECT
  gen_random_uuid()::text,
  x."userId",
  'VND',
  CASE
    WHEN x."targetReceived" IS NOT NULL AND x."targetReceived" > 0 THEN x."targetReceived"
    ELSE x."vndReceived"
  END,
  'EXCHANGE',
  'exchange:' || x."id" || ':VND',
  'Exchange ' || x."id",
  x."createdAt"
FROM "Exchange" x
WHERE x."mode" = 'RUB_VND'
  AND (
    (x."targetReceived" IS NOT NULL AND x."targetReceived" > 0)
    OR (x."vndReceived" IS NOT NULL AND x."vndReceived" > 0)
  )

UNION ALL

SELECT
  gen_random_uuid()::text,
  x."userId",
  upper(trim(x."targetCurrency")),
  x."targetReceived",
  'EXCHANGE',
  'exchange:' || x."id" || ':' || upper(trim(x."targetCurrency")),
  'Exchange ' || x."id",
  x."createdAt"
FROM "Exchange" x
WHERE x."mode" = 'RUB_TARGET'
  AND upper(trim(x."targetCurrency")) IN ('RUB', 'USDT', 'VND')
  AND x."targetReceived" IS NOT NULL
  AND x."targetReceived" > 0

UNION ALL

SELECT
  gen_random_uuid()::text,
  x."userId",
  'USDT',
  x."usdtReceived",
  'EXCHANGE',
  'exchange:' || x."id" || ':USDT',
  'Exchange ' || x."id",
  x."createdAt"
FROM "Exchange" x
WHERE x."mode" NOT IN ('RUB_VND', 'RUB_TARGET')
  AND x."usdtReceived" IS NOT NULL
  AND x."usdtReceived" > 0

UNION ALL

SELECT
  gen_random_uuid()::text,
  x."userId",
  'VND',
  x."vndReceived",
  'EXCHANGE',
  'exchange:' || x."id" || ':VND',
  'Exchange ' || x."id",
  x."createdAt"
FROM "Exchange" x
WHERE x."mode" NOT IN ('RUB_VND', 'RUB_TARGET')
  AND x."vndReceived" IS NOT NULL
  AND x."vndReceived" > 0

ON CONFLICT ("sourceKey") DO NOTHING;
