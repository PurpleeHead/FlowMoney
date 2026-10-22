import assert from 'node:assert/strict';
import { prisma } from '../../src/services/prisma.js';
import { aggregateDashboardExchanges } from '../../src/lib/dashboard-exchange-aggregate.js';
import {
  calculateObservedVndPerUsdt,
  calculateObservedVndPerRub,
  calculateRubPerUsdt,
  mapDirectVndExchanges,
  mapRubUsdtExchanges,
  mapActualVndUsdtExchanges,
} from '../../src/lib/money.js';

const suffix = `dashboard-aggregate-equivalence-${Date.now()}`;
let userId: string | undefined;
let otherUserId: string | undefined;

function near(actual: number | null, expected: number | null, label: string) {
  if (actual === null || expected === null) {
    assert.equal(actual, expected, label);
    return;
  }
  assert.ok(Math.abs(actual - expected) < 0.000001, `${label}: expected ${expected}, got ${actual}`);
}

try {
  const [user, otherUser] = await Promise.all([
    prisma.user.create({ data: { email: `${suffix}@example.invalid`, passwordHash: 'test-only' } }),
    prisma.user.create({ data: { email: `${suffix}-other@example.invalid`, passwordHash: 'test-only' } }),
  ]);
  userId = user.id;
  otherUserId = otherUser.id;
  const mainUserId = user.id;
  const secondUserId = otherUser.id;

  const rows = [
    { mode: 'RUB_USDT_VND', targetCurrency: 'VND', rubSpent: 8300, usdtReceived: 93.7853, vndReceived: 2_300_000 },
    { mode: 'RUB_TARGET', targetCurrency: 'USDT', rubSpent: 5000, targetReceived: 56 },
    { mode: 'RUB_VND', targetCurrency: 'VND', rubSpent: 1000, vndReceived: 250_000 },
    // Canonical VND must win over a stale legacy vndReceived value.
    // Stale USDT values on direct VND targets must not be counted as USDT acquisitions.
    { mode: 'RUB_TARGET', targetCurrency: 'VND', rubSpent: 2000, targetReceived: 460_000, targetVndEquivalent: 460_000, vndReceived: 9_999_999, usdtReceived: 999 },
    // An explicit zero net outcome must not fall back to the positive gross target.
    { mode: 'RUB_TARGET', targetCurrency: 'VND', rubSpent: 1800, targetReceived: 350_000, targetVndEquivalent: 0, vndReceived: 345_000 },
    // Legacy/corrupt casing and whitespace must still classify as a direct VND target.
    { mode: 'RUB_TARGET', targetCurrency: ' vnd ', rubSpent: 900, targetReceived: 125_000, targetVndEquivalent: null, vndReceived: 777_777 },
    // Non-VND target estimates are not factual VND outcomes.
    // A different target's stale USDT field must not contaminate the RUB/USDT weighted rate.
    { mode: 'RUB_TARGET', targetCurrency: 'GEL', rubSpent: 1500, targetReceived: 100, targetToVndRate: 9200, targetVndEquivalent: 920_000, usdtReceived: 888 },
    // Planning rate is not an observed VND outcome.
    { mode: 'RUB_USDT_VND', targetCurrency: 'VND', rubSpent: 1000, usdtReceived: 10, vndReceived: null, planningVndPerUsdt: 25_000 },
    // A legacy target with a missing currency still contributes its explicit VND estimate.
    { mode: 'RUB_TARGET', targetCurrency: '', rubSpent: 500, targetReceived: 2, targetVndEquivalent: 3_000 },
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

  assert.equal(exchangeRows.length, rows.length, 'all exchange reads must be user-scoped');
  assert.equal(expenseRows.length, 3, 'all expense reads must be user-scoped');
  assert.equal(Number(allExpenseAggregate._sum.amountVnd), 95_536, 'all-time expense total must include only priced expenses owned by this user');

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
  assert.equal(Number(directTargetSql.totalVnd), 585_000, 'PostgreSQL direct-target aggregate must normalize target currency and prefer canonical/fallback values over stale legacy vndReceived');
  assert.equal(Number(indirectActualSql.totalVnd), 2_300_000, 'PostgreSQL confirmed indirect VND total must exclude planning-only rows');
  assert.equal(Number(indirectActualSql.totalUsdt), 93.7853, 'PostgreSQL confirmed indirect USDT denominator must exclude planning-only rows');

  // Budget and planning aggregates must preserve the route's bucket semantics too.
  const [budgetSql] = await prisma.$queryRaw<Array<{
    confirmedVnd: unknown;
    estimatedTargetVnd: unknown;
    plannedUsdt: unknown;
    plannedWeightedVnd: unknown;
    estimatedUsdt: unknown;
    unpricedUsdtCount: unknown;
  }>>`
    SELECT
      COALESCE(SUM(CASE
        WHEN "mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'VND'
          THEN COALESCE("targetVndEquivalent", "targetReceived", "vndReceived")
        ELSE "vndReceived"
      END), 0) AS "confirmedVnd",
      COALESCE(SUM(CASE
        WHEN "mode" = 'RUB_TARGET' AND upper(trim(COALESCE("targetCurrency", ''))) <> 'VND'
          THEN "targetVndEquivalent"
        ELSE 0
      END), 0) AS "estimatedTargetVnd",
      COALESCE(SUM(CASE
        WHEN "mode" <> 'RUB_VND'
          AND NOT ("mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'VND')
          AND "vndReceived" IS NULL
          AND "usdtReceived" IS NOT NULL
          AND "planningVndPerUsdt" IS NOT NULL
          THEN "usdtReceived" ELSE 0
      END), 0) AS "plannedUsdt",
      COALESCE(SUM(CASE
        WHEN "mode" <> 'RUB_VND'
          AND NOT ("mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'VND')
          AND "vndReceived" IS NULL
          AND "usdtReceived" IS NOT NULL
          AND "planningVndPerUsdt" IS NOT NULL
          THEN "usdtReceived" * "planningVndPerUsdt" ELSE 0
      END), 0) AS "plannedWeightedVnd",
      COALESCE(SUM(CASE
        WHEN "mode" <> 'RUB_VND'
          AND NOT ("mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'VND')
          AND "vndReceived" IS NULL
          AND (
            ("mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'USDT'
              AND "targetReceived" IS NOT NULL AND "targetVndEquivalent" IS NULL)
            OR "usdtReceived" IS NOT NULL
          )
          THEN CASE WHEN "mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'USDT'
            THEN "targetReceived" ELSE "usdtReceived" END
        ELSE 0
      END), 0) AS "estimatedUsdt",
      COUNT(*) FILTER (WHERE
        ("mode" = 'RUB_USDT_VND' AND "vndReceived" IS NULL AND "usdtReceived" IS NOT NULL)
        OR ("mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'USDT'
          AND "targetReceived" IS NOT NULL AND "targetVndEquivalent" IS NULL)
      ) AS "unpricedUsdtCount"
    FROM "Exchange"
    WHERE "userId" = ${mainUserId}
  `;
  assert.equal(Number(budgetSql.confirmedVnd), 3_135_000, 'confirmed budget VND combines direct and actual indirect outcomes without double-counting legacy fields');
  assert.equal(Number(budgetSql.estimatedTargetVnd), 923_000, 'non-VND target equivalents remain a separate estimate bucket');
  assert.equal(Number(budgetSql.plannedUsdt), 10, 'planning rate denominator only includes eligible USDT rows with no actual VND outcome');
  assert.equal(Number(budgetSql.plannedWeightedVnd), 250_000, 'planning weighted numerator excludes actual and direct-target outcomes');
  assert.equal(Number(budgetSql.estimatedUsdt), 66, 'unconverted estimate denominator preserves direct USDT target fallback and indirect USDT-only top-ups');
  assert.equal(Number(budgetSql.unpricedUsdtCount), 2, 'unknown VND valuation is tracked separately for both unpriced top-up modes');

  // Compare PostgreSQL aggregates against the existing helper formulas over the same eligible records.
  const helperRubUsdt = calculateRubPerUsdt(mapRubUsdtExchanges(exchangeRows.map(x => ({
    mode: x.mode,
    rubSpent: Number(x.rubSpent),
    usdtReceived: x.usdtReceived == null ? null : Number(x.usdtReceived),
    targetCurrency: x.targetCurrency,
    targetReceived: x.targetReceived == null ? null : Number(x.targetReceived),
  }))));
  const sqlRubUsdt = (Number(exchangeAggregate._sum.rubSpent ?? 0) + 5000) /
    (Number(exchangeAggregate._sum.usdtReceived ?? 0) + 56);
  near(sqlRubUsdt, helperRubUsdt, 'weighted RUB/USDT rate including direct RUB→USDT target');

  const observedExchangeRows = mapActualVndUsdtExchanges(exchangeRows.map(x => ({
    mode: x.mode,
    usdtReceived: x.usdtReceived == null ? null : Number(x.usdtReceived),
    vndReceived: x.vndReceived == null ? null : Number(x.vndReceived),
  })));
  assert.deepEqual(observedExchangeRows, [{ usdtReceived: 93.7853, vndReceived: 2_300_000 }], 'only actual indirect exchange outcomes should become observed rate inputs');
  const helperObservedVndUsdt = calculateObservedVndPerUsdt(observedExchangeRows.map(x => ({ amountVnd: x.vndReceived, usdtCharged: x.usdtReceived })));
  near(helperObservedVndUsdt, Number(indirectActualSql.totalVnd) / Number(indirectActualSql.totalUsdt), 'PostgreSQL confirmed VND/USDT aggregate matches the existing helper and excludes planning-only rows');

  const directRows = mapDirectVndExchanges(exchangeRows.map(x => ({
    mode: x.mode,
    rubSpent: Number(x.rubSpent),
    vndReceived: x.vndReceived == null ? null : Number(x.vndReceived),
    targetReceived: x.targetReceived == null ? null : Number(x.targetReceived),
    targetVndEquivalent: x.targetVndEquivalent == null ? null : Number(x.targetVndEquivalent),
    targetCurrency: x.targetCurrency,
  })));
  const directVndExpected = directRows.reduce((sum, x) => sum + x.vndReceived, 0);
  assert.ok(directRows.some(x => x.rubSpent === 1800 && x.vndReceived === 0), 'an explicit zero VND outcome must be preserved rather than replaced with gross targetReceived');
  assert.equal(directVndExpected, 835_000, 'direct VND canonical/fallback values count once, normalize target currency, and ignore stale legacy values including explicit zero outcomes');
  assert.equal(Number(directTargetSql.totalVnd) + Number(directAggregate._sum.vndReceived), directVndExpected, 'PostgreSQL direct VND aggregate buckets must equal the existing TypeScript mapping');
  assert.equal(Number(directAggregate._sum.vndReceived), 250_000, 'direct RUB→VND aggregate is scoped and includes actual VND only');

  const helperCardRate = calculateObservedVndPerUsdt(expenseRows
    .filter(x => x.amountVnd != null && Number(x.amountVnd) > 0 && x.usdtCharged != null && Number(x.usdtCharged) > 0)
    .map(x => ({ amountVnd: Number(x.amountVnd), usdtCharged: Number(x.usdtCharged) })));
  const sqlCardRate = Number(cardAggregate._sum.amountVnd) / Number(cardAggregate._sum.usdtCharged);
  near(sqlCardRate, helperCardRate, 'weighted card VND/USDT rate');
  assert.equal(Number(cardAggregate._sum.amountVnd), 95_536);
  assert.equal(Number(cardAggregate._sum.usdtCharged), 3.76);

  // The effective VND/RUB rate must use the same eligible cost basis as the legacy
  // TypeScript implementation: direct outcomes + actual non-direct outcomes + card debits.
  // This aggregate is user-scoped and deliberately excludes planning-only records.
  const [rubVndSql] = await prisma.$queryRaw<Array<{
    directRub: unknown; directVnd: unknown; actualRub: unknown; actualVnd: unknown;
  }>>`
    SELECT
      COALESCE(SUM(CASE
        WHEN "mode" = 'RUB_VND' AND "rubSpent" > 0 AND "vndReceived" > 0
          THEN "rubSpent"
        WHEN "mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'VND'
          AND "rubSpent" > 0
          AND COALESCE("targetVndEquivalent", "targetReceived", "vndReceived") > 0
          THEN "rubSpent"
        ELSE 0
      END), 0) AS "directRub",
      COALESCE(SUM(CASE
        WHEN "mode" = 'RUB_VND' AND "rubSpent" > 0 AND "vndReceived" > 0
          THEN "vndReceived"
        WHEN "mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'VND'
          AND "rubSpent" > 0
          AND COALESCE("targetVndEquivalent", "targetReceived", "vndReceived") > 0
          THEN COALESCE("targetVndEquivalent", "targetReceived", "vndReceived")
        ELSE 0
      END), 0) AS "directVnd",
      COALESCE(SUM(CASE
        WHEN "mode" <> 'RUB_VND'
          AND NOT ("mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'VND')
          AND "rubSpent" > 0 AND "vndReceived" > 0
          THEN "rubSpent" ELSE 0
      END), 0) AS "actualRub",
      COALESCE(SUM(CASE
        WHEN "mode" <> 'RUB_VND'
          AND NOT ("mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'VND')
          AND "rubSpent" > 0 AND "vndReceived" > 0
          THEN "vndReceived" ELSE 0
      END), 0) AS "actualVnd"
    FROM "Exchange"
    WHERE "userId" = ${mainUserId}
  `;
  const cardRows = expenseRows
    .filter(x => x.amountVnd != null && Number(x.amountVnd) > 0 && x.usdtCharged != null && Number(x.usdtCharged) > 0)
    .map(x => ({ amountVnd: Number(x.amountVnd), usdtCharged: Number(x.usdtCharged) }));
  const helperVndRub = calculateObservedVndPerRub({
    directExchanges: directRows,
    actualVndExchanges: exchangeRows
      .filter(x => x.mode !== 'RUB_VND' &&
        !(x.mode === 'RUB_TARGET' && x.targetCurrency?.trim().toUpperCase() === 'VND') &&
        x.vndReceived != null)
      .map(x => ({ rubSpent: Number(x.rubSpent), vndReceived: Number(x.vndReceived) })),
    cardPurchases: cardRows,
    rubPerUsdt: helperRubUsdt,
  });
  const sqlVndRub = (
    Number(rubVndSql.directVnd) + Number(rubVndSql.actualVnd) +
    cardRows.reduce((sum, x) => sum + x.amountVnd, 0)
  ) / (
    Number(rubVndSql.directRub) + Number(rubVndSql.actualRub) +
    cardRows.reduce((sum, x) => sum + x.usdtCharged * (helperRubUsdt ?? 0), 0)
  );
  near(sqlVndRub, helperVndRub, 'PostgreSQL direct/actual/card cost-basis aggregate matches effective VND/RUB helper');
  assert.equal(Number(rubVndSql.directRub), 3_900, 'direct RUB cost basis excludes non-positive VND outcomes and uses canonical target values');
  assert.equal(Number(rubVndSql.directVnd), 835_000, 'direct VND total excludes stale legacy values and preserves canonical/fallback values');
  assert.equal(Number(rubVndSql.actualRub), 8_300, 'actual indirect VND cost basis excludes planning-only records');
  assert.equal(Number(rubVndSql.actualVnd), 2_300_000, 'actual indirect VND amount excludes planned values and direct target rows');

  // Exercise the exact SQL helper used by the dashboard route against disposable PostgreSQL.
  const runtimeAggregate = await aggregateDashboardExchanges(mainUserId);
  near(runtimeAggregate.rubUsdtRub / runtimeAggregate.rubUsdtUsdt, helperRubUsdt, 'runtime SQL RUB/USDT aggregate matches legacy helper');
  near(runtimeAggregate.actualVndUsdtVnd / runtimeAggregate.actualVndUsdtUsdt, helperObservedVndUsdt, 'runtime SQL actual VND/USDT aggregate matches legacy helper');
  assert.equal(runtimeAggregate.planningUsdt, 10, 'runtime SQL planning denominator excludes actual and direct VND rows');
  assert.equal(runtimeAggregate.planningWeightedVnd, 250_000, 'runtime SQL planning numerator remains separate from actual VND');
  assert.equal(runtimeAggregate.directRub, 3_900, 'runtime SQL direct RUB cost basis includes only positive actual outcomes');
  assert.equal(runtimeAggregate.directVnd, 835_000, 'runtime SQL direct VND cost basis preserves canonical/fallback precedence');
  assert.equal(runtimeAggregate.indirectRub, 8_300, 'runtime SQL indirect RUB cost basis excludes planning-only rows');
  assert.equal(runtimeAggregate.indirectVnd, 2_300_000, 'runtime SQL indirect VND cost basis excludes planning-only rows');
  assert.equal(runtimeAggregate.confirmedVnd, 3_135_000, 'runtime SQL confirmed VND total matches the legacy budget formula');
  assert.equal(runtimeAggregate.estimatedTargetVnd, 923_000, 'runtime SQL keeps non-VND target equivalents in estimates');
  assert.equal(runtimeAggregate.estimatedUsdt, 66, 'runtime SQL estimates direct and indirect unconverted USDT');
  assert.equal(runtimeAggregate.hasEstimatedTargetVnd, true);
  assert.equal(runtimeAggregate.hasUnpricedUsdtTopUps, true);
  const runtimeVndRub = (
    runtimeAggregate.directVnd + runtimeAggregate.indirectVnd + cardRows.reduce((sum, x) => sum + x.amountVnd, 0)
  ) / (
    runtimeAggregate.directRub + runtimeAggregate.indirectRub +
    cardRows.reduce((sum, x) => sum + x.usdtCharged * (helperRubUsdt ?? 0), 0)
  );
  near(runtimeVndRub, helperVndRub, 'runtime SQL VND/RUB cost basis matches the existing TypeScript helper');

  console.log('Dashboard aggregate fixture passed against disposable PostgreSQL: user scoping, weighted rates, actual-vs-planned VND, direct VND legacy fallback, card totals, and cross-user exclusion.');
} finally {
  if (userId) await prisma.user.deleteMany({ where: { id: userId } });
  if (otherUserId) await prisma.user.deleteMany({ where: { id: otherUserId } });
  await prisma.$disconnect();
}
