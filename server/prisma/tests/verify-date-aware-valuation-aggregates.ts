import assert from 'node:assert/strict';
import { prisma } from '../../src/services/prisma.js';
import { getDateAwareValuationAggregate } from '../../src/lib/date-aware-valuation-aggregates.js';
import {
  calculateObservedVndPerUsdt,
  calculateRubPerUsdt,
  mapActualVndUsdtExchanges,
  mapDirectVndExchanges,
  mapRubUsdtExchanges,
} from '../../src/lib/money.js';

const suffix = `date-aware-valuation-${Date.now()}`;
const valuationDate = new Date('2026-10-15T00:00:00.000Z');
let userId: string | undefined;
let otherUserId: string | undefined;

function near(actual: unknown, expected: number, label: string) {
  const value = Number(actual);
  assert.ok(Number.isFinite(value), `${label}: expected finite value, got ${String(actual)}`);
  assert.ok(Math.abs(value - expected) < 0.000001, `${label}: expected ${expected}, got ${value}`);
}

try {
  const [user, other] = await Promise.all([
    prisma.user.create({ data: { email: `${suffix}@example.invalid`, passwordHash: 'test-only' } }),
    prisma.user.create({ data: { email: `${suffix}-other@example.invalid`, passwordHash: 'test-only' } }),
  ]);
  userId = user.id;
  otherUserId = other.id;

  await prisma.exchange.createMany({
    data: [
      {
        userId, mode: 'RUB_USDT_VND', targetCurrency: 'VND', rubSpent: 8300,
        usdtReceived: 93.7853, vndReceived: 2_300_000,
        createdAt: new Date('2026-10-10T12:00:00.000Z'),
      },
      {
        userId, mode: 'RUB_TARGET', targetCurrency: ' usdt ', rubSpent: 5000,
        targetReceived: 56, createdAt: new Date('2026-10-12T12:00:00.000Z'),
      },
      {
        userId, mode: 'RUB_VND', targetCurrency: 'VND', rubSpent: 1000,
        vndReceived: 250_000, createdAt: new Date('2026-10-13T12:00:00.000Z'),
      },
      {
        userId, mode: 'RUB_TARGET', targetCurrency: ' vNd ', rubSpent: 2000,
        targetReceived: 460_000, targetVndEquivalent: 460_000, vndReceived: 9_999_999,
        createdAt: new Date('2026-10-14T12:00:00.000Z'),
      },
      {
        userId, mode: 'RUB_USDT_VND', targetCurrency: 'VND', rubSpent: 700,
        usdtReceived: 7, vndReceived: 175_000,
        createdAt: new Date('2026-10-16T12:00:00.000Z'),
      },
      {
        userId: otherUserId, mode: 'RUB_USDT_VND', targetCurrency: 'VND', rubSpent: 1,
        usdtReceived: 1, vndReceived: 999_999,
        createdAt: new Date('2026-10-10T12:00:00.000Z'),
      },
    ],
  });

  await prisma.expense.createMany({
    data: [
      {
        userId, title: 'Card before cutoff', category: 'Food', amount: 55_536,
        currency: 'VND', amountVnd: 55_536, usdtCharged: 2.19,
        date: new Date('2026-10-10T08:00:00.000Z'),
      },
      {
        userId, title: 'Card before cutoff B', category: 'Food', amount: 40_000,
        currency: 'VND', amountVnd: 40_000, usdtCharged: 1.57,
        date: new Date('2026-10-14T08:00:00.000Z'),
      },
      {
        userId, title: 'Card after cutoff', category: 'Food', amount: 100_000,
        currency: 'VND', amountVnd: 100_000, usdtCharged: 4,
        date: new Date('2026-10-16T08:00:00.000Z'),
      },
      {
        userId: otherUserId, title: 'Other user card', category: 'Food', amount: 999_999,
        currency: 'VND', amountVnd: 999_999, usdtCharged: 99,
        date: new Date('2026-10-10T08:00:00.000Z'),
      },
    ],
  });

  const aggregate = await getDateAwareValuationAggregate(userId, valuationDate);
  const [exchanges, expenses] = await Promise.all([
    prisma.exchange.findMany({
      where: { userId, createdAt: { lte: valuationDate } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.expense.findMany({ where: { userId, date: { lte: valuationDate } } }),
  ]);

  const rubUsdtRows = mapRubUsdtExchanges(exchanges.map(x => ({
    mode: x.mode,
    rubSpent: Number(x.rubSpent),
    usdtReceived: x.usdtReceived == null ? null : Number(x.usdtReceived),
    targetCurrency: x.targetCurrency,
    targetReceived: x.targetReceived == null ? null : Number(x.targetReceived),
  })));
  const actualRows = mapActualVndUsdtExchanges(exchanges.map(x => ({
    mode: x.mode,
    usdtReceived: x.usdtReceived == null ? null : Number(x.usdtReceived),
    vndReceived: x.vndReceived == null ? null : Number(x.vndReceived),
  })));
  const directRows = mapDirectVndExchanges(exchanges.map(x => ({
    mode: x.mode,
    rubSpent: Number(x.rubSpent),
    vndReceived: x.vndReceived == null ? null : Number(x.vndReceived),
    targetReceived: x.targetReceived == null ? null : Number(x.targetReceived),
    targetVndEquivalent: x.targetVndEquivalent == null ? null : Number(x.targetVndEquivalent),
    targetCurrency: x.targetCurrency,
  })));
  const cardRows = expenses.filter(x =>
    x.amountVnd != null && Number(x.amountVnd) > 0 &&
    x.usdtCharged != null && Number(x.usdtCharged) > 0
  );

  near(aggregate.rubUsdtRub, rubUsdtRows.reduce((sum, x) => sum + x.rubSpent, 0), 'cutoff RUB/USDT numerator');
  near(aggregate.rubUsdtUsdt, rubUsdtRows.reduce((sum, x) => sum + x.usdtReceived, 0), 'cutoff RUB/USDT denominator');
  near(aggregate.actualVnd, actualRows.reduce((sum, x) => sum + x.vndReceived, 0), 'cutoff actual indirect VND');
  near(aggregate.actualUsdt, actualRows.reduce((sum, x) => sum + x.usdtReceived, 0), 'cutoff actual indirect USDT');
  near(aggregate.directRub, directRows.reduce((sum, x) => sum + x.rubSpent, 0), 'cutoff direct exchange RUB');
  near(aggregate.directVnd, directRows.reduce((sum, x) => sum + x.vndReceived, 0), 'cutoff direct exchange VND with canonical fallback');
  near(aggregate.cardVnd, cardRows.reduce((sum, x) => sum + Number(x.amountVnd), 0), 'cutoff card VND');
  near(aggregate.cardUsdt, cardRows.reduce((sum, x) => sum + Number(x.usdtCharged), 0), 'cutoff card USDT');

  assert.equal(exchanges.length, 4, 'exchanges after the cutoff and other users must be excluded');
  assert.equal(expenses.length, 2, 'expenses after the cutoff and other users must be excluded');
  near(aggregate.rubUsdtRub, 13_300, 'fixture RUB/USDT numerator');
  near(aggregate.rubUsdtUsdt, 149.7853, 'fixture RUB/USDT denominator');
  near(aggregate.actualVnd, 2_300_000, 'fixture actual indirect VND excludes later exchange');
  near(aggregate.directRub, 3_000, 'fixture direct RUB');
  near(aggregate.directVnd, 710_000, 'fixture direct VND excludes stale legacy amount');
  near(aggregate.cardVnd, 95_536, 'fixture card VND excludes later expense');
  near(aggregate.cardUsdt, 3.76, 'fixture card USDT excludes later expense');

  const observedRate = calculateObservedVndPerUsdt(actualRows.map(x => ({
    amountVnd: x.vndReceived,
    usdtCharged: x.usdtReceived,
  })));
  near(observedRate, 2_300_000 / 93.7853, 'date-scoped aggregate source rows preserve observed VND/USDT calculation');

  console.log('Date-aware valuation aggregate passed against disposable PostgreSQL: cutoff inclusion, future-row exclusion, user isolation, weighted RUB/USDT, actual-only indirect outcomes, direct VND fallback, and card totals.');
} finally {
  if (userId) await prisma.user.deleteMany({ where: { id: userId } });
  if (otherUserId) await prisma.user.deleteMany({ where: { id: otherUserId } });
  await prisma.$disconnect();
}
