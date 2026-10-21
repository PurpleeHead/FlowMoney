import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { prisma } from '../../src/services/prisma.js';
import { getDateAwareValuationAggregate } from '../../src/lib/date-aware-valuation-aggregates.js';
import { calculateDateAwareValuationRates } from '../../src/lib/date-aware-valuation-rates.js';
import {
  calculateObservedVndPerRub,
  calculateObservedVndPerUsdt,
  calculateRubPerUsdt,
  mapActualVndExchanges,
  mapActualVndUsdtExchanges,
  mapDirectVndExchanges,
  mapRubUsdtExchanges,
} from '../../src/lib/money.js';

const suffix = `date-aware-valuation-${Date.now()}`;
const valuationDate = new Date('2026-10-15T00:00:00.000Z');
let userId: string | undefined;
let otherUserId: string | undefined;
let emptyUserId: string | undefined;

function near(actual: unknown, expected: number, label: string) {
  const value = Number(actual);
  assert.ok(Number.isFinite(value), `${label}: expected finite value, got ${String(actual)}`);
  assert.ok(Math.abs(value - expected) < 0.000001, `${label}: expected ${expected}, got ${value}`);
}

try {
  const [user, other, empty] = await Promise.all([
    prisma.user.create({ data: { email: `${suffix}@example.invalid`, passwordHash: 'test-only' } }),
    prisma.user.create({ data: { email: `${suffix}-other@example.invalid`, passwordHash: 'test-only' } }),
    prisma.user.create({ data: { email: `${suffix}-empty@example.invalid`, passwordHash: 'test-only' } }),
  ]);
  userId = user.id;
  otherUserId = other.id;
  emptyUserId = empty.id;

  const emptyAggregate = await getDateAwareValuationAggregate(empty.id, valuationDate);
  for (const [field, value] of Object.entries(emptyAggregate)) {
    near(value, 0, `empty-history aggregate ${field}`);
  }
  assert.deepEqual(calculateDateAwareValuationRates(emptyAggregate), {
    rubPerUsdt: null,
    vndPerUsdt: null,
    vndPerRub: null,
  }, 'an account with no historical observations must produce null rates rather than failing or inventing rates');

  await prisma.exchange.createMany({
    data: [
      {
        userId, mode: 'RUB_USDT_VND', targetCurrency: 'VND', rubSpent: 8300,
        usdtReceived: 93.7853, vndReceived: 2_300_000,
        createdAt: new Date('2026-10-10T12:00:00.000Z'),
      },
      {
        // A direct RUB→USDT top-up must not use stale VND fields as a VND/RUB observation.
        userId, mode: 'RUB_TARGET', targetCurrency: ' usdt ', rubSpent: 5000,
        targetReceived: 56, vndReceived: 777_777,
        createdAt: new Date('2026-10-12T12:00:00.000Z'),
      },
      {
        // Non-VND target operations also must not leak stale VND fields into rate observations.
        userId, mode: 'RUB_TARGET', targetCurrency: 'EUR', rubSpent: 3000,
        targetReceived: 30, targetToVndRate: 27_000, targetVndEquivalent: 810_000,
        vndReceived: 888_888, createdAt: new Date('2026-10-12T13:00:00.000Z'),
      },
      {
        // Unknown legacy modes are not authoritative indirect exchange outcomes.
        userId, mode: 'LEGACY_UNKNOWN', targetCurrency: 'VND', rubSpent: 4000,
        usdtReceived: 40, vndReceived: 999_999,
        createdAt: new Date('2026-10-12T14:00:00.000Z'),
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
        userId, mode: 'RUB_VND', targetCurrency: 'VND', rubSpent: 10,
        vndReceived: 1_000, createdAt: new Date('2026-10-15T00:00:00.000Z'),
      },
      {
        // An explicit zero in the canonical field must not fall through to stale legacy amounts.
        userId, mode: 'RUB_TARGET', targetCurrency: 'VND', rubSpent: 50,
        targetVndEquivalent: 0, targetReceived: 123_000, vndReceived: 456_000,
        createdAt: new Date('2026-10-15T00:00:00.000Z'),
      },
      {
        userId, mode: 'RUB_USDT_VND', targetCurrency: 'VND', rubSpent: 700,
        usdtReceived: 7, vndReceived: 175_000,
        createdAt: new Date('2026-10-16T12:00:00.000Z'),
      },
      {
        // A malformed negative RUB outflow cannot contribute to any exchange-derived rate.
        userId, mode: 'RUB_USDT_VND', targetCurrency: 'VND', rubSpent: -100,
        usdtReceived: 5, vndReceived: 125_000,
        createdAt: new Date('2026-10-14T12:30:00.000Z'),
      },
      {
        userId: otherUserId, mode: 'RUB_USDT_VND', targetCurrency: 'VND', rubSpent: 1,
        usdtReceived: 1, vndReceived: 999_999,
        createdAt: new Date('2026-10-10T12:00:00.000Z'),
      },
    ],
  });

  const nanValue = await prisma.$queryRaw<Array<{ value: string }>>(Prisma.sql`SELECT ('NaN'::numeric(20, 4))::text AS value`);
  assert.equal(nanValue[0]?.value, 'NaN', 'PostgreSQL numeric columns can preserve a legacy NaN value for regression coverage');

  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "Exchange" ("id", "userId", "mode", "targetCurrency", "rubSpent", "usdtReceived", "vndReceived", "createdAt", "targetReceived", "targetVndEquivalent")
    VALUES
      (${suffix + '-nan-rub'}, ${userId}, 'RUB_USDT_VND', 'VND', 'NaN'::numeric, 2, 50000, ${new Date('2026-10-14T12:40:00.000Z')}, NULL, NULL),
      (${suffix + '-nan-usdt'}, ${userId}, 'RUB_USDT_VND', 'VND', 100, 'NaN'::numeric, 20000, ${new Date('2026-10-14T12:45:00.000Z')}, NULL, NULL),
      (${suffix + '-nan-direct-vnd'}, ${userId}, 'RUB_VND', 'VND', 100, NULL, 'NaN'::numeric, ${new Date('2026-10-14T12:50:00.000Z')}, NULL, NULL),
      (${suffix + '-nan-canonical-vnd'}, ${userId}, 'RUB_TARGET', 'VND', 50, NULL, 456000, ${new Date('2026-10-14T12:55:00.000Z')}, 123000, 'NaN'::numeric)
  `);

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
        userId, title: 'Card exactly at cutoff', category: 'Food', amount: 1_000,
        currency: 'VND', amountVnd: 1_000, usdtCharged: 0.1,
        date: new Date('2026-10-15T00:00:00.000Z'),
      },
      {
        userId, title: 'Card after cutoff', category: 'Food', amount: 100_000,
        currency: 'VND', amountVnd: 100_000, usdtCharged: 4,
        date: new Date('2026-10-16T08:00:00.000Z'),
      },
      {
        // Legacy/inconsistent rows must not become a rate observation without a positive debit.
        userId, title: 'Card without debit', category: 'Food', amount: 80_000,
        currency: 'VND', amountVnd: 80_000, usdtCharged: 0,
        date: new Date('2026-10-12T08:00:00.000Z'),
      },
      {
        // A stale card debit on a non-VND expense must never affect observed VND rates.
        userId, title: 'Stale card fields on RUB expense', category: 'Test', amount: 500,
        currency: 'RUB', amountVnd: 500, usdtCharged: 25,
        date: new Date('2026-10-12T08:30:00.000Z'),
      },
      {
        // A debit without a stored VND basis is not enough to infer a conversion rate.
        userId, title: 'Card without VND basis', category: 'Food', amount: 80_000,
        currency: 'VND', amountVnd: null, usdtCharged: 3,
        date: new Date('2026-10-12T09:00:00.000Z'),
      },
      {
        userId: otherUserId, title: 'Other user card', category: 'Food', amount: 999_999,
        currency: 'VND', amountVnd: 999_999, usdtCharged: 99,
        date: new Date('2026-10-10T08:00:00.000Z'),
      },
    ],
  });

  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "Expense" ("id", "userId", "title", "category", "amount", "currency", "amountVnd", "usdtCharged", "date", "createdAt", "updatedAt")
    VALUES
      (${suffix + '-nan-card-vnd'}, ${userId}, 'Card with NaN VND', 'Test', 100, 'VND', 'NaN'::numeric, 2, ${new Date('2026-10-14T08:45:00.000Z')}, NOW(), NOW()),
      (${suffix + '-nan-card-usdt'}, ${userId}, 'Card with NaN USDT', 'Test', 100, 'VND', 10000, 'NaN'::numeric, ${new Date('2026-10-14T08:50:00.000Z')}, NOW(), NOW()),
      (${suffix + '-infinity-card-vnd'}, ${userId}, 'Card with Infinity VND', 'Test', 100, 'VND', 'Infinity'::numeric, 2, ${new Date('2026-10-14T08:55:00.000Z')}, NOW(), NOW()),
      (${suffix + '-infinity-card-usdt'}, ${userId}, 'Card with Infinity USDT', 'Test', 100, 'VND', 10000, 'Infinity'::numeric, ${new Date('2026-10-14T09:00:00.000Z')}, NOW(), NOW())
  `);

  const aggregate = await getDateAwareValuationAggregate(userId, valuationDate);
  const [exchanges, expenses] = await Promise.all([
    prisma.exchange.findMany({
      where: { userId, createdAt: { lte: valuationDate } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.expense.findMany({ where: { userId, date: { lte: valuationDate } }, orderBy: { date: 'asc' } }),
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
    rubSpent: Number(x.rubSpent),
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
  const actualVndRubRows = mapActualVndExchanges(exchanges.map(x => ({
    mode: x.mode,
    rubSpent: Number(x.rubSpent),
    vndReceived: x.vndReceived == null ? null : Number(x.vndReceived),
    targetCurrency: x.targetCurrency,
  })));
  const cardRows = expenses.filter(x =>
    x.currency.trim().toUpperCase() === 'VND' &&
    x.amountVnd != null && Number.isFinite(Number(x.amountVnd)) && Number(x.amountVnd) > 0 &&
    x.usdtCharged != null && Number.isFinite(Number(x.usdtCharged)) && Number(x.usdtCharged) > 0
  );

  near(aggregate.rubUsdtRub, rubUsdtRows.reduce((sum, x) => sum + x.rubSpent, 0), 'cutoff RUB/USDT numerator');
  near(aggregate.rubUsdtUsdt, rubUsdtRows.reduce((sum, x) => sum + x.usdtReceived, 0), 'cutoff RUB/USDT denominator');
  near(aggregate.actualVnd, actualRows.reduce((sum, x) => sum + x.vndReceived, 0), 'cutoff actual indirect VND');
  near(aggregate.actualUsdt, actualRows.reduce((sum, x) => sum + x.usdtReceived, 0), 'cutoff actual indirect USDT');
  near(aggregate.directRub, directRows.filter(x => x.rubSpent > 0 && x.vndReceived > 0).reduce((sum, x) => sum + x.rubSpent, 0), 'cutoff direct exchange RUB');
  near(aggregate.directVnd, directRows.filter(x => x.rubSpent > 0 && x.vndReceived > 0).reduce((sum, x) => sum + x.vndReceived, 0), 'cutoff direct exchange VND with canonical fallback');
  near(aggregate.actualRubForVnd, actualVndRubRows.reduce((sum, x) => sum + x.rubSpent, 0), 'cutoff indirect/legacy RUB basis for VND/RUB');
  near(aggregate.actualVndForRub, actualVndRubRows.reduce((sum, x) => sum + x.vndReceived, 0), 'cutoff indirect/legacy VND basis for VND/RUB');
  near(aggregate.cardVnd, cardRows.reduce((sum, x) => sum + Number(x.amountVnd), 0), 'cutoff card VND');
  near(aggregate.cardUsdt, cardRows.reduce((sum, x) => sum + Number(x.usdtCharged), 0), 'cutoff card USDT');

  assert.equal(exchanges.length, 13, 'the cutoff instant is inclusive; later exchanges and other users are excluded while malformed numeric rows remain available to the legacy-mapper comparison');
  assert.equal(expenses.length, 10, 'the cutoff instant is inclusive; later expenses and other users are excluded while malformed numeric and same-user legacy rows remain in the comparison set');
  near(aggregate.rubUsdtRub, 13_300, 'fixture RUB/USDT numerator');
  near(aggregate.rubUsdtUsdt, 149.7853, 'fixture RUB/USDT denominator');
  near(aggregate.actualVnd, 2_300_000, 'fixture actual indirect VND excludes later exchange and rows with NaN numeric evidence');
  near(aggregate.directRub, 3_010, 'fixture direct RUB includes valid cutoff exchange and excludes explicit-zero outcome and NaN outcome');
  near(aggregate.directVnd, 711_000, 'fixture direct VND includes valid cutoff exchange and excludes stale legacy amount, explicit-zero outcome, and NaN outcome');
  near(aggregate.cardVnd, 96_536, 'fixture card VND includes expense exactly at cutoff, excludes later expense, and ignores malformed or non-VND rows');
  near(aggregate.cardUsdt, 3.86, 'fixture card USDT includes expense exactly at cutoff, excludes later expense, and ignores malformed or non-VND rows');

  const aggregateWithoutFirstCard = await getDateAwareValuationAggregate(userId, valuationDate, expenses[0].id);
  near(
    aggregateWithoutFirstCard.cardVnd,
    Number(aggregate.cardVnd) - Number(expenses[0].amountVnd),
    'excluding an edited expense removes its VND from historical card aggregates',
  );
  near(
    aggregateWithoutFirstCard.cardUsdt,
    Number(aggregate.cardUsdt) - Number(expenses[0].usdtCharged),
    'excluding an edited expense removes its USDT debit from historical card aggregates',
  );

  const ratesWithEditedExpense = calculateDateAwareValuationRates(aggregate);
  const ratesWithoutEditedExpense = calculateDateAwareValuationRates(aggregateWithoutFirstCard);
  assert.equal(ratesWithEditedExpense.rubPerUsdt, ratesWithoutEditedExpense.rubPerUsdt,
    'excluding a card expense must not change the RUB/USDT exchange rate');
  near(
    ratesWithEditedExpense.vndPerUsdt!,
    Number(aggregate.cardVnd) / Number(aggregate.cardUsdt),
    'card purchases take precedence for VND/USDT before edit',
  );
  near(
    ratesWithoutEditedExpense.vndPerUsdt!,
    Number(aggregateWithoutFirstCard.cardVnd) / Number(aggregateWithoutFirstCard.cardUsdt),
    'remaining card purchases retain precedence for VND/USDT after edit',
  );
  assert.notEqual(
    ratesWithEditedExpense.vndPerUsdt,
    ratesWithoutEditedExpense.vndPerUsdt,
    'excluding an edited card expense must recompute the weighted historical card rate',
  );

  assert.notEqual(
    ratesWithEditedExpense.vndPerRub,
    ratesWithoutEditedExpense.vndPerRub,
    'excluding an edited card expense must recompute the historical VND/RUB rate when card evidence contributes',
  );

  for (const field of [
    'rubUsdtRub', 'rubUsdtUsdt', 'actualVnd', 'actualUsdt',
    'directRub', 'directVnd', 'actualRubForVnd', 'actualVndForRub',
  ] as const) {
    near(
      Number(aggregateWithoutFirstCard[field]),
      Number(aggregate[field]),
      `excluding an expense must not alter exchange aggregate ${field}`,
    );
  }

  const aggregateWithoutMissingCard = await getDateAwareValuationAggregate(
    userId,
    valuationDate,
    'expense-does-not-exist',
  );
  near(aggregateWithoutMissingCard.cardVnd, Number(aggregate.cardVnd), 'excluding a missing expense leaves card VND unchanged');
  near(aggregateWithoutMissingCard.cardUsdt, Number(aggregate.cardUsdt), 'excluding a missing expense leaves card USDT unchanged');

  const futureCardExpense = await prisma.expense.findFirst({ where: { userId, title: 'Card after cutoff' } });
  assert.ok(futureCardExpense, 'fixture includes a card expense after the historical cutoff');
  const aggregateWithoutFutureCard = await getDateAwareValuationAggregate(userId, valuationDate, futureCardExpense.id);
  near(aggregateWithoutFutureCard.cardVnd, Number(aggregate.cardVnd), 'excluding a future card expense cannot alter a historical VND aggregate');
  near(aggregateWithoutFutureCard.cardUsdt, Number(aggregate.cardUsdt), 'excluding a future card expense cannot alter a historical USDT aggregate');

  const aggregateWithoutNonVndExpense = await getDateAwareValuationAggregate(
    userId,
    valuationDate,
    expenses.find(x => x.title === 'Stale card fields on RUB expense')!.id,
  );
  near(aggregateWithoutNonVndExpense.cardVnd, Number(aggregate.cardVnd), 'excluding a non-VND expense cannot change the VND card aggregate');
  near(aggregateWithoutNonVndExpense.cardUsdt, Number(aggregate.cardUsdt), 'excluding a non-VND expense cannot change the USDT card aggregate');

  const observedRate = calculateObservedVndPerUsdt(actualRows.map(x => ({
    amountVnd: x.vndReceived,
    usdtCharged: x.usdtReceived,
  })));
  near(observedRate, 2_300_000 / 93.7853, 'date-scoped aggregate source rows preserve observed VND/USDT calculation');

  const legacyRubPerUsdt = calculateRubPerUsdt(rubUsdtRows);
  const legacyCardRate = calculateObservedVndPerUsdt(cardRows.map(x => ({
    amountVnd: Number(x.amountVnd),
    usdtCharged: Number(x.usdtCharged),
  })));
  const legacyExchangeRate = calculateObservedVndPerUsdt(actualRows.map(x => ({
    amountVnd: x.vndReceived,
    usdtCharged: x.usdtReceived,
  })));
  const legacyVndPerUsdt = legacyCardRate ?? legacyExchangeRate;
  const legacyVndPerRub = calculateObservedVndPerRub({
    directExchanges: directRows,
    actualVndExchanges: actualVndRubRows,
    cardPurchases: cardRows.map(x => ({
      amountVnd: Number(x.amountVnd),
      usdtCharged: Number(x.usdtCharged),
    })),
    rubPerUsdt: legacyRubPerUsdt,
  });
  const aggregateRates = calculateDateAwareValuationRates(aggregate);
  near(aggregateRates.rubPerUsdt, legacyRubPerUsdt!, 'aggregate-derived RUB/USDT rate matches established mapper');
  near(aggregateRates.vndPerUsdt, legacyVndPerUsdt!, 'aggregate-derived VND/USDT rate matches established mapper');
  near(aggregateRates.vndPerRub, legacyVndPerRub!, 'aggregate-derived VND/RUB rate matches established mapper');

  console.log('Date-aware valuation aggregate passed against disposable PostgreSQL: cutoff inclusion, future-row exclusion, user isolation, weighted RUB/USDT, actual-only indirect outcomes, direct VND fallback, card totals, and all three historical rates.');
} finally {
  if (userId) await prisma.user.deleteMany({ where: { id: userId } });
  if (otherUserId) await prisma.user.deleteMany({ where: { id: otherUserId } });
  if (emptyUserId) await prisma.user.deleteMany({ where: { id: emptyUserId } });
  await prisma.$disconnect();
}
