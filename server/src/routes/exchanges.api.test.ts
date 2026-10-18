import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'node:net';
import { prisma } from '../services/prisma.js';
import exchangeRoutes from './exchanges.js';

const client = prisma as unknown as { $transaction: (...args: any[]) => Promise<any> };
const originalTransaction = client.$transaction;
const previousSecret = process.env.JWT_SECRET;

afterEach(() => {
  client.$transaction = originalTransaction;
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
});

async function withApi(run: (baseUrl: string) => Promise<void>) {
  process.env.JWT_SECRET = 'exchange-api-test-secret';
  const app = express();
  app.use(express.json());
  app.use('/api/exchanges', exchangeRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function bearer(userId = 'user-1') {
  return `Bearer ${jwt.sign({ id: userId, email: `${userId}@example.com` }, 'exchange-api-test-secret')}`;
}

describe('exchange API ledger synchronization', () => {
  it('updates an exchange and replaces its ledger movements in the same transaction', async () => {
    let updateArgs: any;
    const deleted: any[] = [];
    const created: any[] = [];
    const current = {
      id: 'exchange-1', userId: 'user-42', mode: 'RUB_USDT_VND', rubSpent: 8300,
      usdtReceived: 93.7853, vndReceived: null, targetCurrency: 'VND',
      targetReceived: null, createdAt: new Date('2026-10-18T08:00:00.000Z'),
    };
    const tx = {
      exchange: {
        updateMany: async (args: any) => { updateArgs = args; return { count: 1 }; },
        findFirst: async () => current,
      },
      walletMovement: {
        deleteMany: async (args: any) => { deleted.push(args); return { count: 2 }; },
        createMany: async (args: any) => { created.push(args); return { count: args.data.length }; },
      },
    };
    client.$transaction = async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx);

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/exchanges/exchange-1`, {
        method: 'PATCH',
        headers: { authorization: bearer('user-42'), 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'RUB_USDT_VND', rubSpent: 8300, usdtReceived: 93.7853,
          vndFee: 0, targetCurrency: 'VND',
        }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(updateArgs.where, { id: 'exchange-1', userId: 'user-42' });
      assert.deepEqual(deleted, [{
        where: { userId: 'user-42', sourceKey: { startsWith: 'exchange:exchange-1:' } },
      }]);
      const movements = created[0].data as Array<{ currency: string; amountDelta: number }>;
      assert.deepEqual(movements.map(item => [item.currency, item.amountDelta]), [
        ['RUB', -8300],
        ['USDT', 93.7853],
      ]);
    });
  });

  it('returns 404 and leaves ledger rows untouched when updating another user exchange', async () => {
    let updateArgs: any;
    const movementDeleteArgs: any[] = [];
    const movementCreateArgs: any[] = [];
    const tx = {
      exchange: {
        updateMany: async (args: any) => {
          updateArgs = args;
          return { count: 0 };
        },
        findFirst: async () => {
          throw new Error('exchange lookup must not run after an owner-scoped update matches no row');
        },
      },
      walletMovement: {
        deleteMany: async (args: any) => { movementDeleteArgs.push(args); return { count: 1 }; },
        createMany: async (args: any) => { movementCreateArgs.push(args); return { count: args.data.length }; },
      },
    };
    client.$transaction = async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx);

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/exchanges/another-users-exchange`, {
        method: 'PATCH',
        headers: { authorization: bearer('user-42'), 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'RUB_USDT_VND', rubSpent: 8300, usdtReceived: 93.7853,
          vndFee: 0, targetCurrency: 'VND',
        }),
      });

      assert.equal(response.status, 404);
      assert.deepEqual(updateArgs.where, { id: 'another-users-exchange', userId: 'user-42' });
      assert.deepEqual(movementDeleteArgs, [], 'ledger deletion must not run when the owner-scoped update matches no row');
      assert.deepEqual(movementCreateArgs, [], 'ledger creation must not run when the owner-scoped update matches no row');
    });
  });

  it('returns an error when ledger synchronization fails during exchange update', async () => {
    let transactionCompleted = false;
    const tx = {
      exchange: {
        updateMany: async (args: any) => {
          assert.deepEqual(args.where, { id: 'exchange-rollback', userId: 'user-42' });
          return { count: 1 };
        },
        findFirst: async () => ({
          id: 'exchange-rollback', userId: 'user-42', mode: 'RUB_USDT_VND',
          rubSpent: 8300, usdtReceived: 93.7853, vndReceived: null,
          targetCurrency: 'VND', targetReceived: null,
        }),
      },
      walletMovement: {
        deleteMany: async () => ({ count: 1 }),
        createMany: async () => { throw new Error('simulated ledger write failure'); },
      },
    };
    client.$transaction = async (callback: (transaction: typeof tx) => Promise<unknown>) => {
      try {
        return await callback(tx);
      } finally {
        transactionCompleted = true;
      }
    };

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/exchanges/exchange-rollback`, {
        method: 'PATCH',
        headers: { authorization: bearer('user-42'), 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'RUB_USDT_VND', rubSpent: 8300, usdtReceived: 93.7853,
          vndFee: 0, targetCurrency: 'VND',
        }),
      });

      assert.equal(response.status, 500);
      assert.equal(transactionCompleted, true);
    });
  });

  it('deletes an exchange and its ledger rows in one transaction scoped to its owner', async () => {
    let deleteArgs: any;
    const deletedMovements: any[] = [];
    const tx = {
      exchange: {
        deleteMany: async (args: any) => { deleteArgs = args; return { count: 1 }; },
      },
      walletMovement: {
        deleteMany: async (args: any) => { deletedMovements.push(args); return { count: 2 }; },
      },
    };
    client.$transaction = async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx);

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/exchanges/exchange-1`, {
        method: 'DELETE',
        headers: { authorization: bearer('user-42') },
      });
      assert.equal(response.status, 204);
      assert.deepEqual(deleteArgs.where, { id: 'exchange-1', userId: 'user-42' });
      assert.deepEqual(deletedMovements, [{
        where: { userId: 'user-42', sourceKey: { startsWith: 'exchange:exchange-1:' } },
      }]);
    });
  });

  it('returns 404 and leaves ledger rows untouched when the exchange is absent or owned by someone else', async () => {
    const movementDeleteArgs: any[] = [];
    const tx = {
      exchange: {
        deleteMany: async (args: any) => {
          assert.deepEqual(args.where, { id: 'another-users-exchange', userId: 'user-42' });
          return { count: 0 };
        },
      },
      walletMovement: {
        deleteMany: async (args: any) => { movementDeleteArgs.push(args); return { count: 1 }; },
      },
    };
    client.$transaction = async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx);

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/exchanges/another-users-exchange`, {
        method: 'DELETE',
        headers: { authorization: bearer('user-42') },
      });

      assert.equal(response.status, 404);
      assert.deepEqual(movementDeleteArgs, [], 'ledger deletion must not run if the owner-scoped exchange delete matched no row');
    });
  });
});
