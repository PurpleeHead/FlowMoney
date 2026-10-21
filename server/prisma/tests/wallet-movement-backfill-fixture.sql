-- Disposable PostgreSQL smoke fixture for the wallet movement backfill.
-- Run only against the CI-created flowmoney_test database.
INSERT INTO "User" ("id", "email", "passwordHash", "createdAt", "updatedAt")
VALUES ('backfill-test-user', 'backfill-test@example.invalid', 'not-a-real-password-hash', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

INSERT INTO "Expense" (
  "id", "userId", "title", "category", "amount", "currency",
  "amountVnd", "amountRub", "usdtCharged", "date", "createdAt", "updatedAt"
) VALUES
  ('backfill-card-expense', 'backfill-test-user', 'Card purchase', 'food', 55536, 'VND',
   55536, NULL, 2.19, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('backfill-rub-expense', 'backfill-test-user', 'Cash purchase', 'other', 100, 'RUB',
   NULL, 100, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

INSERT INTO "Exchange" (
  "id", "userId", "mode", "targetCurrency", "targetReceived", "rubSpent",
  "usdtReceived", "vndPerUsdt", "vndFee", "vndReceived",
  "effectiveVndPerRub", "effectiveRubPerUsdt", "createdAt"
) VALUES (
  'backfill-exchange', 'backfill-test-user', 'RUB_USDT_VND', 'VND', 250000,
  8300, 93.7853, 2665, 0, 250000, 30.1204, 88.5018, CURRENT_TIMESTAMP
);

-- Unknown VND outcome: only the known RUB outflow and USDT inflow should be backfilled.
INSERT INTO "Exchange" (
  "id", "userId", "mode", "targetCurrency", "rubSpent", "usdtReceived", "createdAt"
) VALUES (
  'backfill-unknown-vnd', 'backfill-test-user', 'RUB_USDT_VND', 'VND', 500, 5, CURRENT_TIMESTAMP
);

-- Direct RUB -> VND exchange: known RUB outflow and VND inflow, no USDT movement.
INSERT INTO "Exchange" (
  "id", "userId", "mode", "targetCurrency", "targetReceived", "rubSpent",
  "vndReceived", "createdAt"
) VALUES (
  'backfill-direct-vnd', 'backfill-test-user', 'RUB_VND', 'VND', 32000,
  1000, 30000, CURRENT_TIMESTAMP
);

-- Explicit zero VND outcome: do not fall back to a positive legacy targetReceived.
-- The RUB debit remains valid, but the VND credit must be absent.
INSERT INTO "Exchange" (
  "id", "userId", "mode", "targetCurrency", "targetReceived", "rubSpent",
  "vndReceived", "createdAt"
) VALUES (
  'backfill-zero-vnd', 'backfill-test-user', 'RUB_VND', 'VND', 50000,
  300, 0, CURRENT_TIMESTAMP
);

-- Simulate an already-synchronized row: the migration must preserve, not duplicate it.
INSERT INTO "WalletMovement" (
  "id", "userId", "currency", "amountDelta", "kind", "sourceKey", "note", "occurredAt"
) VALUES (
  'backfill-existing-card-row', 'backfill-test-user', 'USDT', -2.19, 'EXPENSE',
  'expense:backfill-card-expense:USDT', 'Existing synchronized row', CURRENT_TIMESTAMP
);

-- Legacy-invalid RUB -> RUB target record: retain the RUB outflow but never credit RUB back.
INSERT INTO "Exchange" (
  "id", "userId", "mode", "targetCurrency", "targetReceived", "rubSpent", "createdAt"
) VALUES (
  'backfill-invalid-rub-target', 'backfill-test-user', 'RUB_TARGET', 'RUB', 100, 200, CURRENT_TIMESTAMP
);
-- A stale USDT card-debit field on a RUB expense must not change its currency.
INSERT INTO "Expense" (
  "id", "userId", "title", "category", "amount", "currency",
  "amountVnd", "amountRub", "usdtCharged", "date", "createdAt", "updatedAt"
) VALUES (
  'backfill-stale-card-rub', 'backfill-test-user', 'Legacy RUB expense with stale card field',
  'test', 200, 'RUB', NULL, 200, 3.5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);

-- A present but invalid card debit on a VND expense is malformed, not a cash fallback.
INSERT INTO "Expense" (
  "id", "userId", "title", "category", "amount", "currency",
  "amountVnd", "usdtCharged", "date", "createdAt", "updatedAt"
) VALUES (
  'backfill-invalid-card-vnd', 'backfill-test-user', 'Legacy VND expense with invalid card debit',
  'test', 1000, 'VND', 1000, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);

-- A valid recorded USDT debit remains authoritative even if the separate legacy
-- VND basis is malformed; runtime ledger sync still emits the known USDT movement.
INSERT INTO "Expense" (
  "id", "userId", "title", "category", "amount", "currency",
  "amountVnd", "usdtCharged", "date", "createdAt", "updatedAt"
) VALUES (
  'backfill-card-invalid-vnd-basis', 'backfill-test-user', 'Card expense with malformed VND basis',
  'test', 'NaN'::numeric, 'VND', 'NaN'::numeric, 1.5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);

-- Unknown exchange modes preserve only the known RUB outflow; stale USDT/VND fields are not credits.
INSERT INTO "Exchange" (
  "id", "userId", "mode", "targetCurrency", "rubSpent", "usdtReceived", "vndReceived", "createdAt"
) VALUES (
  'backfill-unknown-mode', 'backfill-test-user', 'LEGACY_UNKNOWN', 'VND',
  300, 9, 40000, CURRENT_TIMESTAMP
);

-- If net VND is unknown and a fee is present, the gross legacy amount is not a wallet credit.
INSERT INTO "Exchange" (
  "id", "userId", "mode", "targetCurrency", "targetReceived", "rubSpent",
  "vndFee", "vndReceived", "createdAt"
) VALUES (
  'backfill-fee-net-unknown', 'backfill-test-user', 'RUB_VND', 'VND',
  50000, 400, 1000, NULL, CURRENT_TIMESTAMP
);
