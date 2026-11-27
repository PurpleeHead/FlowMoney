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
