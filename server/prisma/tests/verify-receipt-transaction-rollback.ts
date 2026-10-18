import assert from 'node:assert/strict';
import { prisma } from '../../src/services/prisma.js';
import { syncExpenseLedger } from '../../src/lib/wallet-ledger.js';

const suffix = `receipt-rollback-${Date.now()}`;
const receiptId = `receipt-${suffix}`;
const expenseId = `expense-${suffix}`;
const conflictKey = `expense:${expenseId}:VND`;
let ownerId: string | undefined;
let conflictOwnerId: string | undefined;

try {
  const [owner, conflictOwner] = await Promise.all([
    prisma.user.create({ data: { email: `${suffix}-owner@example.invalid`, passwordHash: 'test-only' } }),
    prisma.user.create({ data: { email: `${suffix}-conflict@example.invalid`, passwordHash: 'test-only' } }),
  ]);
  ownerId = owner.id;
  conflictOwnerId = conflictOwner.id;

  await prisma.walletMovement.create({
    data: {
      userId: conflictOwner.id,
      currency: 'VND',
      amountDelta: -1,
      kind: 'EXPENSE',
      sourceKey: conflictKey,
      note: 'Foreign row used to force a unique-key violation',
    },
  });

  await assert.rejects(prisma.$transaction(async tx => {
    const receipt = await tx.receipt.create({
      data: { id: receiptId, userId: owner.id, rawText: 'rollback fixture', items: [{ name: 'Test item', price: 100 }] },
    });
    const expense = await tx.expense.create({
      data: {
        id: expenseId,
        userId: owner.id,
        title: 'Receipt rollback probe',
        category: 'Test',
        amount: 100,
        currency: 'VND',
        amountVnd: 100,
        amountRub: 1,
        date: new Date(),
        receiptId: receipt.id,
      },
    });
    // The conflicting sourceKey belongs to another user. Owner-scoped cleanup
    // must not delete it; the unique violation must roll back receipt and expense.
    await syncExpenseLedger(tx, expense);
  }));

  const [receiptCount, expenseCount, conflictMovement] = await Promise.all([
    prisma.receipt.count({ where: { id: receiptId, userId: owner.id } }),
    prisma.expense.count({ where: { id: expenseId, userId: owner.id } }),
    prisma.walletMovement.findUnique({ where: { sourceKey: conflictKey } }),
  ]);
  assert.equal(receiptCount, 0, 'Receipt must roll back when its expense ledger write fails');
  assert.equal(expenseCount, 0, 'Receipt expense must roll back when its ledger write fails');
  assert.equal(conflictMovement?.userId, conflictOwner.id, 'Foreign conflicting movement must remain unchanged');

  console.log('Receipt transaction rollback verified: receipt and expense inserts rolled back; foreign ledger row preserved.');
} finally {
  if (ownerId) await prisma.user.deleteMany({ where: { id: ownerId } });
  if (conflictOwnerId) await prisma.user.deleteMany({ where: { id: conflictOwnerId } });
  await prisma.$disconnect();
}
