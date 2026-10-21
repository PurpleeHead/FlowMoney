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
    WHEN upper(trim(e."currency")) = 'VND'
      AND e."usdtCharged" > 0
      AND e."usdtCharged"::text NOT IN ('NaN', 'Infinity', '-Infinity') THEN 'USDT'
    ELSE upper(trim(e."currency"))
  END,
  CASE
    WHEN upper(trim(e."currency")) = 'VND'
      AND e."usdtCharged" > 0
      AND e."usdtCharged"::text NOT IN ('NaN', 'Infinity', '-Infinity') THEN -e."usdtCharged"
    ELSE -e."amount"
  END,
  'EXPENSE',
  'expense:' || e."id" || ':' ||
    CASE
      WHEN upper(trim(e."currency")) = 'VND'
        AND e."usdtCharged" > 0
        AND e."usdtCharged"::text NOT IN ('NaN', 'Infinity', '-Infinity') THEN 'USDT'
      ELSE upper(trim(e."currency"))
    END,
  'Expense ' || e."id",
  e."date"
FROM "Expense" e
WHERE e."amount" > 0
  AND e."amount"::text NOT IN ('NaN', 'Infinity', '-Infinity')
  AND upper(trim(e."currency")) IN ('RUB', 'USDT', 'VND')
  -- Match runtime ledger rules: a present but invalid card debit on a VND
  -- expense is malformed evidence, not permission to fall back to cash VND.
  AND NOT (
    upper(trim(e."currency")) = 'VND'
    AND e."usdtCharged" IS NOT NULL
    AND (
      e."usdtCharged" <= 0
      OR e."usdtCharged"::text IN ('NaN', 'Infinity', '-Infinity')
    )
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
  AND x."rubSpent"::text NOT IN ('NaN', 'Infinity', '-Infinity')

UNION ALL

SELECT
  gen_random_uuid()::text,
  x."userId",
  'VND',
  CASE
    -- Match runtime ledger sync: a known vndReceived value (including zero or
    -- malformed NaN) takes precedence; gross targetReceived is only a fallback
    -- when net VND is NULL and no fee was recorded.
    WHEN x."vndReceived" IS NOT NULL THEN NULLIF(x."vndReceived", 0)
    WHEN COALESCE(x."vndFee", 0) = 0
      AND COALESCE(x."vndFee", 0)::text NOT IN ('NaN', 'Infinity', '-Infinity')
      THEN x."targetReceived"
    ELSE NULL
  END,
  'EXCHANGE',
  'exchange:' || x."id" || ':VND',
  'Exchange ' || x."id",
  x."createdAt"
FROM "Exchange" x
WHERE x."mode" = 'RUB_VND'
  AND (
    (
      x."vndReceived" IS NOT NULL
      AND x."vndReceived" > 0
      AND x."vndReceived"::text NOT IN ('NaN', 'Infinity', '-Infinity')
    )
    OR (
      x."vndReceived" IS NULL
      AND COALESCE(x."vndFee", 0) = 0
      AND COALESCE(x."vndFee", 0)::text NOT IN ('NaN', 'Infinity', '-Infinity')
      AND x."targetReceived" IS NOT NULL
      AND x."targetReceived" > 0
      AND x."targetReceived"::text NOT IN ('NaN', 'Infinity', '-Infinity')
    )
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
  AND upper(trim(x."targetCurrency")) IN ('USDT', 'VND')
  AND x."targetReceived" IS NOT NULL
  AND x."targetReceived" > 0
  AND x."targetReceived"::text NOT IN ('NaN', 'Infinity', '-Infinity')

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
WHERE x."mode" = 'RUB_USDT_VND'
  AND x."usdtReceived" IS NOT NULL
  AND x."usdtReceived" > 0
  AND x."usdtReceived"::text NOT IN ('NaN', 'Infinity', '-Infinity')

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
WHERE x."mode" = 'RUB_USDT_VND'
  AND x."vndReceived" IS NOT NULL
  AND x."vndReceived" > 0
  AND x."vndReceived"::text NOT IN ('NaN', 'Infinity', '-Infinity')

ON CONFLICT ("sourceKey") DO NOTHING;
