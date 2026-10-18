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
  'backfill-direct-vnd', 'backfill-test-user', 'RUB_VND', 'VND', 30000,
  1000, 30000, CURRENT_TIMESTAMP
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
