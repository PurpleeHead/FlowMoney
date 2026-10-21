import { Prisma } from '@prisma/client';
import { prisma } from '../services/prisma.js';

/**
 * Raw, date-scoped numerators and denominators for historical expense valuation.
 *
 * Keep this helper separate from dashboard all-history aggregates. Callers must
 * continue to use the established money helpers to apply validity/overflow rules.
 * The PostgreSQL equivalence fixture verifies aggregate sums against legacy mappings.
 */
export type DateAwareValuationAggregate = {
  rubUsdtRub: unknown;
  rubUsdtUsdt: unknown;
  actualVnd: unknown;
  actualUsdt: unknown;
  directRub: unknown;
  directVnd: unknown;
  actualRubForVnd: unknown;
  actualVndForRub: unknown;
  cardVnd: unknown;
  cardUsdt: unknown;
};

export async function getDateAwareValuationAggregate(
  userId: string,
  valuationDate: Date,
): Promise<DateAwareValuationAggregate> {
  const [row] = await prisma.$queryRaw<DateAwareValuationAggregate[]>(Prisma.sql`
    WITH exchange_totals AS (
      SELECT
        COALESCE(SUM("rubSpent") FILTER (WHERE
          "rubSpent" > 0 AND (
            ("mode" = 'RUB_USDT_VND' AND "usdtReceived" > 0)
            OR ("mode" = 'RUB_TARGET'
              AND upper(trim("targetCurrency")) = 'USDT'
              AND "targetReceived" > 0)
          )
        ), 0) AS "rubUsdtRub",
        COALESCE(SUM(CASE
          WHEN "mode" = 'RUB_USDT_VND' AND "rubSpent" > 0 AND "usdtReceived" > 0 THEN "usdtReceived"
          WHEN "mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'USDT'
            AND "rubSpent" > 0 AND "targetReceived" > 0 THEN "targetReceived"
          ELSE 0
        END), 0) AS "rubUsdtUsdt",
        COALESCE(SUM("vndReceived") FILTER (WHERE
          "mode" = 'RUB_USDT_VND' AND "usdtReceived" > 0 AND "vndReceived" > 0
        ), 0) AS "actualVnd",
        COALESCE(SUM("usdtReceived") FILTER (WHERE
          "mode" = 'RUB_USDT_VND' AND "usdtReceived" > 0 AND "vndReceived" > 0
        ), 0) AS "actualUsdt",
        COALESCE(SUM("rubSpent") FILTER (WHERE
          "rubSpent" > 0 AND (
            ("mode" = 'RUB_VND' AND "vndReceived" > 0)
            OR ("mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'VND'
              AND COALESCE("targetVndEquivalent", "targetReceived", "vndReceived") > 0)
          )
        ), 0) AS "directRub",
        COALESCE(SUM(CASE
          WHEN "mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'VND'
            THEN COALESCE("targetVndEquivalent", "targetReceived", "vndReceived")
          WHEN "mode" = 'RUB_VND' THEN "vndReceived"
          ELSE 0
        END) FILTER (WHERE
          ("mode" = 'RUB_VND' AND "rubSpent" > 0 AND "vndReceived" > 0)
          OR ("mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'VND'
            AND "rubSpent" > 0
            AND COALESCE("targetVndEquivalent", "targetReceived", "vndReceived") > 0)
        ), 0) AS "directVnd",
        COALESCE(SUM("rubSpent") FILTER (WHERE
          "rubSpent" > 0 AND "vndReceived" > 0
          AND "mode" <> 'RUB_VND'
          AND NOT ("mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'VND')
        ), 0) AS "actualRubForVnd",
        COALESCE(SUM("vndReceived") FILTER (WHERE
          "rubSpent" > 0 AND "vndReceived" > 0
          AND "mode" <> 'RUB_VND'
          AND NOT ("mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'VND')
        ), 0) AS "actualVndForRub"
      FROM "Exchange"
      WHERE "userId" = ${userId} AND "createdAt" <= ${valuationDate}
    ),
    card_totals AS (
      SELECT
        COALESCE(SUM("amountVnd") FILTER (WHERE "amountVnd" > 0 AND "usdtCharged" > 0), 0) AS "cardVnd",
        COALESCE(SUM("usdtCharged") FILTER (WHERE "amountVnd" > 0 AND "usdtCharged" > 0), 0) AS "cardUsdt"
      FROM "Expense"
      WHERE "userId" = ${userId}
        AND "date" <= ${valuationDate}
        AND "usdtCharged" IS NOT NULL
    )
    SELECT exchange_totals.*, card_totals.*
    FROM exchange_totals CROSS JOIN card_totals
  `);
  if (!row) {
    throw new Error('Date-aware valuation aggregate returned no row.');
  }
  return row;
}
