import assert from 'node:assert/strict';
import { prisma } from '../../src/services/prisma.js';
import { aggregateDashboardExchanges } from '../../src/lib/dashboard-exchange-aggregate.js';

const suffix = `dashboard-cost-basis-edge-${Date.now()}`;
let userId: string | undefined;

try {
  const user = await prisma.user.create({
    data: { email: `${suffix}@example.invalid`, passwordHash: 'test-only' },
  });
  userId = user.id;

  await prisma.exchange.createMany({
    data: [
      {
        userId,
        mode: 'RUB_VND',
        targetCurrency: 'VND',
        rubSpent: 1_000,
        vndReceived: 250_000,
      },
      {
        // Legacy/corrupt row: proceeds exist but no positive RUB cost basis.
        // It must not inflate the numerator of the effective VND/RUB rate.
        userId,
        mode: 'RUB_VND',
        targetCurrency: 'VND',
        rubSpent: 0,
        vndReceived: 777_000,
      },
      {
        // A direct-target legacy row with no RUB cost basis must be excluded too.
        userId,
        mode: 'RUB_TARGET',
        targetCurrency: 'VND',
        rubSpent: 0,
        targetReceived: 999_000,
        targetVndEquivalent: 999_000,
        vndReceived: 888_000,
      },
    ],
  });

  const aggregate = await aggregateDashboardExchanges(userId);
  assert.equal(aggregate.directRub, 1_000, 'only exchanges with positive RUB cost contribute to direct RUB cost basis');
  assert.equal(aggregate.directVnd, 250_000, 'direct VND numerator must use the same eligibility predicate as its RUB denominator');
  assert.equal(aggregate.confirmedVnd, 2_026_000, 'this regression is limited to effective-rate cost basis; preserve the existing confirmed-balance policy for legacy zero-cost rows');

  console.log('Dashboard cost-basis edge-case fixture passed: zero-cost direct VND rows do not distort effective-rate numerator.');
} finally {
  if (userId) await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
}
