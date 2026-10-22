import assert from 'node:assert/strict';
import { prisma } from '../../src/services/prisma.js';

const email = `wallet-rollback-${Date.now()}@example.invalid`;
const sourceKey = `rollback-test:${Date.now()}`;
let userId: string | undefined;

try {
  const user = await prisma.user.create({
    data: { email, passwordHash: 'test-only-not-a-real-password' },
  });
  userId = user.id;

  await prisma.walletMovement.create({
    data: {
      userId,
      currency: 'RUB',
      amountDelta: -1,
      kind: 'EXPENSE',
      sourceKey,
      note: 'Existing row used to force a unique-key violation',
    },
  });

  await assert.rejects(
    prisma.$transaction(async tx => {
      await tx.expense.create({
        data: {
          userId: user!.id,
          title: 'Rollback probe',
          category: 'Test',
          amount: 100,
          currency: 'RUB',
          amountRub: 100,
          date: new Date(),
        },
      });
      // This violates WalletMovement.sourceKey uniqueness after the expense insert.
      // PostgreSQL must roll back the earlier insert as part of the same transaction.
      await tx.walletMovement.create({
        data: {
          userId: user!.id,
          currency: 'RUB',
          amountDelta: -100,
          kind: 'EXPENSE',
          sourceKey,
          note: 'Intentional failure',
        },
      });
    }),
  );

  const [expenseCount, movementCount] = await Promise.all([
    prisma.expense.count({ where: { userId, title: 'Rollback probe' } }),
    prisma.walletMovement.count({ where: { userId, sourceKey } }),
  ]);
  assert.equal(expenseCount, 0, 'Expense insert must roll back when ledger write fails');
  assert.equal(movementCount, 1, 'Pre-existing ledger row must remain intact');

  console.log('Transaction rollback verified: failed ledger write left no expense and preserved the original ledger row.');
} finally {
  if (userId) {
    await prisma.user.delete({ where: { id: userId } });
  }
  await prisma.$disconnect();
}
