import assert from 'node:assert/strict';
import { prisma } from '../../src/services/prisma.js';
import { removeExpenseLedger, removeExchangeLedger, syncExpenseLedger, syncExchangeLedger } from '../../src/lib/wallet-ledger.js';

const suffix = `concurrent-mutation-${Date.now()}`;
let userId: string | undefined;

async function raceExpense(user: { id: string }, iteration: number) {
  const expense = await prisma.expense.create({
    data: {
      userId: user.id,
      title: `Concurrent expense ${iteration}`,
      category: 'Concurrency test',
      amount: 100,
      currency: 'RUB',
      amountRub: 100,
      date: new Date(),
    },
  });

  await prisma.$transaction(tx => syncExpenseLedger(tx, expense));

  const patch = prisma.$transaction(async tx => {
    const result = await tx.expense.updateMany({
      where: { id: expense.id, userId: user.id },
      data: { amount: 125, amountRub: 125 },
    });
    if (!result.count) return null;
    const current = await tx.expense.findFirst({ where: { id: expense.id, userId: user.id } });
    if (current) await syncExpenseLedger(tx, current);
    return current;
  });

  const remove = prisma.$transaction(async tx => {
    const result = await tx.expense.deleteMany({ where: { id: expense.id, userId: user.id } });
    if (result.count) await removeExpenseLedger(tx, user.id, expense.id);
    return result.count;
  });

  await Promise.all([patch, remove]);

  const [saved, movements] = await Promise.all([
    prisma.expense.findFirst({ where: { id: expense.id, userId: user.id } }),
    prisma.walletMovement.findMany({
      where: { userId: user.id, sourceKey: { startsWith: `expense:${expense.id}:` } },
    }),
  ]);
  assert.equal(saved, null, 'A concurrent PATCH/DELETE race must not resurrect the deleted expense');
  assert.equal(movements.length, 0, 'Deleted expense must have no remaining ledger movements');
}

async function raceExchange(user: { id: string }, iteration: number) {
  const exchange = await prisma.exchange.create({
    data: {
      userId: user.id,
      mode: 'RUB_USDT_VND',
      targetCurrency: 'VND',
      rubSpent: 8300,
      usdtReceived: 100,
      vndReceived: 250000,
      vndPerUsdt: 2500,
      effectiveVndPerRub: 250000 / 8300,
      effectiveRubPerUsdt: 83,
    },
  });

  await prisma.$transaction(tx => syncExchangeLedger(tx, exchange));

  const patch = prisma.$transaction(async tx => {
    const result = await tx.exchange.updateMany({
      where: { id: exchange.id, userId: user.id },
      data: {
        rubSpent: 9000,
        usdtReceived: 105,
        vndReceived: 260000,
        vndPerUsdt: 260000 / 105,
        effectiveVndPerRub: 260000 / 9000,
        effectiveRubPerUsdt: 9000 / 105,
      },
    });
    if (!result.count) return null;
    const current = await tx.exchange.findFirst({ where: { id: exchange.id, userId: user.id } });
    if (current) await syncExchangeLedger(tx, current);
    return current;
  });

  const remove = prisma.$transaction(async tx => {
    const result = await tx.exchange.deleteMany({ where: { id: exchange.id, userId: user.id } });
    if (result.count) await removeExchangeLedger(tx, user.id, exchange.id);
    return result.count;
  });

  await Promise.all([patch, remove]);

  const [saved, movements] = await Promise.all([
    prisma.exchange.findFirst({ where: { id: exchange.id, userId: user.id } }),
    prisma.walletMovement.findMany({
      where: { userId: user.id, sourceKey: { startsWith: `exchange:${exchange.id}:` } },
    }),
  ]);
  assert.equal(saved, null, 'A concurrent PATCH/DELETE race must not resurrect the deleted exchange');
  assert.equal(movements.length, 0, 'Deleted exchange must have no remaining ledger movements');
}

