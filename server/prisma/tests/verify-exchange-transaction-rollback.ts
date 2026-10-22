import assert from 'node:assert/strict';
import { prisma } from '../../src/services/prisma.js';
import { syncExchangeLedger } from '../../src/lib/wallet-ledger.js';

const suffix = `exchange-rollback-${Date.now()}`;
let ownerId: string | undefined;
let conflictOwnerId: string | undefined;
let exchangeId: string | undefined;

try {
  const [owner, conflictOwner] = await Promise.all([
    prisma.user.create({ data: { email: `${suffix}-owner@example.invalid`, passwordHash: 'test-only' } }),
    prisma.user.create({ data: { email: `${suffix}-conflict@example.invalid`, passwordHash: 'test-only' } }),
  ]);
  ownerId = owner.id;
  conflictOwnerId = conflictOwner.id;

  const exchange = await prisma.exchange.create({
    data: {
      userId: owner.id,
      mode: 'RUB_USDT_VND',
      targetCurrency: 'VND',
      rubSpent: 8300,
      usdtReceived: 93.7853,
    },
  });
  exchangeId = exchange.id;

  // A conflicting source key owned by another user cannot be removed by the
  // exchange's owner-scoped ledger synchronization.
  await prisma.walletMovement.create({
    data: {
      userId: conflictOwner.id,
      currency: 'USDT',
      amountDelta: 1,
      kind: 'EXCHANGE',
      sourceKey: `exchange:${exchange.id}:USDT`,
      note: 'Intentional cross-owner unique-key conflict',
    },
  });
  await prisma.walletMovement.create({
    data: {
      userId: owner.id,
      currency: 'RUB',
      amountDelta: -8300,
      kind: 'EXCHANGE',
      sourceKey: `exchange:${exchange.id}:RUB`,
      note: 'Existing owner ledger row',
    },
  });

  await assert.rejects(
    prisma.$transaction(async tx => {
      await tx.exchange.update({
        where: { id: exchange.id },
        data: { rubSpent: 9000 },
      });
      const updated = await tx.exchange.findUniqueOrThrow({ where: { id: exchange.id } });
      await syncExchangeLedger(tx, updated);
    }),
    /Unique constraint|unique constraint|UniqueViolation|duplicate key/i,
  );

  const [savedExchange, ownerMovements, conflictMovement] = await Promise.all([
    prisma.exchange.findUniqueOrThrow({ where: { id: exchange.id } }),
    prisma.walletMovement.findMany({
      where: { userId: owner.id, sourceKey: { startsWith: `exchange:${exchange.id}:` } },
      orderBy: { sourceKey: 'asc' },
    }),
    prisma.walletMovement.findUnique({ where: { sourceKey: `exchange:${exchange.id}:USDT` } }),
  ]);

  assert.equal(Number(savedExchange.rubSpent), 8300, 'Exchange edit must roll back when ledger sync fails');
  assert.deepEqual(
    ownerMovements.map(row => [row.currency, Number(row.amountDelta), row.sourceKey]),
    [['RUB', -8300, `exchange:${exchange.id}:RUB`]],
    'Owner ledger deletion must roll back when replacement movements fail',
  );
  assert.equal(conflictMovement?.userId, conflictOwner.id, 'Conflicting foreign ledger row must remain unchanged');

  console.log('Exchange transaction rollback verified: exchange values and owner ledger rows remain unchanged after a failed ledger sync.');
} finally {
  if (exchangeId) await prisma.exchange.deleteMany({ where: { id: exchangeId } });
  if (ownerId) await prisma.user.deleteMany({ where: { id: ownerId } });
  if (conflictOwnerId) await prisma.user.deleteMany({ where: { id: conflictOwnerId } });
  await prisma.$disconnect();
}
