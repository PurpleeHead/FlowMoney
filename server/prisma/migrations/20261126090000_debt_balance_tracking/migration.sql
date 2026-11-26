CREATE TABLE "Debt" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "memberId" TEXT,
  "title" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "originalAmount" DECIMAL(14,2) NOT NULL,
  "remainingAmount" DECIMAL(14,2) NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Debt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DebtTransaction" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "debtId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "amount" DECIMAL(14,2) NOT NULL,
  "balanceChange" DECIMAL(14,2) NOT NULL,
  "date" DATE NOT NULL,
  "reason" TEXT,
  "expenseId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DebtTransaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DebtTransaction_expenseId_key" ON "DebtTransaction"("expenseId");
CREATE INDEX "Debt_userId_isActive_idx" ON "Debt"("userId", "isActive");
CREATE INDEX "Debt_memberId_idx" ON "Debt"("memberId");
CREATE INDEX "DebtTransaction_userId_debtId_date_idx" ON "DebtTransaction"("userId", "debtId", "date");

ALTER TABLE "Debt" ADD CONSTRAINT "Debt_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Debt" ADD CONSTRAINT "Debt_memberId_fkey"
  FOREIGN KEY ("memberId") REFERENCES "HouseholdMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DebtTransaction" ADD CONSTRAINT "DebtTransaction_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DebtTransaction" ADD CONSTRAINT "DebtTransaction_debtId_fkey"
  FOREIGN KEY ("debtId") REFERENCES "Debt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DebtTransaction" ADD CONSTRAINT "DebtTransaction_expenseId_fkey"
  FOREIGN KEY ("expenseId") REFERENCES "LedgerExpense"("id") ON DELETE SET NULL ON UPDATE CASCADE;