async function raceExpensePatchPatch(user: { id: string }, iteration: number) {
  const expense = await prisma.expense.create({
    data: {
      userId: user.id, title: `Concurrent edit expense ${iteration}`, category: 'Concurrency test',
      amount: 100, currency: 'RUB', amountRub: 100, date: new Date(),
    },
  });
  await prisma.$transaction(tx => syncExpenseLedger(tx, expense));

  const patchTo125 = prisma.$transaction(async tx => {
    const result = await tx.expense.updateMany({
      where: { id: expense.id, userId: user.id },
      data: { amount: 125, amountRub: 125 },
    });
    if (!result.count) return;
    const current = await tx.expense.findFirst({ where: { id: expense.id, userId: user.id } });
    if (current) await syncExpenseLedger(tx, current);
  });
  const patchTo150 = prisma.$transaction(async tx => {
    const result = await tx.expense.updateMany({
      where: { id: expense.id, userId: user.id },
      data: { amount: 150, amountRub: 150 },
    });
    if (!result.count) return;
    const current = await tx.expense.findFirst({ where: { id: expense.id, userId: user.id } });
    if (current) await syncExpenseLedger(tx, current);
  });
  await Promise.all([patchTo125, patchTo150]);

  const [saved, rows] = await Promise.all([
    prisma.expense.findFirst({ where: { id: expense.id, userId: user.id } }),
    prisma.walletMovement.findMany({
      where: { userId: user.id, sourceKey: { startsWith: `expense:${expense.id}:` } },
    }),
  ]);
  assert.ok(saved, 'Concurrent PATCH/PATCH must leave the expense present');
  assert.equal(rows.length, 1, 'Concurrent expense edits must leave exactly one movement');
  assert.equal(rows[0].sourceKey, `expense:${expense.id}:RUB`);
  assert.equal(Number(rows[0].amountDelta), -Number(saved.amount),
    'Final expense movement must match the final committed source amount');
  await prisma.$transaction(async tx => {
    await tx.expense.deleteMany({ where: { id: expense.id, userId: user.id } });
    await removeExpenseLedger(tx, user.id, expense.id);
  });
}

async function raceExchangePatchPatch(user: { id: string }) {
  const exchange = await prisma.exchange.create({
    data: {
      userId: user.id, mode: 'RUB_USDT_VND', targetCurrency: 'VND',
      rubSpent: 1000, usdtReceived: 10, vndReceived: 250000,
      effectiveRubPerUsdt: 100, effectiveVndPerRub: 250,
    },
  });
  await prisma.$transaction(tx => syncExchangeLedger(tx, exchange));

  const patch = (rubSpent: number, usdtReceived: number, vndReceived: number) =>
    prisma.$transaction(async tx => {
      const result = await tx.exchange.updateMany({
        where: { id: exchange.id, userId: user.id },
        data: { rubSpent, usdtReceived, vndReceived },
      });
      if (!result.count) return;
      const current = await tx.exchange.findFirst({ where: { id: exchange.id, userId: user.id } });
      if (current) await syncExchangeLedger(tx, current);
    });
  await Promise.all([
    patch(1100, 11, 275000),
    patch(1200, 12, 300000),
  ]);

  const [saved, rows] = await Promise.all([
    prisma.exchange.findFirst({ where: { id: exchange.id, userId: user.id } }),
    prisma.walletMovement.findMany({
      where: { userId: user.id, sourceKey: { startsWith: `exchange:${exchange.id}:` } },
      orderBy: { sourceKey: 'asc' },
    }),
  ]);
  assert.ok(saved, 'Concurrent PATCH/PATCH must leave the exchange present');
  assert.deepEqual(
    rows.map(row => [row.currency, Number(row.amountDelta), row.sourceKey]),
    [
      ['RUB', -Number(saved.rubSpent), `exchange:${exchange.id}:RUB`],
      ['USDT', Number(saved.usdtReceived), `exchange:${exchange.id}:USDT`],
      ['VND', Number(saved.vndReceived), `exchange:${exchange.id}:VND`],
    ],
    'All exchange currency legs must match the final committed exchange after concurrent edits',
  );
  await prisma.$transaction(async tx => {
    await tx.exchange.deleteMany({ where: { id: exchange.id, userId: user.id } });
    await removeExchangeLedger(tx, user.id, exchange.id);
  });
}


async function raceExpenseCurrencyTransition(user: { id: string }, iteration: number) {
  const expense = await prisma.expense.create({
    data: {
      userId: user.id, title: `Concurrent currency expense ${iteration}`, category: 'Concurrency test',
      amount: 100, currency: 'RUB', amountRub: 100, date: new Date(),
    },
  });
  await prisma.$transaction(tx => syncExpenseLedger(tx, expense));

  const patchCard = prisma.$transaction(async tx => {
    const result = await tx.expense.updateMany({
      where: { id: expense.id, userId: user.id },
      data: { amount: 50_000, currency: 'VND', amountVnd: 50_000, amountRub: null, usdtCharged: 2.1 },
    });
    if (!result.count) return;
    const current = await tx.expense.findFirst({ where: { id: expense.id, userId: user.id } });
    if (current) await syncExpenseLedger(tx, current);
  });
  const patchCash = prisma.$transaction(async tx => {
    const result = await tx.expense.updateMany({
      where: { id: expense.id, userId: user.id },
      data: { amount: 175, currency: 'RUB', amountVnd: null, amountRub: 175, usdtCharged: null },
    });
    if (!result.count) return;
    const current = await tx.expense.findFirst({ where: { id: expense.id, userId: user.id } });
    if (current) await syncExpenseLedger(tx, current);
  });
  await Promise.all([patchCard, patchCash]);

  const [saved, rows] = await Promise.all([
    prisma.expense.findFirst({ where: { id: expense.id, userId: user.id } }),
    prisma.walletMovement.findMany({
      where: { userId: user.id, sourceKey: { startsWith: `expense:${expense.id}:` } },
      orderBy: { sourceKey: 'asc' },
    }),
  ]);
  assert.ok(saved, 'Concurrent expense currency transitions must leave the source record present');
  const expected = saved.currency.trim().toUpperCase() === 'VND' && saved.usdtCharged != null
    ? [['USDT', -Number(saved.usdtCharged), `expense:${expense.id}:USDT`]]
    : [['RUB', -Number(saved.amount), `expense:${expense.id}:RUB`]];
  assert.deepEqual(
    rows.map(row => [row.currency, Number(row.amountDelta), row.sourceKey]),
    expected,
    'Concurrent cash/card currency transitions must leave only the final expense debit',
  );
  await prisma.$transaction(async tx => {
    await tx.expense.deleteMany({ where: { id: expense.id, userId: user.id } });
    await removeExpenseLedger(tx, user.id, expense.id);
  });
}

