import assert from 'node:assert/strict';
import { prisma } from '../../src/services/prisma.js';
import { getDashboardExchangeAggregates } from '../../src/lib/dashboard-aggregates.js';
import {
  calculateObservedVndPerRub,
  calculateObservedVndPerUsdt,
  calculateRubPerUsdt,
  mapDirectVndExchanges,
  mapRubUsdtExchanges,
  mapActualVndUsdtExchanges,
} from '../../src/lib/money.js';

const suffix = `dashboard-aggregate-equivalence-${Date.now()}`;
let userId: string | undefined;
let otherUserId: string | undefined;
let nonFiniteUserId: string | undefined;

function near(actual: number | null, expected: number | null, label: string) {
  if (actual === null || expected === null) {
    assert.equal(actual, expected, label);
    return;
  }
  assert.ok(Math.abs(actual - expected) < 0.000001, `${label}: expected ${expected}, got ${actual}`);
}

function helperCardRateForBudget(expenses: Array<{ amountVnd: unknown; usdtCharged: unknown }>): number | null {
  const valid = expenses.filter(x => x.amountVnd != null && Number(x.amountVnd) > 0 && x.usdtCharged != null && Number(x.usdtCharged) > 0);
  const vnd = valid.reduce((sum, x) => sum + Number(x.amountVnd), 0);
  const usdt = valid.reduce((sum, x) => sum + Number(x.usdtCharged), 0);
  return usdt > 0 ? vnd / usdt : null;
}

