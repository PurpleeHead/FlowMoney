-- VND is not known at the time of a RUB -> USDT exchange. Keep those values nullable
-- until an optional estimate or an actual card purchase provides an observed rate.
ALTER TABLE "Exchange" ALTER COLUMN "vndPerUsdt" DROP NOT NULL;
ALTER TABLE "Exchange" ALTER COLUMN "vndReceived" DROP NOT NULL;
ALTER TABLE "Exchange" ALTER COLUMN "effectiveVndPerRub" DROP NOT NULL;

-- The amount actually debited from the card in USDT lets us calculate an observed
-- weighted-average VND/USDT rate from real purchases.
ALTER TABLE "Expense" ADD COLUMN "usdtCharged" DECIMAL(20,8);
