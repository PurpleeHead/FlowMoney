ALTER TABLE "Exchange"
  ADD COLUMN "targetCurrency" TEXT NOT NULL DEFAULT 'VND',
  ADD COLUMN "targetReceived" DECIMAL(20, 8),
  ADD COLUMN "targetToVndRate" DECIMAL(20, 8),
  ADD COLUMN "targetVndEquivalent" DECIMAL(20, 4);