try {
  const [user, otherUser, nonFiniteUser] = await Promise.all([
    prisma.user.create({ data: { email: `${suffix}@example.invalid`, passwordHash: 'test-only' } }),
    prisma.user.create({ data: { email: `${suffix}-other@example.invalid`, passwordHash: 'test-only' } }),
    prisma.user.create({ data: { email: `${suffix}-nonfinite@example.invalid`, passwordHash: 'test-only' } }),
  ]);
  userId = user.id;
  otherUserId = otherUser.id;
  nonFiniteUserId = nonFiniteUser.id;
  const mainUserId = user.id;
  const secondUserId = otherUser.id;

  const rows = [
    { mode: 'RUB_USDT_VND', targetCurrency: 'VND', rubSpent: 8300, usdtReceived: 93.7853, vndReceived: 2_300_000 },
    // A direct USDT target can retain stale legacy VND fields; these are not VND outcomes.
    { mode: 'RUB_TARGET', targetCurrency: 'USDT', rubSpent: 5000, targetReceived: 56, vndReceived: 888_888 },
    // Legacy casing/whitespace must behave like the normalized TypeScript helper.
    { mode: 'RUB_TARGET', targetCurrency: ' usdt ', rubSpent: 200, targetReceived: 2 },
    { mode: 'RUB_VND', targetCurrency: 'VND', rubSpent: 1000, vndReceived: 250_000 },
    // Canonical VND must win over a stale legacy vndReceived value.
    { mode: 'RUB_TARGET', targetCurrency: 'VND', rubSpent: 2000, targetReceived: 460_000, targetVndEquivalent: 460_000, vndReceived: 9_999_999 },
    // Legacy direct-target currency values must use the same normalized matching as TypeScript.
    { mode: 'RUB_TARGET', targetCurrency: ' vNd ', rubSpent: 100, targetReceived: 200, targetVndEquivalent: 210, vndReceived: 999_999 },
    // Non-VND target estimates are not factual VND outcomes.
    { mode: 'RUB_TARGET', targetCurrency: 'GEL', rubSpent: 1500, targetReceived: 100, targetToVndRate: 9200, targetVndEquivalent: 920_000, vndReceived: 444_444 },
    // Unknown legacy modes must not contribute stale actual, estimated, or planned amounts.
    { mode: 'LEGACY_UNKNOWN', targetCurrency: 'VND', rubSpent: 4000, usdtReceived: 40, vndReceived: 999_999 },
    { mode: 'LEGACY_UNKNOWN', targetCurrency: 'VND', rubSpent: 500, usdtReceived: 7, vndReceived: null, planningVndPerUsdt: 10_000 },
    // RUB is not a valid target currency and must not be treated as a target valuation.
    { mode: 'RUB_TARGET', targetCurrency: 'RUB', rubSpent: 300, targetReceived: 100, targetVndEquivalent: 12_000 },
    // Planning rate is not an observed VND outcome.
    { mode: 'RUB_USDT_VND', targetCurrency: 'VND', rubSpent: 1000, usdtReceived: 10, vndReceived: null, planningVndPerUsdt: 25_000 },
  ] as const;

  for (const row of rows) {
    await prisma.exchange.create({
      data: {
        userId: mainUserId,
        mode: row.mode,
        targetCurrency: row.targetCurrency,
        rubSpent: row.rubSpent,
        usdtReceived: 'usdtReceived' in row ? row.usdtReceived : null,
        targetReceived: 'targetReceived' in row ? row.targetReceived : null,
        targetToVndRate: 'targetToVndRate' in row ? row.targetToVndRate : null,
        targetVndEquivalent: 'targetVndEquivalent' in row ? row.targetVndEquivalent : null,
        vndReceived: 'vndReceived' in row ? row.vndReceived : null,
        planningVndPerUsdt: 'planningVndPerUsdt' in row ? row.planningVndPerUsdt : null,
      },
    });
  }
  await prisma.exchange.create({
    data: { userId: secondUserId, mode: 'RUB_USDT_VND', targetCurrency: 'VND', rubSpent: 1, usdtReceived: 1, vndReceived: 999_999 },
  });
  // PostgreSQL numeric accepts NaN/Infinity even though the application helpers
  // intentionally reject non-finite JavaScript numbers. Exercise the real DB path.
  const [badIndirect, badDirectUsdt, badDirectVnd, zeroRubActual, negativeRubPlanned] = await Promise.all([
    prisma.exchange.create({ data: {
      userId: nonFiniteUser.id, mode: 'RUB_USDT_VND', targetCurrency: 'VND',
      rubSpent: 100, usdtReceived: 3, vndReceived: 1, planningVndPerUsdt: 25_000,
    } }),
    prisma.exchange.create({ data: {
      userId: nonFiniteUser.id, mode: 'RUB_TARGET', targetCurrency: 'USDT',
      rubSpent: 200, targetReceived: 1, vndReceived: 1,
    } }),
    prisma.exchange.create({ data: {
      userId: nonFiniteUser.id, mode: 'RUB_TARGET', targetCurrency: 'VND',
      rubSpent: 300, targetReceived: 500_000, targetVndEquivalent: 500_000, vndReceived: 1,
    } }),
    prisma.exchange.create({ data: {
      userId: nonFiniteUser.id, mode: 'RUB_USDT_VND', targetCurrency: 'VND',
      rubSpent: 0, usdtReceived: 7, vndReceived: 100_000,
    } }),
    prisma.exchange.create({ data: {
      userId: nonFiniteUser.id, mode: 'RUB_USDT_VND', targetCurrency: 'VND',
      rubSpent: -10, usdtReceived: 5, vndReceived: null, planningVndPerUsdt: 25_000,
    } }),
  ]);
  await prisma.$executeRaw`
    UPDATE "Exchange" SET "vndReceived" = 'NaN'::numeric WHERE "id" = ${badIndirect.id}
  `;
  await prisma.$executeRaw`
    UPDATE "Exchange" SET "targetReceived" = 'NaN'::numeric, "vndReceived" = 'NaN'::numeric
    WHERE "id" = ${badDirectUsdt.id}
  `;
  await prisma.$executeRaw`
    UPDATE "Exchange" SET "targetVndEquivalent" = 'NaN'::numeric, "vndReceived" = 'Infinity'::numeric
    WHERE "id" = ${badDirectVnd.id}
  `;
  const nonFiniteAggregate = await getDashboardExchangeAggregates(nonFiniteUser.id);
  assert.equal(nonFiniteAggregate.exchangeCount, 5);
  near(nonFiniteAggregate.rubUsdtRub, 100, 'non-finite direct USDT receipt cannot contaminate RUB/USDT numerator');
  near(nonFiniteAggregate.rubUsdtUsdt, 3, 'non-finite direct USDT receipt is excluded from RUB/USDT denominator');
  near(nonFiniteAggregate.actualVnd, 0, 'NaN indirect VND is not an actual outcome');
  near(nonFiniteAggregate.actualUsdt, 0, 'invalid actual VND prevents the indirect USDT observation');
  near(nonFiniteAggregate.plannedWeightedVnd, 75_000, 'invalid actual VND falls back to the valid planning estimate');
  near(nonFiniteAggregate.plannedUsdt, 3, 'planning denominator excludes invalid actual values');
  near(nonFiniteAggregate.confirmedVnd, 600_000, 'finite received VND is retained for balance even when the RUB cost basis is invalid');
  near(nonFiniteAggregate.estimatedUsdt, 3, 'invalid actual VND remains an unpriced indirect USDT top-up');
  near(nonFiniteAggregate.rateExchangeRub, 300, 'only finite actual VND observations with a positive RUB basis contribute to rate RUB');
  near(nonFiniteAggregate.rateExchangeVnd, 500_000, 'non-finite VND fields and zero-cost rows cannot poison weighted-rate numerator');
  assert.equal(nonFiniteAggregate.hasUnpricedUsdtTopUp, true);
  for (const [key, value] of Object.entries(nonFiniteAggregate)) {
    if (typeof value === 'number') assert.ok(Number.isFinite(value), `${key} must be finite`);
  }


  await prisma.expense.createMany({
    data: [
      { userId: mainUserId, title: 'Card purchase A', category: 'Food', amount: 55_536, currency: 'VND', amountVnd: 55_536, amountRub: 190, usdtCharged: 2.19, date: new Date('2026-10-10T08:00:00Z') },
      { userId, title: 'Card purchase B', category: 'Food', amount: 40_000, currency: 'VND', amountVnd: 40_000, amountRub: 140, usdtCharged: 1.57, date: new Date('2026-10-11T08:00:00Z') },
      { userId, title: 'Not priced', category: 'Other', amount: 100, currency: 'VND', amountVnd: null, amountRub: null, usdtCharged: null, date: new Date('2026-10-12T08:00:00Z') },
      { userId: secondUserId, title: 'Other user', category: 'Other', amount: 999_999, currency: 'VND', amountVnd: 999_999, amountRub: 1, usdtCharged: 1, date: new Date('2026-10-12T08:00:00Z') },
    ],
  });

  const [exchangeRows, expenseRows, exchangeAggregate, directAggregate, cardAggregate, allExpenseAggregate] = await Promise.all([
    prisma.exchange.findMany({ where: { userId: mainUserId }, orderBy: { createdAt: 'asc' } }),
    prisma.expense.findMany({ where: { userId: mainUserId } }),
    prisma.exchange.aggregate({
      where: { userId: mainUserId, mode: 'RUB_USDT_VND', rubSpent: { gt: 0 }, usdtReceived: { gt: 0 } },
      _sum: { rubSpent: true, usdtReceived: true },
    }),
    prisma.exchange.aggregate({
      where: { userId, mode: 'RUB_VND', rubSpent: { gt: 0 }, vndReceived: { gt: 0 } },
      _sum: { rubSpent: true, vndReceived: true },
    }),
    prisma.expense.aggregate({
      where: { userId: mainUserId, amountVnd: { gt: 0 }, usdtCharged: { gt: 0 } },
      _sum: { amountVnd: true, usdtCharged: true },
    }),
    prisma.expense.aggregate({ where: { userId: mainUserId }, _sum: { amountVnd: true } }),
  ]);

  const postgresAggregates = await getDashboardExchangeAggregates(mainUserId);
  assert.equal(postgresAggregates.exchangeCount, rows.length, 'dashboard aggregate count is scoped to the authenticated user');
  near(postgresAggregates.rubUsdtRub, 14_500, 'aggregate RUB/USDT RUB numerator includes normalized legacy target currencies');
  near(postgresAggregates.rubUsdtUsdt, 161.7853, 'aggregate RUB/USDT USDT denominator includes normalized legacy target currencies');
  near(postgresAggregates.actualVnd, 2_300_000, 'aggregate actual indirect VND');
  near(postgresAggregates.actualUsdt, 93.7853, 'aggregate actual indirect USDT');
  near(postgresAggregates.plannedWeightedVnd, 250_000, 'aggregate planning-rate weighted numerator');
  near(postgresAggregates.plannedUsdt, 10, 'aggregate planning-rate denominator');
  near(postgresAggregates.confirmedVnd, 3_010_210, 'aggregate confirmed VND includes canonical direct-target values and excludes stale non-VND/unknown-mode fields');
  near(postgresAggregates.estimatedTargetVnd, 920_000, 'aggregate non-VND target estimate');
  near(postgresAggregates.estimatedUsdt, 68, 'aggregate USDT requiring VND estimate includes normalized legacy target currencies');
  assert.equal(postgresAggregates.hasUnpricedUsdtTopUp, true, 'aggregate detects top-ups without actual VND outcome');
  assert.equal(postgresAggregates.hasEstimatedTarget, true, 'aggregate detects non-VND target estimates');
  near(postgresAggregates.rateExchangeRub, 11_400, 'weighted VND/RUB rate includes valid direct-target observations only');
  near(postgresAggregates.rateExchangeVnd, 3_010_210, 'weighted VND/RUB numerator excludes stale non-VND/unknown-mode values');

  assert.equal(exchangeRows.length, rows.length, 'all exchange reads must be user-scoped');
  assert.equal(expenseRows.length, 3, 'all expense reads must be user-scoped');
  assert.equal(Number(allExpenseAggregate._sum.amountVnd), 95_536, 'all-time expense total must include only priced expenses owned by this user');

  const [rubUsdtSql] = await prisma.$queryRaw<Array<{ rubTotal: unknown; usdtTotal: unknown }>>`
    SELECT
      COALESCE(SUM(CASE
        WHEN "mode" = 'RUB_USDT_VND' THEN "rubSpent"
        WHEN "mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'USDT' THEN "rubSpent"
        ELSE 0
      END) FILTER (WHERE
        ("mode" = 'RUB_USDT_VND' AND "usdtReceived" > 0 AND "rubSpent" > 0)
        OR ("mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'USDT' AND "targetReceived" > 0 AND "rubSpent" > 0)
      ), 0) AS "rubTotal",
      COALESCE(SUM(CASE
        WHEN "mode" = 'RUB_USDT_VND' THEN "usdtReceived"
        WHEN "mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'USDT' THEN "targetReceived"
        ELSE 0
      END) FILTER (WHERE
        ("mode" = 'RUB_USDT_VND' AND "usdtReceived" > 0 AND "rubSpent" > 0)
        OR ("mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'USDT' AND "targetReceived" > 0 AND "rubSpent" > 0)
      ), 0) AS "usdtTotal"
    FROM "Exchange"
    WHERE "userId" = ${mainUserId}
  `;

  const [budgetBucketsSql] = await prisma.$queryRaw<Array<{ confirmedVnd: unknown; estimatedTargetVnd: unknown; estimatedUsdt: unknown; plannedRate: unknown }>>`
    SELECT
      COALESCE(SUM(CASE
        WHEN "mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'VND'
          THEN COALESCE("targetVndEquivalent", "targetReceived", "vndReceived")
        WHEN "mode" IN ('RUB_VND', 'RUB_USDT_VND') THEN "vndReceived"
        ELSE 0
      END), 0) AS "confirmedVnd",
      COALESCE(SUM(CASE
        WHEN "mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) NOT IN ('VND', 'RUB')
          THEN "targetVndEquivalent"
        ELSE 0
      END), 0) AS "estimatedTargetVnd",
      COALESCE(SUM(CASE
        WHEN "mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'USDT'
          AND "targetReceived" IS NOT NULL AND "targetVndEquivalent" IS NULL
          THEN "targetReceived"
        WHEN "mode" = 'RUB_USDT_VND' AND "vndReceived" IS NULL AND "usdtReceived" IS NOT NULL
          THEN "usdtReceived"
        ELSE 0
      END), 0) AS "estimatedUsdt",
      SUM("usdtReceived" * "planningVndPerUsdt") FILTER (
        WHERE "mode" = 'RUB_USDT_VND'
          AND "rubSpent" > 0
          AND "vndReceived" IS NULL
          AND "usdtReceived" > 0
          AND "planningVndPerUsdt" > 0
      ) / NULLIF(SUM("usdtReceived") FILTER (
        WHERE "mode" = 'RUB_USDT_VND'
          AND "vndReceived" IS NULL
          AND "usdtReceived" > 0
          AND "planningVndPerUsdt" > 0
      ), 0) AS "plannedRate"
    FROM "Exchange"
    WHERE "userId" = ${mainUserId}
  `;

  const [vndRubBucketsSql] = await prisma.$queryRaw<Array<{ exchangeRub: unknown; exchangeVnd: unknown }>>`
    SELECT
      COALESCE(SUM(CASE
        WHEN "mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'VND'
          THEN "rubSpent"
        ELSE "rubSpent"
      END) FILTER (WHERE
        "rubSpent" > 0 AND (
          ("mode" = 'RUB_VND' AND "vndReceived" > 0)
          OR ("mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'VND'
              AND COALESCE("targetVndEquivalent", "targetReceived", "vndReceived") > 0)
          OR ("mode" = 'RUB_USDT_VND' AND "vndReceived" > 0)
        )
      ), 0) AS "exchangeRub",
      COALESCE(SUM(CASE
        WHEN "mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'VND'
          THEN COALESCE("targetVndEquivalent", "targetReceived", "vndReceived")
        ELSE "vndReceived"
      END) FILTER (WHERE
        "rubSpent" > 0 AND (
          ("mode" = 'RUB_VND' AND "vndReceived" > 0)
          OR ("mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'VND'
              AND COALESCE("targetVndEquivalent", "targetReceived", "vndReceived") > 0)
          OR ("mode" = 'RUB_USDT_VND' AND "vndReceived" > 0)
        )
      ), 0) AS "exchangeVnd"
    FROM "Exchange"
    WHERE "userId" = ${mainUserId}
  `;

  const [directTargetSql] = await prisma.$queryRaw<Array<{ totalVnd: unknown }>>`
    SELECT COALESCE(SUM(COALESCE("targetVndEquivalent", "targetReceived", "vndReceived")), 0) AS "totalVnd"
    FROM "Exchange"
    WHERE "userId" = ${mainUserId}
      AND "mode" = 'RUB_TARGET'
      AND upper(trim("targetCurrency")) = 'VND'
      AND COALESCE("targetVndEquivalent", "targetReceived", "vndReceived") > 0
  `;
  const [indirectActualSql] = await prisma.$queryRaw<Array<{ totalVnd: unknown; totalUsdt: unknown }>>`
    SELECT COALESCE(SUM("vndReceived"), 0) AS "totalVnd",
           COALESCE(SUM("usdtReceived"), 0) AS "totalUsdt"
    FROM "Exchange"
    WHERE "userId" = ${mainUserId}
      AND "mode" = 'RUB_USDT_VND'
      AND "vndReceived" > 0
      AND "usdtReceived" > 0
  `;

  assert.equal(Number(budgetBucketsSql.confirmedVnd), 3_010_210, 'confirmed VND bucket includes normalized direct-target VND once and excludes stale legacy value');
  assert.equal(Number(budgetBucketsSql.estimatedTargetVnd), 920_000, 'non-VND target valuation remains in a separate estimate bucket');
  assert.equal(Number(budgetBucketsSql.estimatedUsdt), 68, 'unconverted USDT-only top-ups are isolated for valuation and normalized legacy currencies are included');
  near(Number(budgetBucketsSql.plannedRate), 25_000, 'planning rate is USDT-weighted and isolated from observed rates');

  const helperConfirmedVnd = exchangeRows.reduce((sum, x) => {
    if (x.mode === 'RUB_TARGET' && x.targetCurrency.trim().toUpperCase() === 'VND') {
      const directVnd = x.targetVndEquivalent ?? x.targetReceived ?? x.vndReceived;
      return sum + (directVnd == null ? 0 : Number(directVnd));
    }
    if (x.mode === 'RUB_VND' || x.mode === 'RUB_USDT_VND') {
      return sum + (x.vndReceived == null ? 0 : Number(x.vndReceived));
    }
    return sum;
  }, 0);
  const helperEstimatedTargetVnd = exchangeRows.reduce((sum, x) =>
    sum + (x.mode === 'RUB_TARGET' && !['VND', 'RUB'].includes(x.targetCurrency.trim().toUpperCase()) && x.targetVndEquivalent != null
      ? Number(x.targetVndEquivalent) : 0), 0);
  const eligiblePlanned = exchangeRows.filter(x =>
    x.mode === 'RUB_USDT_VND' && Number(x.rubSpent) > 0 &&
    x.vndReceived == null && x.usdtReceived != null && Number(x.usdtReceived) > 0 &&
    x.planningVndPerUsdt != null && Number(x.planningVndPerUsdt) > 0
  );
  const helperPlannedRate = eligiblePlanned.length
    ? eligiblePlanned.reduce((sum, x) => sum + Number(x.usdtReceived) * Number(x.planningVndPerUsdt), 0) /
      eligiblePlanned.reduce((sum, x) => sum + Number(x.usdtReceived), 0)
    : null;
  assert.equal(Number(budgetBucketsSql.confirmedVnd), helperConfirmedVnd, 'PostgreSQL confirmed budget bucket matches the legacy TypeScript calculation');
  assert.equal(Number(budgetBucketsSql.estimatedTargetVnd), helperEstimatedTargetVnd, 'PostgreSQL estimate bucket matches the legacy TypeScript calculation');
  near(budgetBucketsSql.plannedRate == null ? null : Number(budgetBucketsSql.plannedRate), helperPlannedRate, 'PostgreSQL planning-rate bucket matches the legacy TypeScript calculation');

  const effectiveRateForBudget = helperCardRateForBudget(expenseRows);
  const helperEstimatedUnconvertedVnd = helperEstimatedTargetVnd +
    exchangeRows.reduce((sum, x) => {
      if (x.mode === 'RUB_TARGET' && x.targetCurrency.trim().toUpperCase() === 'USDT' &&
          x.targetReceived != null && x.targetVndEquivalent == null) {
        return sum + Number(x.targetReceived) * (effectiveRateForBudget ?? helperPlannedRate ?? 0);
      }
      if (x.mode === 'RUB_USDT_VND' && x.vndReceived == null && x.usdtReceived != null) {
        return sum + Number(x.usdtReceived) * (effectiveRateForBudget ?? helperPlannedRate ?? 0);
      }
      return sum;
    }, 0);
  const helperBalance = helperConfirmedVnd + helperEstimatedUnconvertedVnd - Number(allExpenseAggregate._sum.amountVnd ?? 0);
  const sqlEstimatedUnconvertedVnd = Number(budgetBucketsSql.estimatedTargetVnd) +
    Number(budgetBucketsSql.estimatedUsdt) * (effectiveRateForBudget ?? helperPlannedRate ?? 0);
  const sqlBalance = Number(budgetBucketsSql.confirmedVnd) + sqlEstimatedUnconvertedVnd -
    Number(allExpenseAggregate._sum.amountVnd ?? 0);
  near(sqlEstimatedUnconvertedVnd, helperEstimatedUnconvertedVnd, 'PostgreSQL estimated VND budget components match the legacy TypeScript calculation');
  near(sqlBalance, helperBalance, 'PostgreSQL confirmed plus estimated balance matches the legacy TypeScript calculation');

  assert.equal(Number(directTargetSql.totalVnd), 460_210, 'PostgreSQL direct-target aggregate normalizes currency and prefers canonical values over stale legacy vndReceived');
  assert.equal(Number(indirectActualSql.totalVnd), 2_300_000, 'PostgreSQL confirmed indirect VND total must exclude planning-only rows');
  assert.equal(Number(indirectActualSql.totalUsdt), 93.7853, 'PostgreSQL confirmed indirect USDT denominator must exclude planning-only rows');

  // Compare PostgreSQL aggregates against the existing helper formulas over the same eligible records.
  const helperRubUsdt = calculateRubPerUsdt(mapRubUsdtExchanges(exchangeRows.map(x => ({
    mode: x.mode,
    rubSpent: Number(x.rubSpent),
    usdtReceived: x.usdtReceived == null ? null : Number(x.usdtReceived),
    targetCurrency: x.targetCurrency,
    targetReceived: x.targetReceived == null ? null : Number(x.targetReceived),
  }))));
  const sqlRubUsdt = Number(rubUsdtSql.rubTotal) / Number(rubUsdtSql.usdtTotal);
  near(Number(rubUsdtSql.rubTotal), 8300 + 5000 + 1000 + 200, 'PostgreSQL RUB/USDT numerator includes all eligible USDT acquisitions, including normalized legacy target currencies');
  near(Number(rubUsdtSql.usdtTotal), 93.7853 + 56 + 10 + 2, 'PostgreSQL RUB/USDT denominator includes all eligible received USDT, even when VND outcome is not yet known');
  near(sqlRubUsdt, helperRubUsdt, 'weighted RUB/USDT rate including direct RUB→USDT target');

  const observedExchangeRows = mapActualVndUsdtExchanges(exchangeRows.map(x => ({
    mode: x.mode,
    rubSpent: Number(x.rubSpent),
    usdtReceived: x.usdtReceived == null ? null : Number(x.usdtReceived),
    vndReceived: x.vndReceived == null ? null : Number(x.vndReceived),
  })));
  assert.deepEqual(observedExchangeRows, [{ usdtReceived: 93.7853, vndReceived: 2_300_000 }], 'only actual indirect exchange outcomes should become observed rate inputs');
  const helperObservedVndUsdt = calculateObservedVndPerUsdt(observedExchangeRows.map(x => ({ amountVnd: x.vndReceived, usdtCharged: x.usdtReceived })));
  near(helperObservedVndUsdt, Number(indirectActualSql.totalVnd) / Number(indirectActualSql.totalUsdt), 'PostgreSQL confirmed VND/USDT aggregate matches the existing helper and excludes planning-only rows');

  const helperVndPerRub = calculateObservedVndPerRub({
    directExchanges: exchangeRows.filter(x => x.mode === 'RUB_VND' || (x.mode === 'RUB_TARGET' && x.targetCurrency.trim().toUpperCase() === 'VND'))
      .map(x => ({
        rubSpent: Number(x.rubSpent),
        vndReceived: x.mode === 'RUB_TARGET'
          ? Number(x.targetVndEquivalent ?? x.targetReceived ?? x.vndReceived ?? 0)
          : Number(x.vndReceived ?? 0),
      })),
    actualVndExchanges: exchangeRows
      .filter(x => x.mode === 'RUB_USDT_VND' && x.vndReceived != null)
      .map(x => ({ rubSpent: Number(x.rubSpent), vndReceived: Number(x.vndReceived) })),
    cardPurchases: expenseRows
      .filter(x => x.amountVnd != null && Number(x.amountVnd) > 0 && x.usdtCharged != null && Number(x.usdtCharged) > 0)
      .map(x => ({ amountVnd: Number(x.amountVnd), usdtCharged: Number(x.usdtCharged) })),
    rubPerUsdt: helperRubUsdt,
  });
  const sqlVndPerRub = (Number(vndRubBucketsSql.exchangeVnd) + Number(cardAggregate._sum.amountVnd)) /
    (Number(vndRubBucketsSql.exchangeRub) + Number(cardAggregate._sum.usdtCharged) * helperRubUsdt!);
  near(sqlVndPerRub, helperVndPerRub, 'PostgreSQL weighted VND/RUB rate matches direct, indirect, and card-purchase TypeScript observations');

  const directRows = mapDirectVndExchanges(exchangeRows.map(x => ({
    mode: x.mode,
    rubSpent: Number(x.rubSpent),
    vndReceived: x.vndReceived == null ? null : Number(x.vndReceived),
    targetReceived: x.targetReceived == null ? null : Number(x.targetReceived),
    targetVndEquivalent: x.targetVndEquivalent == null ? null : Number(x.targetVndEquivalent),
    targetCurrency: x.targetCurrency,
  })));
  const directVndExpected = directRows.reduce((sum, x) => sum + x.vndReceived, 0);
  assert.equal(directVndExpected, 710_210, 'direct VND canonical/fallback values count once, normalize currency, and ignore stale legacy values');
  assert.equal(Number(directTargetSql.totalVnd) + Number(directAggregate._sum.vndReceived), directVndExpected, 'PostgreSQL direct VND aggregate buckets must equal the existing TypeScript mapping');
  assert.equal(Number(directAggregate._sum.vndReceived), 250_000, 'direct RUB→VND aggregate is scoped and includes actual VND only');

  const helperCardRate = calculateObservedVndPerUsdt(expenseRows
    .filter(x => x.amountVnd != null && Number(x.amountVnd) > 0 && x.usdtCharged != null && Number(x.usdtCharged) > 0)
    .map(x => ({ amountVnd: Number(x.amountVnd), usdtCharged: Number(x.usdtCharged) })));
  const sqlCardRate = Number(cardAggregate._sum.amountVnd) / Number(cardAggregate._sum.usdtCharged);
  near(sqlCardRate, helperCardRate, 'weighted card VND/USDT rate');
  assert.equal(Number(cardAggregate._sum.amountVnd), 95_536);
  assert.equal(Number(cardAggregate._sum.usdtCharged), 3.76);

  console.log('Dashboard aggregate fixture passed against disposable PostgreSQL: user scoping, weighted rates, actual-vs-planned VND, direct VND legacy fallback, card totals, and cross-user exclusion.');
} finally {
  if (userId) await prisma.user.deleteMany({ where: { id: userId } });
  if (otherUserId) await prisma.user.deleteMany({ where: { id: otherUserId } });
  if (nonFiniteUserId) await prisma.user.deleteMany({ where: { id: nonFiniteUserId } });
  await prisma.$disconnect();
}
