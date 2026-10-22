import {prisma} from '../services/prisma.js';

type DashboardExchangeAggregate = {
  rubUsdtRub: number; rubUsdtUsdt: number;
  actualVndUsdtVnd: number; actualVndUsdtUsdt: number;
  planningUsdt: number; planningWeightedVnd: number;
  directRub: number; directVnd: number; indirectRub: number; indirectVnd: number;
  confirmedVnd: number; estimatedTargetVnd: number; estimatedUsdt: number;
  hasEstimatedTargetVnd: boolean; hasUnpricedUsdtTopUps: boolean;
};

/** Aggregate all dashboard exchange financial inputs in PostgreSQL without loading full history. */
export async function aggregateDashboardExchanges(userId: string): Promise<DashboardExchangeAggregate> {
  const rows = await prisma.$queryRaw<DashboardExchangeAggregate[]>\`

        SELECT
          COALESCE(SUM(CASE
            WHEN ("mode" = 'RUB_USDT_VND' AND "rubSpent" > 0 AND "usdtReceived" > 0)
              THEN "rubSpent"
            WHEN ("mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'USDT'
              AND "rubSpent" > 0 AND "targetReceived" > 0)
              THEN "rubSpent" ELSE 0 END), 0)::float8 AS "rubUsdtRub",
          COALESCE(SUM(CASE
            WHEN "mode" = 'RUB_USDT_VND' AND "rubSpent" > 0 AND "usdtReceived" > 0
              THEN "usdtReceived"
            WHEN "mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'USDT'
              AND "rubSpent" > 0 AND "targetReceived" > 0
              THEN "targetReceived" ELSE 0 END), 0)::float8 AS "rubUsdtUsdt",
          COALESCE(SUM("vndReceived") FILTER (WHERE "mode" = 'RUB_USDT_VND' AND "vndReceived" > 0 AND "usdtReceived" > 0), 0)::float8 AS "actualVndUsdtVnd",
          COALESCE(SUM("usdtReceived") FILTER (WHERE "mode" = 'RUB_USDT_VND' AND "vndReceived" > 0 AND "usdtReceived" > 0), 0)::float8 AS "actualVndUsdtUsdt",
          COALESCE(SUM("usdtReceived") FILTER (WHERE "mode" <> 'RUB_VND'
            AND NOT ("mode" = 'RUB_TARGET' AND upper(trim(COALESCE("targetCurrency", ''))) = 'VND')
            AND "vndReceived" IS NULL AND "usdtReceived" IS NOT NULL AND "planningVndPerUsdt" IS NOT NULL), 0)::float8 AS "planningUsdt",
          COALESCE(SUM("usdtReceived" * "planningVndPerUsdt") FILTER (WHERE "mode" <> 'RUB_VND'
            AND NOT ("mode" = 'RUB_TARGET' AND upper(trim(COALESCE("targetCurrency", ''))) = 'VND')
            AND "vndReceived" IS NULL AND "usdtReceived" IS NOT NULL AND "planningVndPerUsdt" IS NOT NULL), 0)::float8 AS "planningWeightedVnd",
          COALESCE(SUM("rubSpent") FILTER (WHERE "rubSpent" > 0 AND (
            ("mode" = 'RUB_VND' AND "vndReceived" > 0) OR
            ("mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'VND'
              AND COALESCE("targetVndEquivalent", "targetReceived", "vndReceived") > 0)
          )), 0)::float8 AS "directRub",
          COALESCE(SUM(CASE
            WHEN "mode" = 'RUB_VND' AND "vndReceived" > 0 AND "rubSpent" > 0 THEN "vndReceived"
            WHEN "mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'VND'
              AND "rubSpent" > 0 AND COALESCE("targetVndEquivalent", "targetReceived", "vndReceived") > 0
              THEN COALESCE("targetVndEquivalent", "targetReceived", "vndReceived")
            ELSE 0 END), 0)::float8 AS "directVnd",
          COALESCE(SUM("rubSpent") FILTER (WHERE "mode" <> 'RUB_VND'
            AND NOT ("mode" = 'RUB_TARGET' AND upper(trim(COALESCE("targetCurrency", ''))) = 'VND')
            AND "rubSpent" > 0 AND "vndReceived" > 0), 0)::float8 AS "indirectRub",
          COALESCE(SUM("vndReceived") FILTER (WHERE "mode" <> 'RUB_VND'
            AND NOT ("mode" = 'RUB_TARGET' AND upper(trim(COALESCE("targetCurrency", ''))) = 'VND')
            AND "rubSpent" > 0 AND "vndReceived" > 0), 0)::float8 AS "indirectVnd",
          COALESCE(SUM(CASE WHEN "mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'VND'
            THEN COALESCE("targetVndEquivalent", "targetReceived", "vndReceived")
            ELSE "vndReceived" END), 0)::float8 AS "confirmedVnd",
          COALESCE(SUM("targetVndEquivalent") FILTER (WHERE "mode" = 'RUB_TARGET'
            AND upper(trim(COALESCE("targetCurrency", ''))) <> 'VND' AND "targetVndEquivalent" IS NOT NULL), 0)::float8 AS "estimatedTargetVnd",
          COALESCE(SUM(CASE
            WHEN "mode" <> 'RUB_VND'
              AND NOT ("mode" = 'RUB_TARGET' AND upper(trim(COALESCE("targetCurrency", ''))) = 'VND')
              AND "vndReceived" IS NULL AND (
                ("mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'USDT'
                  AND "targetReceived" IS NOT NULL AND "targetVndEquivalent" IS NULL)
                OR "usdtReceived" IS NOT NULL
              )
              THEN CASE WHEN "mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'USDT'
                THEN "targetReceived" ELSE "usdtReceived" END
            ELSE 0 END), 0)::float8 AS "estimatedUsdt",
          COALESCE(bool_or("mode" = 'RUB_TARGET' AND NOT upper(trim("targetCurrency")) = 'VND'
            AND "targetVndEquivalent" IS NOT NULL), false) AS "hasEstimatedTargetVnd",
          COALESCE(bool_or(
            ("mode" = 'RUB_USDT_VND' AND "vndReceived" IS NULL AND "usdtReceived" IS NOT NULL)
            OR ("mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'USDT'
              AND "targetReceived" IS NOT NULL AND "targetVndEquivalent" IS NULL)
          ), false) AS "hasUnpricedUsdtTopUps"
        FROM "Exchange"
        WHERE "userId" = ${userId}
      
  \`;
  if (!rows[0]) throw new Error('Dashboard exchange aggregate query returned no row.');
  return rows[0];
}