async function raceExchangeModeTransition(user: { id: string }, iteration: number) {
  const exchange = await prisma.exchange.create({
    data: {
      userId: user.id, mode: 'RUB_USDT_VND', targetCurrency: 'VND',
      rubSpent: 1000, usdtReceived: 10, vndReceived: 250_000,
      effectiveRubPerUsdt: 100, effectiveVndPerRub: 250,
    },
  });
  await prisma.$transaction(tx => syncExchangeLedger(tx, exchange));

  const patchDirectTarget = prisma.$transaction(async tx => {
    const result = await tx.exchange.updateMany({
      where: { id: exchange.id, userId: user.id },
      data: {
        mode: 'RUB_TARGET', targetCurrency: 'USDT', rubSpent: 1100,
        usdtReceived: null, vndReceived: null, vndFee: 0,
        targetReceived: 11.5, targetToVndRate: null, targetVndEquivalent: null,
      },
    });
    if (!result.count) return;
    const current = await tx.exchange.findFirst({ where: { id: exchange.id, userId: user.id } });
    if (current) await syncExchangeLedger(tx, current);
  });
  const patchIndirect = prisma.$transaction(async tx => {
    const result = await tx.exchange.updateMany({
      where: { id: exchange.id, userId: user.id },
      data: {
        mode: 'RUB_USDT_VND', targetCurrency: 'VND', rubSpent: 1200,
        usdtReceived: 12, vndReceived: 300_000, vndFee: 0,
      },
    });
    if (!result.count) return;
    const current = await tx.exchange.findFirst({ where: { id: exchange.id, userId: user.id } });
    if (current) await syncExchangeLedger(tx, current);
  });
  await Promise.all([patchDirectTarget, patchIndirect]);

  const [saved, rows] = await Promise.all([
    prisma.exchange.findFirst({ where: { id: exchange.id, userId: user.id } }),
    prisma.walletMovement.findMany({
      where: { userId: user.id, sourceKey: { startsWith: `exchange:${exchange.id}:` } },
      orderBy: { sourceKey: 'asc' },
    }),
  ]);
  assert.ok(saved, 'Concurrent exchange mode transitions must leave the source record present');
  const expected = saved.mode === 'RUB_TARGET' && saved.targetCurrency.trim().toUpperCase() === 'USDT'
    ? [
        ['RUB', -Number(saved.rubSpent), `exchange:${exchange.id}:RUB`],
        ['USDT', Number(saved.targetReceived), `exchange:${exchange.id}:USDT`],
      ]
    : [
        ['RUB', -Number(saved.rubSpent), `exchange:${exchange.id}:RUB`],
        ['USDT', Number(saved.usdtReceived), `exchange:${exchange.id}:USDT`],
        ['VND', Number(saved.vndReceived), `exchange:${exchange.id}:VND`],
      ];
  assert.deepEqual(
    rows.map(row => [row.currency, Number(row.amountDelta), row.sourceKey]),
    expected,
    'Concurrent exchange mode transitions must remove stale legs and match the final source mode',
  );
  await prisma.$transaction(async tx => {
    await tx.exchange.deleteMany({ where: { id: exchange.id, userId: user.id } });
    await removeExchangeLedger(tx, user.id, exchange.id);
  });
}

try {
  const user = await prisma.user.create({
    data: { email: `${suffix}@example.invalid`, passwordHash: 'test-only' },
  });
  userId = user.id;

  // Repeated races increase the chance of exercising both transaction orderings.
  for (let iteration = 1; iteration <= 5; iteration += 1) {
    await raceExpense(user, iteration);
    await raceExchange(user, iteration);
    await raceExpensePatchPatch(user, iteration);
    await raceExchangePatchPatch(user);
    await raceExpenseCurrencyTransition(user, iteration);
    await raceExchangeModeTransition(user, iteration);
  }

  console.log('Concurrent PostgreSQL mutations verified: PATCH/DELETE leaves no orphaned movements; concurrent PATCH/PATCH keeps expense and exchange ledger rows consistent with final source records, including currency and exchange-mode transitions.');
} finally {
  if (userId) await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
}
