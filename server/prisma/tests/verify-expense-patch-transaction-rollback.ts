import assert from 'node:assert/strict';
import { prisma } from '../../src/services/prisma.js';
import { syncExpenseLedger } from '../../src/lib/wallet-ledger.js';

const suffix = `expense-patch-rollback-${Date.now()}`;
let ownerId: string | undefined;
let conflictOwnerId: string | undefined;
let expenseId: string | undefined;

try {
  const [owner, conflictOwner] = await Promise.all([
    prisma.user.create({ data: { email: `${suffix}-owner@example.invalid`, passwordHash: 'test-only' } }),
    prisma.user.create({ data: { email: `${suffix}-conflict@example.invalid`, passwordHash: 'test-only' } }),
  ]);
  ownerId = owner.id;
  conflictOwnerId = conflictOwner.id;

  const expense = await prisma.expense.create({
    data: {
      userId: owner.id, title: 'Expense PATCH rollback probe', category: 'Test',
      amount: 100, currency: 'RUB', amountRub: 100, date: new Date(),
    },
  });
  expenseId = expense.id;
  await prisma.$transaction(tx => syncExpenseLedger(tx, expense));

  // Reserve the future USDT source key under another owner. A currency/payment
  // method edit must fail safely rather than deleting a foreign user's row.
  const conflictKey = `expense:${expense.id}:USDT`;
  await prisma.walletMovement.create({
    data: {
      userId: conflictOwner.id, currency: 'USDT', amountDelta: -1,
      kind: 'EXPENSE', sourceKey: conflictKey, note: 'Intentional cross-owner conflict',
    },
  });

  await assert.rejects(prisma.$transaction(async tx => {
    const updated = await tx.expense.updateMany({
      where: { id: expense.id, userId: owner.id },
      data: {
        amount: 50_000, currency: 'VND', amountVnd: 50_000,
        amountRub: null, usdtCharged: 2.1,
      },
    });
    assert.equal(updated.count, 1);
    const current = await tx.expense.findFirst({ where: { id: expense.id, userId: owner.id } });
    assert.ok(current);
    await syncExpenseLedger(tx, current);
  }));

  const [saved, ownerMovements, conflictMovement] = await Promise.all([
    prisma.expense.findUniqueOrThrow({ where: { id: expense.id } }),
    prisma.walletMovement.findMany({
      where: { userId: owner.id, sourceKey: { startsWith: `expense:${expense.id}:` } },
      orderBy: { sourceKey: 'asc' },
    }),
    prisma.walletMovement.findUnique({ where: { sourceKey: conflictKey } }),
  ]);
  assert.equal(saved.currency, 'RUB', 'Expense PATCH must roll back when ledger synchronization fails');
  assert.equal(Number(saved.amount), 100, 'Original expense amount must survive the failed PATCH');
  assert.deepEqual(
    ownerMovements.map(row => [row.currency, Number(row.amountDelta), row.sourceKey]),
    [['RUB', -100, `expense:${expense.id}:RUB`]],
    'Original RUB movement must be restored when replacement USDT movement conflicts',
  );
  assert.equal(conflictMovement?.userId, conflictOwner.id, 'Foreign conflicting movement must remain unchanged');

  console.log('Expense PATCH rollback verified: failed currency/payment-method transition restores the source expense and original ledger movement.');
} finally {
  if (expenseId) await prisma.expense.deleteMany({ where: { id: expenseId } });
  if (ownerId) await prisma.user.deleteMany({ where: { id: ownerId } });
  if (conflictOwnerId) await prisma.user.deleteMany({ where: { id: conflictOwnerId } });
  await prisma.$disconnect();
}
