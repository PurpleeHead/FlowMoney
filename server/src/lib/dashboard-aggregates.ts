import { prisma } from '../services/prisma.js';

export type DashboardExchangeAggregates = {
  exchangeCount: number;
  rubUsdtRub: number;
  rubUsdtUsdt: number;
  actualVnd: number;
  actualUsdt: number;
  plannedWeightedVnd: number;
  plannedUsdt: number;
  confirmedVnd: number;
  estimatedTargetVnd: number;
  estimatedUsdt: number;
  hasUnpricedUsdtTopUp: boolean;
  hasEstimatedTarget: boolean;
  rateExchangeRub: number;
  rateExchangeVnd: number;
};

/**
 * Aggregate all-history exchange accounting in PostgreSQL.
 *
 * Predicates intentionally mirror the existing dashboard/money helpers. Do not
 * add a date window here: recent activity is a separate query concern.
 */
export async function getDashboardExchangeAggregates(userId: string): Promise<DashboardExchangeAggregates> {
  const [row] = await prisma.$queryRaw<Array<{
    exchangeCount: number;
    rubUsdtRub: unknown;
    rubUsdtUsdt: unknown;
    actualVnd: unknown;
    actualUsdt: unknown;
    plannedWeightedVnd: unknown;
    plannedUsdt: unknown;
    confirmedVnd: unknown;
    estimatedTargetVnd: unknown;
    estimatedUsdt: unknown;
    hasUnpricedUsdtTopUp: boolean;
    hasEstimatedTarget: boolean;
    rateExchangeRub: unknown;
    rateExchangeVnd: unknown;
  }>>`
    SELECT
      COUNT(*)::int AS "exchangeCount",
      COALESCE(SUM(CASE
        WHEN "mode" = 'RUB_USDT_VND' AND "rubSpent" > 0 AND "usdtReceived" > 0 THEN "rubSpent"
        WHEN "mode" = 'RUB_TARGET' AND "targetCurrency" = 'USDT' AND "rubSpent" > 0 AND "targetReceived" > 0 THEN "rubSpent"
        ELSE 0
      END), 0) AS "rubUsdtRub",
      COALESCE(SUM(CASE
        WHEN "mode" = 'RUB_USDT_VND' AND "rubSpent" > 0 AND "usdtReceived" > 0 THEN "usdtReceived"
        WHEN "mode" = 'RUB_TARGET' AND "targetCurrency" = 'USDT' AND "rubSpent" > 0 AND "targetReceived" > 0 THEN "targetReceived"
        ELSE 0
      END), 0) AS "rubUsdtUsdt",
      COALESCE(SUM("vndReceived") FILTER (
        WHERE "mode" = 'RUB_USDT_VND' AND "usdtReceived" > 0 AND "vndReceived" > 0
      ), 0) AS "actualVnd",
      COALESCE(SUM("usdtReceived") FILTER (
        WHERE "mode" = 'RUB_USDT_VND' AND "usdtReceived" > 0 AND "vndReceived" > 0
      ), 0) AS "actualUsdt",
      COALESCE(SUM("usdtReceived" * "planningVndPerUsdt") FILTER (
        WHERE "mode" <> 'RUB_VND'
          AND NOT ("mode" = 'RUB_TARGET' AND "targetCurrency" = 'VND')
          AND "vndReceived" IS NULL
          AND "usdtReceived" IS NOT NULL
          AND "planningVndPerUsdt" IS NOT NULL
      ), 0) AS "plannedWeightedVnd",
      COALESCE(SUM("usdtReceived") FILTER (
        WHERE "mode" <> 'RUB_VND'
          AND NOT ("mode" = 'RUB_TARGET' AND "targetCurrency" = 'VND')
          AND "vndReceived" IS NULL
          AND "usdtReceived" IS NOT NULL
          AND "planningVndPerUsdt" IS NOT NULL
      ), 0) AS "plannedUsdt",
      COALESCE(SUM(CASE
        WHEN "mode" = 'RUB_TARGET' AND "targetCurrency" = 'VND'
          THEN COALESCE("targetVndEquivalent", "targetReceived", "vndReceived")
        ELSE "vndReceived"
      END), 0) AS "confirmedVnd",
      COALESCE(SUM("targetVndEquivalent") FILTER (
        WHERE "mode" = 'RUB_TARGET' AND "targetCurrency" <> 'VND' AND "targetVndEquivalent" IS NOT NULL
      ), 0) AS "estimatedTargetVnd",
      COALESCE(SUM(CASE
        WHEN "mode" <> 'RUB_VND'
          AND NOT ("mode" = 'RUB_TARGET' AND "targetCurrency" = 'VND')
          AND "vndReceived" IS NULL
          AND (
            ("mode" = 'RUB_TARGET' AND "targetCurrency" = 'USDT'
              AND "targetReceived" IS NOT NULL AND "targetVndEquivalent" IS NULL)
            OR "usdtReceived" IS NOT NULL
          )
        THEN CASE
          WHEN "mode" = 'RUB_TARGET' AND "targetCurrency" = 'USDT' THEN COALESCE("targetReceived", 0)
          ELSE "usdtReceived"
        END
        ELSE 0
      END), 0) AS "estimatedUsdt",
      COALESCE(BOOL_OR(
        ("mode" = 'RUB_USDT_VND' AND "vndReceived" IS NULL AND "usdtReceived" IS NOT NULL)
        OR ("mode" = 'RUB_TARGET' AND "targetCurrency" = 'USDT'
          AND "targetReceived" IS NOT NULL AND "targetVndEquivalent" IS NULL)
      ), false) AS "hasUnpricedUsdtTopUp",
      COALESCE(BOOL_OR(
        "mode" = 'RUB_TARGET' AND "targetCurrency" <> 'VND' AND "targetVndEquivalent" IS NOT NULL
      ), false) AS "hasEstimatedTarget",
      COALESCE(SUM("rubSpent") FILTER (WHERE
        "rubSpent" > 0 AND (
          ("mode" = 'RUB_VND' AND "vndReceived" > 0)
          OR ("mode" = 'RUB_TARGET' AND "targetCurrency" = 'VND'
            AND COALESCE("targetVndEquivalent", "targetReceived", "vndReceived") > 0)
          OR ("mode" <> 'RUB_VND'
            AND NOT ("mode" = 'RUB_TARGET' AND "targetCurrency" = 'VND')
            AND "vndReceived" > 0)
        )
      ), 0) AS "rateExchangeRub",
      COALESCE(SUM(CASE
        WHEN "mode" = 'RUB_TARGET' AND "targetCurrency" = 'VND'
          THEN COALESCE("targetVndEquivalent", "targetReceived", "vndReceived")
        ELSE "vndReceived"
      END) FILTER (WHERE
        "rubSpent" > 0 AND (
          ("mode" = 'RUB_VND' AND "vndReceived" > 0)
          OR ("mode" = 'RUB_TARGET' AND "targetCurrency" = 'VND'
            AND COALESCE("targetVndEquivalent", "targetReceived", "vndReceived") > 0)
          OR ("mode" <> 'RUB_VND'
            AND NOT ("mode" = 'RUB_TARGET' AND "targetCurrency" = 'VND')
            AND "vndReceived" > 0)
        )
      ), 0) AS "rateExchangeVnd"
    FROM "Exchange"
    WHERE "userId" = ${userId}
  `;

  const value = (input: unknown) => Number(input ?? 0);
  return {
    exchangeCount: Number(row.exchangeCount),
    rubUsdtRub: value(row.rubUsdtRub),
    rubUsdtUsdt: value(row.rubUsdtUsdt),
    actualVnd: value(row.actualVnd),
    actualUsdt: value(row.actualUsdt),
    plannedWeightedVnd: value(row.plannedWeightedVnd),
    plannedUsdt: value(row.plannedUsdt),
    confirmedVnd: value(row.confirmedVnd),
    estimatedTargetVnd: value(row.estimatedTargetVnd),
    estimatedUsdt: value(row.estimatedUsdt),
    hasUnpricedUsdtTopUp: row.hasUnpricedUsdtTopUp,
    hasEstimatedTarget: row.hasEstimatedTarget,
    rateExchangeRub: value(row.rateExchangeRub),
    rateExchangeVnd: value(row.rateExchangeVnd),
  };
}
