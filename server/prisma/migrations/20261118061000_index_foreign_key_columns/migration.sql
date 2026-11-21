-- Add indexes to the remaining foreign-key columns identified by Supabase Database Advisor.
-- These indexes speed up joins and parent-row updates/deletes as the ledger grows.
CREATE INDEX "BalanceAdjustment_memberId_idx" ON "BalanceAdjustment"("memberId");
CREATE INDEX "Budget_memberId_idx" ON "Budget"("memberId");
CREATE INDEX "Budget_categoryId_idx" ON "Budget"("categoryId");
CREATE INDEX "Expense_receiptId_idx" ON "Expense"("receiptId");
CREATE INDEX "HouseholdInvite_acceptedByUserId_idx" ON "HouseholdInvite"("acceptedByUserId");
CREATE INDEX "HouseholdInvite_memberId_idx" ON "HouseholdInvite"("memberId");
CREATE INDEX "IncomeEntry_memberId_idx" ON "IncomeEntry"("memberId");
CREATE INDEX "IncomeSource_memberId_idx" ON "IncomeSource"("memberId");
CREATE INDEX "LedgerExpense_categoryId_idx" ON "LedgerExpense"("categoryId");
CREATE INDEX "LedgerExpense_memberId_idx" ON "LedgerExpense"("memberId");
CREATE INDEX "Obligation_memberId_idx" ON "Obligation"("memberId");
