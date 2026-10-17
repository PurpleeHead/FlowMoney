-- Forward-only additive migration. Do not apply to any database without explicit approval.
CREATE TABLE "WalletMovement" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "amountDelta" DECIMAL(20,8) NOT NULL,
  "kind" TEXT NOT NULL,
  "sourceKey" TEXT NOT NULL,
  "note" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WalletMovement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WalletMovement_sourceKey_key" ON "WalletMovement"("sourceKey");
CREATE INDEX "WalletMovement_userId_currency_occurredAt_idx" ON "WalletMovement"("userId", "currency", "occurredAt");
CREATE INDEX "WalletMovement_userId_kind_currency_idx" ON "WalletMovement"("userId", "kind", "currency");

ALTER TABLE "WalletMovement"
ADD CONSTRAINT "WalletMovement_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
