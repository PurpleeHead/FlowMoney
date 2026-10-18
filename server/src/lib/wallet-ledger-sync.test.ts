import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Prisma } from '@prisma/client';
import {
  removeExchangeLedger,
  removeExpenseLedger,
  syncExchangeLedger,
  syncExpenseLedger,
} from './wallet-ledger.js';

function makeTx() {
  const deleted: unknown[] = [];
  const created: unknown[] = [];
  const tx = {
    walletMovement: {
      deleteMany: async (args: unknown) => { deleted.push(args); return { count: 1 }; },
      createMany: async (args: unknown) => { created.push(args); return { count: 1 }; },
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, deleted, created };
}

describe('wallet ledger synchronization', () => {
  it('replaces expense movements using the source owner and expense prefix', async () => {
    const { tx, deleted, created } = makeTx();
    await syncExpenseLedger(tx, {
      id: 'expense-1', userId: 'user-1', amount: 55536, currency: 'VND',
      usdtCharged: 2.19, date: new Date('2026-10-16T08:00:00.000Z'),
    });
    assert.deepEqual(deleted, [{
      where: { userId: 'user-1', sourceKey: { startsWith: 'expense:expense-1:' } },
    }]);
    assert.deepEqual(created, [{
      data: [{
        userId: 'user-1', currency: 'USDT', amountDelta: -2.19, kind: 'EXPENSE',
        sourceKey: 'expense:expense-1:USDT', occurredAt: new Date('2026-10-16T08:00:00.000Z'),
        note: 'Expense expense-1',
      }],
    }]);
  });

  it('replaces exchange movements with only the known currency legs', async () => {
    const { tx, deleted, created } = makeTx();
    await syncExchangeLedger(tx, {
      id: 'exchange-1', userId: 'user-1', mode: 'RUB_USDT_VND', rubSpent: 8300,
      usdtReceived: 93.7853, vndReceived: null, targetCurrency: 'VND',
      targetReceived: null, createdAt: new Date('2026-10-16T07:00:00.000Z'),
    });
    assert.deepEqual(deleted, [{
      where: { userId: 'user-1', sourceKey: { startsWith: 'exchange:exchange-1:' } },
    }]);
    assert.deepEqual((created[0] as { data: Array<{ currency: string; amountDelta: number }> }).data.map(x => [x.currency, x.amountDelta]), [
      ['RUB', -8300],
      ['USDT', 93.7853],
    ]);
  });

  it('removes only the selected user source ledger rows on deletion', async () => {
    const expenseTx = makeTx();
    await removeExpenseLedger(expenseTx.tx, 'user-1', 'expense-2');
    assert.deepEqual(expenseTx.deleted, [{
      where: { userId: 'user-1', sourceKey: { startsWith: 'expense:expense-2:' } },
    }]);

    const exchangeTx = makeTx();
    await removeExchangeLedger(exchangeTx.tx, 'user-1', 'exchange-2');
    assert.deepEqual(exchangeTx.deleted, [{
      where: { userId: 'user-1', sourceKey: { startsWith: 'exchange:exchange-2:' } },
    }]);
  });
});
