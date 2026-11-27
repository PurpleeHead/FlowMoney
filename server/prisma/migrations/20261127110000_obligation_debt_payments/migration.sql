ALTER TABLE "Obligation" ADD COLUMN "debtId" TEXT;
CREATE INDEX "Obligation_debtId_idx" ON "Obligation"("debtId");
ALTER TABLE "Obligation" ADD CONSTRAINT "Obligation_debtId_fkey"
  FOREIGN KEY ("debtId") REFERENCES "Debt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ObligationPayment" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "occurrenceId" TEXT NOT NULL,
  "amount" DECIMAL(14,2) NOT NULL,
  "paidAt" TIMESTAMP(3) NOT NULL,
  "expenseId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ObligationPayment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ObligationPayment_expenseId_key" ON "ObligationPayment"("expenseId");
CREATE INDEX "ObligationPayment_userId_occurrenceId_paidAt_idx" ON "ObligationPayment"("userId", "occurrenceId", "paidAt");
ALTER TABLE "ObligationPayment" ADD CONSTRAINT "ObligationPayment_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ObligationPayment" ADD CONSTRAINT "ObligationPayment_occurrenceId_fkey"
  FOREIGN KEY ("occurrenceId") REFERENCES "ObligationOccurrence"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ObligationPayment" ADD CONSTRAINT "ObligationPayment_expenseId_fkey"
  FOREIGN KEY ("expenseId") REFERENCES "LedgerExpense"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ObligationPayment" ENABLE ROW LEVEL SECURITY;
