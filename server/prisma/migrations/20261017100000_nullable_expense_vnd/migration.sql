-- Keep original expense amount/currency even when no reliable VND conversion is known.
ALTER TABLE "Expense" ALTER COLUMN "amountVnd" DROP NOT NULL;
