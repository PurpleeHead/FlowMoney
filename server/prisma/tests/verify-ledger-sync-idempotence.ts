import assert from 'node:assert/strict';
import { prisma } from '../../src/services/prisma.js';
import { syncExpenseLedger, syncExchangeLedger } from '../../src/lib/wallet-ledger.js';

const suffix = `ledger-sync-idempotence-${Date.now()}`;
let userId: string | undefined;
let expenseId: string | undefined;
let exchangeId: string | undefined;

async function movements(prefix: string) {
  return prisma.walletMovement.findMany({
    where: { userId, sourceKey: { startsWith: prefix } },
    orderBy: { sourceKey: 'asc' },
  });
}

try {
  const user = await prisma.user.create({
    data: { email: `${suffix}@example.invalid`, passwordHash: 'test-only' },
  });
  userId = user.id;

  const expense = await prisma.expense.create({
    data: {
      userId: user.id, title: 'Idempotent card expense', category: 'Test',
      amount: 55_536, currency: 'VND', amountVnd: 55_536, usdtCharged: 2.19,
      date: new Date('2026-10-18T08:00:00.000Z'),
    },
  });
  expenseId = expense.id;

  // Repeating synchronization must replace, not duplicate, movements.
  await prisma.$transaction(tx => syncExpenseLedger(tx, expense));
  await prisma.$transaction(tx => syncExpenseLedger(tx, expense));
  let expenseMovements = await movements(`expense:${expense.id}:`);
  assert.deepEqual(
    expenseMovements.map(row => [row.currency, Number(row.amountDelta), row.sourceKey]),
    [['USDT', -2.19, `expense:${expense.id}:USDT`]],
    'Repeated card-expense sync must produce exactly one stable USDT debit',
  );

  // Change a card expense into a cash expense. The old USDT leg must be removed.
  const cashExpense = await prisma.expense.update({
    where: { id: expense.id },
    data: { amount: 60_000, amountVnd: 60_000, usdtCharged: null },
  });
  await prisma.$transaction(tx => syncExpenseLedger(tx, cashExpense));
  await prisma.$transaction(tx => syncExpenseLedger(tx, cashExpense));
  expenseMovements = await movements(`expense:${expense.id}:`);
  assert.deepEqual(
    expenseMovements.map(row => [row.currency, Number(row.amountDelta), row.sourceKey]),
    [['VND', -60_000, `expense:${expense.id}:VND`]],
    'Card-to-cash edit must remove stale USDT debit and leave one VND debit',
  );

  const exchange = await prisma.exchange.create({
    data: {
      userId: user.id, mode: 'RUB_USDT_VND', targetCurrency: 'VND',
      rubSpent: 8300, usdtReceived: 93.7853, vndReceived: 2_300_000,
    },
  });
  exchangeId = exchange.id;

  await prisma.$transaction(tx => syncExchangeLedger(tx, exchange));
  await prisma.$transaction(tx => syncExchangeLedger(tx, exchange));
  let exchangeMovements = await movements(`exchange:${exchange.id}:`);
  assert.deepEqual(
    exchangeMovements.map(row => [row.currency, Number(row.amountDelta), row.sourceKey]),
    [
      ['RUB', -8300, `exchange:${exchange.id}:RUB`],
      ['USDT', 93.7853, `exchange:${exchange.id}:USDT`],
      ['VND', 2_300_000, `exchange:${exchange.id}:VND`],
    ],
    'Repeated indirect exchange sync must keep exactly three stable currency legs',
  );

  // Editing the same operation to a direct RUB→VND exchange must remove its
  // old USDT leg and use the actual net VND result, not the gross legacy target.
  const directExchange = await prisma.exchange.update({
    where: { id: exchange.id },
    data: {
      mode: 'RUB_VND', targetCurrency: 'VND', rubSpent: 9000,
      usdtReceived: null, vndReceived: 245_000, vndFee: 5_000,
      targetReceived: 250_000,
    },
  });
  await prisma.$transaction(tx => syncExchangeLedger(tx, directExchange));
  await prisma.$transaction(tx => syncExchangeLedger(tx, directExchange));
  exchangeMovements = await movements(`exchange:${exchange.id}:`);
  assert.deepEqual(
    exchangeMovements.map(row => [row.currency, Number(row.amountDelta), row.sourceKey]),
    [
      ['RUB', -9000, `exchange:${exchange.id}:RUB`],
      ['VND', 245_000, `exchange:${exchange.id}:VND`],
    ],
    'Indirect-to-direct edit must remove stale USDT and credit only net VND after fee',
  );

  console.log('PostgreSQL ledger sync idempotence verified: repeated expense/exchange syncs do not duplicate movements; currency/mode edits remove stale legs and preserve stable source keys.');
} finally {
  if (expenseId) await prisma.expense.deleteMany({ where: { id: expenseId } });
  if (exchangeId) await prisma.exchange.deleteMany({ where: { id: exchangeId } });
  if (userId) await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
}
