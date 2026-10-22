import assert from 'node:assert/strict';
import { prisma } from '../../src/services/prisma.js';
import {
  calculateObservedVndPerUsdt,
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
    { mode: 'RUB_TARGET', targetCurrency: 'USDT', rubSpent: 5000, targetReceived: 56, planningVndPerUsdt: 26_000 },
    // A valued direct USDT target may retain a stale legacy usdtReceived value; don't count both buckets.
    { mode: 'RUB_TARGET', targetCurrency: 'USDT', rubSpent: 0, targetReceived: 10, targetToVndRate: 50_000, targetVndEquivalent: 500_000, usdtReceived: 10 },
    // If actual VND was later recorded, don't add a stale target valuation on top.
    { mode: 'RUB_TARGET', targetCurrency: 'USDT', rubSpent: 0, targetReceived: 10, targetVndEquivalent: 500_000, vndReceived: 510_000 },
    { mode: 'RUB_VND', targetCurrency: 'VND', rubSpent: 1000, vndReceived: 250_000 },
    // Canonical VND must win over a stale legacy vndReceived value.
    { mode: 'RUB_TARGET', targetCurrency: 'VND', rubSpent: 2000, targetReceived: 460_000, targetVndEquivalent: 460_000, vndReceived: 9_999_999, usdtReceived: 10 },
    // An explicit zero net outcome must not fall back to the positive gross target.
    { mode: 'RUB_TARGET', targetCurrency: 'VND', rubSpent: 1800, targetReceived: 350_000, targetVndEquivalent: 0, vndReceived: 345_000 },
    // Legacy/corrupt casing and whitespace must still classify as a direct VND target.
    { mode: 'RUB_TARGET', targetCurrency: ' vnd ', rubSpent: 900, targetReceived: 125_000, targetVndEquivalent: null, vndReceived: 777_777 },
    // Non-VND target estimates are not factual VND outcomes.
    { mode: 'RUB_TARGET', targetCurrency: 'GEL', rubSpent: 1500, targetReceived: 100, targetToVndRate: 9200, targetVndEquivalent: 920_000 },
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

  // Validate the remaining dashboard budget buckets before moving them into runtime SQL.
  const [budgetAggregate] = await prisma.$queryRaw<Array<{
    confirmedVnd: unknown;
    estimatedTargetVnd: unknown;
    plannedUsdt: unknown;
    plannedWeightedVnd: unknown;
    estimatedUnpricedUsdt: unknown;
  }>>`
    SELECT
      COALESCE(SUM(CASE
        WHEN "mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'VND'
          THEN COALESCE("targetVndEquivalent", "targetReceived", "vndReceived")
        ELSE "vndReceived"
      END), 0) AS "confirmedVnd",
      COALESCE(SUM(CASE
        WHEN "mode" = 'RUB_TARGET'
          AND ("targetCurrency" IS NULL OR upper(trim("targetCurrency")) <> 'VND')
          AND "vndReceived" IS NULL
          AND "targetVndEquivalent" > 0
          THEN "targetVndEquivalent"
        ELSE 0
      END), 0) AS "estimatedTargetVnd",
      COALESCE(SUM(CASE
        WHEN "mode" <> 'RUB_VND'
          AND NOT ("mode" = 'RUB_TARGET' AND upper(trim(COALESCE("targetCurrency", ''))) = 'VND')
          AND "vndReceived" IS NULL
          AND (
            ("mode" = 'RUB_TARGET' AND upper(trim(COALESCE("targetCurrency", ''))) = 'USDT'
              AND "targetReceived" IS NOT NULL AND "targetVndEquivalent" IS NULL)
            OR (NOT ("mode" = 'RUB_TARGET' AND upper(trim(COALESCE("targetCurrency", ''))) = 'USDT')
              AND "usdtReceived" IS NOT NULL)
          )
          AND "planningVndPerUsdt" IS NOT NULL
          THEN CASE WHEN "mode" = 'RUB_TARGET' AND upper(trim(COALESCE("targetCurrency", ''))) = 'USDT'
            THEN "targetReceived" ELSE "usdtReceived" END
        ELSE 0
      END), 0) AS "plannedUsdt",
      COALESCE(SUM(CASE
        WHEN "mode" <> 'RUB_VND'
          AND NOT ("mode" = 'RUB_TARGET' AND upper(trim(COALESCE("targetCurrency", ''))) = 'VND')
          AND "vndReceived" IS NULL
          AND (
            ("mode" = 'RUB_TARGET' AND upper(trim(COALESCE("targetCurrency", ''))) = 'USDT'
              AND "targetReceived" IS NOT NULL AND "targetVndEquivalent" IS NULL)
            OR (NOT ("mode" = 'RUB_TARGET' AND upper(trim(COALESCE("targetCurrency", ''))) = 'USDT')
              AND "usdtReceived" IS NOT NULL)
          )
          AND "planningVndPerUsdt" IS NOT NULL
          THEN (CASE WHEN "mode" = 'RUB_TARGET' AND upper(trim(COALESCE("targetCurrency", ''))) = 'USDT'
            THEN "targetReceived" ELSE "usdtReceived" END) * "planningVndPerUsdt"
        ELSE 0
      END), 0) AS "plannedWeightedVnd",
      COALESCE(SUM(CASE
        WHEN "mode" <> 'RUB_VND'
          AND NOT ("mode" = 'RUB_TARGET' AND upper(trim(COALESCE("targetCurrency", ''))) = 'VND')
          AND "vndReceived" IS NULL
          AND (
            ("mode" = 'RUB_TARGET' AND upper(trim(COALESCE("targetCurrency", ''))) = 'USDT'
              AND "targetReceived" IS NOT NULL AND "targetVndEquivalent" IS NULL)
            OR (NOT ("mode" = 'RUB_TARGET' AND upper(trim(COALESCE("targetCurrency", ''))) = 'USDT')
              AND "usdtReceived" IS NOT NULL)
          )
          THEN CASE WHEN "mode" = 'RUB_TARGET' AND upper(trim(COALESCE("targetCurrency", ''))) = 'USDT'
            THEN COALESCE("targetReceived", 0) ELSE "usdtReceived" END
        ELSE 0
      END), 0) AS "estimatedUnpricedUsdt"
    FROM "Exchange"
    WHERE "userId" = ${mainUserId}
  `;
  assert.equal(Number(budgetAggregate.confirmedVnd), 3_645_000,
    'confirmed VND aggregate must count direct targets once, preserve explicit zero outcomes, and include only recorded non-direct outcomes');
  assert.equal(Number(budgetAggregate.estimatedTargetVnd), 1_420_000,
    'estimated non-VND target value must stay separate from confirmed VND');
  assert.equal(Number(budgetAggregate.plannedUsdt), 66,
    'planning-rate denominator must include only eligible unpriced USDT top-ups');
  assert.equal(Number(budgetAggregate.plannedWeightedVnd), 1_706_000,
    'planning-rate numerator must be USDT-weighted and must not mix into factual observed rates');
  assert.equal(Number(budgetAggregate.estimatedUnpricedUsdt), 66,
    'legacy direct VND rows with stale usdtReceived must not inflate unpriced USDT balance estimates');
  const helperPlanned = exchangeRows
    .filter(x => x.mode !== 'RUB_VND' &&
      !(x.mode === 'RUB_TARGET' && x.targetCurrency?.trim().toUpperCase() === 'VND') &&
      x.vndReceived == null &&
      (x.mode === 'RUB_TARGET' && x.targetCurrency?.trim().toUpperCase() === 'USDT'
        ? x.targetReceived != null && x.targetVndEquivalent == null
        : x.usdtReceived != null) &&
      x.planningVndPerUsdt != null);
  const helperPlannedAmount = (x: typeof helperPlanned[number]) =>
    Number(x.mode === 'RUB_TARGET' && x.targetCurrency?.trim().toUpperCase() === 'USDT'
      ? x.targetReceived : x.usdtReceived);
  const helperPlannedUsdt = helperPlanned.reduce((sum, x) => sum + helperPlannedAmount(x), 0);
  const helperPlannedWeightedVnd = helperPlanned.reduce((sum, x) =>
    sum + helperPlannedAmount(x) * Number(x.planningVndPerUsdt), 0);
  near(Number(budgetAggregate.plannedUsdt), helperPlannedUsdt, 'PostgreSQL planning-rate denominator matches existing dashboard eligibility');
  near(Number(budgetAggregate.plannedWeightedVnd), helperPlannedWeightedVnd, 'PostgreSQL planning-rate numerator matches existing dashboard eligibility');
  near(Number(budgetAggregate.plannedWeightedVnd) / Number(budgetAggregate.plannedUsdt), 1_706_000 / 66,
    'weighted planning rate includes direct USDT targets and stays distinct from the observed VND/USDT rate');

  console.log('Dashboard aggregate fixture passed against disposable PostgreSQL: user scoping, weighted rates, confirmed/estimated/planned budget buckets, direct VND legacy fallback, card totals, and cross-user exclusion.');
} finally {
  if (userId) await prisma.user.deleteMany({ where: { id: userId } });
  if (otherUserId) await prisma.user.deleteMany({ where: { id: otherUserId } });
  await prisma.$disconnect();
}
