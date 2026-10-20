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
    { mode: 'RUB_TARGET', targetCurrency: 'USDT', rubSpent: 5000, targetReceived: 56 },
    { mode: 'RUB_VND', targetCurrency: 'VND', rubSpent: 1000, vndReceived: 250_000 },
    // Canonical VND must win over a stale legacy vndReceived value.
    { mode: 'RUB_TARGET', targetCurrency: 'VND', rubSpent: 2000, targetReceived: 460_000, targetVndEquivalent: 460_000, vndReceived: 9_999_999 },
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

  const helperObservedVndUsdt = calculateObservedVndPerUsdt(mapActualVndUsdtExchanges(exchangeRows.map(x => ({
    mode: x.mode,
    usdtReceived: x.usdtReceived == null ? null : Number(x.usdtReceived),
    vndReceived: x.vndReceived == null ? null : Number(x.vndReceived),
  }))));
  near(helperObservedVndUsdt, 2_300_000 / 93.7853, 'observed VND/USDT excludes planning-only rows');

  const directRows = mapDirectVndExchanges(exchangeRows.map(x => ({
    mode: x.mode,
    rubSpent: Number(x.rubSpent),
    vndReceived: x.vndReceived == null ? null : Number(x.vndReceived),
    targetReceived: x.targetReceived == null ? null : Number(x.targetReceived),
    targetVndEquivalent: x.targetVndEquivalent == null ? null : Number(x.targetVndEquivalent),
    targetCurrency: x.targetCurrency,
  })));
  const directVndExpected = directRows.reduce((sum, x) => sum + x.vndReceived, 0);
  assert.equal(directVndExpected, 710_000, 'direct VND canonical/fallback values count once and ignore stale legacy values');
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
  await prisma.$disconnect();
}
