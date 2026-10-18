import assert from 'node:assert/strict';
import { prisma } from '../../src/services/prisma.js';
import { removeExpenseLedger, removeExchangeLedger } from '../../src/lib/wallet-ledger.js';

const suffix = `delete-rollback-${Date.now()}`;
let userId: string | undefined;
let conflictUserId: string | undefined;
let expenseId: string | undefined;
let exchangeId: string | undefined;

try {
  const [user, conflictUser] = await Promise.all([
    prisma.user.create({ data: { email: `${suffix}-owner@example.invalid`, passwordHash: 'test-only' } }),
    prisma.user.create({ data: { email: `${suffix}-conflict@example.invalid`, passwordHash: 'test-only' } }),
  ]);
  userId = user.id;
  conflictUserId = conflictUser.id;

  const expense = await prisma.expense.create({
    data: {
      userId: user.id, title: 'Delete rollback probe', category: 'Test',
      amount: 100, currency: 'RUB', amountRub: 100, date: new Date(),
    },
  });
  expenseId = expense.id;

  const exchange = await prisma.exchange.create({
    data: { userId: user.id, mode: 'RUB_USDT_VND', targetCurrency: 'VND', rubSpent: 8300, usdtReceived: 93.7853 },
  });
  exchangeId = exchange.id;

  const conflictKey = `delete-rollback-conflict:${suffix}`;
  await prisma.walletMovement.create({
    data: { userId: conflictUser.id, currency: 'RUB', amountDelta: -1, kind: 'EXPENSE', sourceKey: conflictKey },
  });
  await prisma.walletMovement.createMany({
    data: [
      { userId: user.id, currency: 'RUB', amountDelta: -100, kind: 'EXPENSE', sourceKey: `expense:${expense.id}:RUB` },
      { userId: user.id, currency: 'RUB', amountDelta: -8300, kind: 'EXCHANGE', sourceKey: `exchange:${exchange.id}:RUB` },
      { userId: user.id, currency: 'USDT', amountDelta: 93.7853, kind: 'EXCHANGE', sourceKey: `exchange:${exchange.id}:USDT` },
    ],
  });

  await assert.rejects(prisma.$transaction(async tx => {
    const deleted = await tx.expense.deleteMany({ where: { id: expense.id, userId: user.id } });
    assert.equal(deleted.count, 1);
    await removeExpenseLedger(tx, user.id, expense.id);
    // Force failure after both the entity and its ledger rows were deleted.
    await tx.walletMovement.create({
      data: { userId: user.id, currency: 'RUB', amountDelta: 1, kind: 'EXPENSE', sourceKey: conflictKey },
    });
  }));

  const [savedExpense, expenseMovement] = await Promise.all([
    prisma.expense.findUnique({ where: { id: expense.id } }),
    prisma.walletMovement.findUnique({ where: { sourceKey: `expense:${expense.id}:RUB` } }),
  ]);
  assert.ok(savedExpense, 'Expense delete must roll back when a later ledger transaction step fails');
  assert.equal(expenseMovement?.userId, user.id, 'Expense ledger row must be restored by rollback');

  await assert.rejects(prisma.$transaction(async tx => {
    const deleted = await tx.exchange.deleteMany({ where: { id: exchange.id, userId: user.id } });
    assert.equal(deleted.count, 1);
    await removeExchangeLedger(tx, user.id, exchange.id);
    // Force failure after both the exchange and its ledger rows were deleted.
    await tx.walletMovement.create({
      data: { userId: user.id, currency: 'RUB', amountDelta: 1, kind: 'EXCHANGE', sourceKey: conflictKey },
    });
  }));

  const [savedExchange, exchangeMovements, foreignConflict] = await Promise.all([
    prisma.exchange.findUnique({ where: { id: exchange.id } }),
    prisma.walletMovement.findMany({
      where: { userId: user.id, sourceKey: { startsWith: `exchange:${exchange.id}:` } },
      orderBy: { sourceKey: 'asc' },
    }),
    prisma.walletMovement.findUnique({ where: { sourceKey: conflictKey } }),
  ]);
  assert.ok(savedExchange, 'Exchange delete must roll back when a later ledger transaction step fails');
  assert.deepEqual(
    exchangeMovements.map(row => [row.currency, Number(row.amountDelta)]),
    [['RUB', -8300], ['USDT', 93.7853]],
    'All exchange ledger rows must be restored by rollback',
  );
  assert.equal(foreignConflict?.userId, conflictUser.id, 'Foreign conflicting movement must remain unchanged');

  console.log('Delete transaction rollback verified for expense and exchange; entities and ledger rows were restored after simulated failures.');
} finally {
  if (expenseId) await prisma.expense.deleteMany({ where: { id: expenseId } });
  if (exchangeId) await prisma.exchange.deleteMany({ where: { id: exchangeId } });
  if (userId) await prisma.user.deleteMany({ where: { id: userId } });
  if (conflictUserId) await prisma.user.deleteMany({ where: { id: conflictUserId } });
  await prisma.$disconnect();
}
