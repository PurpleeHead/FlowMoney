-- Preserve payment-level history for occurrences created before ObligationPayment existed.
-- Old releases linked a single ledger expense directly from ObligationOccurrence.expenseId.
INSERT INTO "ObligationPayment" ("id", "userId", "occurrenceId", "amount", "paidAt", "expenseId", "createdAt")
SELECT
  md5('obligation-payment:' || expense."id"),
  occurrence."userId",
  occurrence."id",
  COALESCE(occurrence."actualAmount", expense."amount"),
  COALESCE(occurrence."paidAt", expense."createdAt"),
  expense."id",
  expense."createdAt"
FROM "ObligationOccurrence" AS occurrence
JOIN "LedgerExpense" AS expense
  ON expense."id" = occurrence."expenseId"
WHERE occurrence."expenseId" IS NOT NULL
ON CONFLICT ("expenseId") DO NOTHING;

-- Earlier releases could mark an occurrence PAID after recording only part of its planned amount.
-- Restore the correct PARTIAL state so the outstanding balance remains in forecasts.
UPDATE "ObligationOccurrence" AS occurrence
SET
  "status" = 'PARTIAL',
  "actualAmount" = COALESCE(occurrence."actualAmount", expense."amount"),
  "paidAt" = NULL
FROM "LedgerExpense" AS expense
WHERE occurrence."expenseId" = expense."id"
  AND occurrence."status" = 'PAID'
  AND COALESCE(occurrence."actualAmount", expense."amount") + 0.000001 < occurrence."plannedAmount";

UPDATE "ObligationOccurrence"
SET "status" = 'PARTIAL', "paidAt" = NULL
WHERE "status" = 'PAID'
  AND "actualAmount" IS NOT NULL
  AND "actualAmount" + 0.000001 < "plannedAmount";
