import { Prisma } from '@prisma/client';
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
type DashboardExchangeAggregateRow = {
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
};

function dashboardExchangeAggregateQuery(userId: string) {
  return Prisma.sql`
    WITH "scopedExchange" AS (
      SELECT
        "Exchange".*,
        CASE WHEN "rubSpent"::text NOT IN ('NaN', 'Infinity', '-Infinity') THEN "rubSpent" END AS "safeRubSpent",
        CASE WHEN "usdtReceived" IS NOT NULL AND "usdtReceived"::text NOT IN ('NaN', 'Infinity', '-Infinity') THEN "usdtReceived" END AS "safeUsdtReceived",
        CASE WHEN "targetReceived" IS NOT NULL AND "targetReceived"::text NOT IN ('NaN', 'Infinity', '-Infinity') THEN "targetReceived" END AS "safeTargetReceived",
        CASE WHEN "vndReceived" IS NOT NULL AND "vndReceived"::text NOT IN ('NaN', 'Infinity', '-Infinity') THEN "vndReceived" END AS "safeVndReceived",
        CASE WHEN "targetVndEquivalent" IS NOT NULL AND "targetVndEquivalent"::text NOT IN ('NaN', 'Infinity', '-Infinity') THEN "targetVndEquivalent" END AS "safeTargetVndEquivalent",
        CASE WHEN "planningVndPerUsdt" IS NOT NULL AND "planningVndPerUsdt"::text NOT IN ('NaN', 'Infinity', '-Infinity') THEN "planningVndPerUsdt" END AS "safePlanningVndPerUsdt"
      FROM "Exchange"
      WHERE "userId" = ${userId}
    )
    SELECT
      COUNT(*)::int AS "exchangeCount",
      COALESCE(SUM(CASE
        WHEN "mode" = 'RUB_USDT_VND' AND "safeRubSpent" > 0 AND "safeUsdtReceived" > 0 THEN "safeRubSpent"
        WHEN "mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'USDT' AND "safeRubSpent" > 0 AND "safeTargetReceived" > 0 THEN "safeRubSpent"
        ELSE 0
      END), 0) AS "rubUsdtRub",
      COALESCE(SUM(CASE
        WHEN "mode" = 'RUB_USDT_VND' AND "safeRubSpent" > 0 AND "safeUsdtReceived" > 0 THEN "safeUsdtReceived"
        WHEN "mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'USDT' AND "safeRubSpent" > 0 AND "safeTargetReceived" > 0 THEN "safeTargetReceived"
        ELSE 0
      END), 0) AS "rubUsdtUsdt",
      COALESCE(SUM("safeVndReceived") FILTER (
        WHERE "mode" = 'RUB_USDT_VND'
          AND "safeRubSpent" > 0 AND "safeUsdtReceived" > 0 AND "safeVndReceived" > 0
      ), 0) AS "actualVnd",
      COALESCE(SUM("safeUsdtReceived") FILTER (
        WHERE "mode" = 'RUB_USDT_VND'
          AND "safeRubSpent" > 0 AND "safeUsdtReceived" > 0 AND "safeVndReceived" > 0
      ), 0) AS "actualUsdt",
      COALESCE(SUM("safeUsdtReceived" * "safePlanningVndPerUsdt") FILTER (
        WHERE "mode" = 'RUB_USDT_VND'
          AND "safeRubSpent" > 0
          AND "safeVndReceived" IS NULL
          AND "safeUsdtReceived" > 0
          AND "safePlanningVndPerUsdt" > 0
      ), 0) AS "plannedWeightedVnd",
      COALESCE(SUM("safeUsdtReceived") FILTER (
        WHERE "mode" = 'RUB_USDT_VND'
          AND "safeRubSpent" > 0
          AND "safeVndReceived" IS NULL
          AND "safeUsdtReceived" > 0
          AND "safePlanningVndPerUsdt" > 0
      ), 0) AS "plannedUsdt",
      -- Only documented modes are VND evidence; other modes may retain stale legacy vndReceived.
      COALESCE(SUM(CASE
        WHEN "mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'VND'
          THEN COALESCE("safeTargetVndEquivalent", "safeTargetReceived", "safeVndReceived")
        WHEN "mode" IN ('RUB_VND', 'RUB_USDT_VND') THEN "safeVndReceived"
        ELSE 0
      END), 0) AS "confirmedVnd",
      COALESCE(SUM("safeTargetVndEquivalent") FILTER (
        WHERE "mode" = 'RUB_TARGET'
          AND upper(trim("targetCurrency")) NOT IN ('VND', 'RUB')
          AND "safeTargetVndEquivalent" IS NOT NULL
      ), 0) AS "estimatedTargetVnd",
      -- A direct USDT receipt remains unpriced even if vndReceived contains a stale legacy value.
      COALESCE(SUM(CASE
        WHEN "mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'USDT'
          AND "safeRubSpent" > 0 AND "safeTargetReceived" > 0 AND "safeTargetVndEquivalent" IS NULL
          THEN "safeTargetReceived"
        WHEN "mode" = 'RUB_USDT_VND' AND "safeRubSpent" > 0
          AND "safeVndReceived" IS NULL AND "safeUsdtReceived" > 0
          THEN "safeUsdtReceived"
        ELSE 0
      END), 0) AS "estimatedUsdt",
      COALESCE(BOOL_OR(
        ("mode" = 'RUB_USDT_VND' AND "safeRubSpent" > 0 AND "safeVndReceived" IS NULL AND "safeUsdtReceived" > 0)
        OR ("mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'USDT'
          AND "safeRubSpent" > 0 AND "safeTargetReceived" > 0 AND "safeTargetVndEquivalent" IS NULL)
      ), false) AS "hasUnpricedUsdtTopUp",
      COALESCE(BOOL_OR(
        "mode" = 'RUB_TARGET'
          AND upper(trim("targetCurrency")) NOT IN ('VND', 'RUB')
          AND "safeTargetVndEquivalent" IS NOT NULL
      ), false) AS "hasEstimatedTarget",
      COALESCE(SUM("safeRubSpent") FILTER (WHERE
        "safeRubSpent" > 0 AND (
          ("mode" = 'RUB_VND' AND "safeVndReceived" > 0)
          OR ("mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'VND'
            AND COALESCE("safeTargetVndEquivalent", "safeTargetReceived", "safeVndReceived") > 0)
          OR ("mode" = 'RUB_USDT_VND' AND "safeVndReceived" > 0)
        )
      ), 0) AS "rateExchangeRub",
      COALESCE(SUM(CASE
        WHEN "mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'VND'
          THEN COALESCE("safeTargetVndEquivalent", "safeTargetReceived", "safeVndReceived")
        ELSE "safeVndReceived"
      END) FILTER (WHERE
        "safeRubSpent" > 0 AND (
          ("mode" = 'RUB_VND' AND "safeVndReceived" > 0)
          OR ("mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'VND'
            AND COALESCE("safeTargetVndEquivalent", "safeTargetReceived", "safeVndReceived") > 0)
          OR ("mode" = 'RUB_USDT_VND' AND "safeVndReceived" > 0)
        )
      ), 0) AS "rateExchangeVnd"
    FROM "scopedExchange"
  `;
}

export async function explainDashboardExchangeAggregates(userId: string): Promise<unknown> {
  const [row] = await prisma.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(
    Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${dashboardExchangeAggregateQuery(userId)}`,
  );
  return row?.['QUERY PLAN'] ?? null;
}

export async function getDashboardExchangeAggregates(userId: string): Promise<DashboardExchangeAggregates> {
  const [row] = await prisma.$queryRaw<DashboardExchangeAggregateRow[]>(
    dashboardExchangeAggregateQuery(userId),
  );
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
