import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'node:net';
import { prisma } from '../services/prisma.js';
import expenseRoutes from './expenses.js';

const client = prisma as unknown as { $transaction: (...args: any[]) => Promise<any> };
const originalTransaction = client.$transaction;
const previousSecret = process.env.JWT_SECRET;

afterEach(() => {
  client.$transaction = originalTransaction;
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
});

async function withApi(run: (baseUrl: string) => Promise<void>) {
  process.env.JWT_SECRET = 'expense-api-test-secret';
  const app = express();
  app.use(express.json());
  app.use('/api/expenses', expenseRoutes);
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
  return `Bearer ${jwt.sign({ id: userId, email: `${userId}@example.com` }, 'expense-api-test-secret')}`;
}

describe('expense API ledger synchronization', () => {
  it('deletes an expense and its ledger rows in one owner-scoped transaction', async () => {
    let expenseDeleteArgs: any;
    const movementDeleteArgs: any[] = [];
    const tx = {
      expense: {
        deleteMany: async (args: any) => {
          expenseDeleteArgs = args;
          return { count: 1 };
        },
      },
      walletMovement: {
        deleteMany: async (args: any) => {
          movementDeleteArgs.push(args);
          return { count: 1 };
        },
      },
    };
    client.$transaction = async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx);

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/expenses/expense-1`, {
        method: 'DELETE',
        headers: { authorization: bearer('user-42') },
      });

      assert.equal(response.status, 204);
      assert.deepEqual(expenseDeleteArgs.where, { id: 'expense-1', userId: 'user-42' });
      assert.deepEqual(movementDeleteArgs, [{
        where: {
          userId: 'user-42',
          sourceKey: { startsWith: 'expense:expense-1:' },
        },
      }]);
    });
  });

  it('returns 404 and leaves ledger rows untouched when the owner-scoped expense is absent', async () => {
    const movementDeleteArgs: any[] = [];
    const tx = {
      expense: {
        deleteMany: async () => ({ count: 0 }),
      },
      walletMovement: {
        deleteMany: async (args: any) => {
          movementDeleteArgs.push(args);
          return { count: 1 };
        },
      },
    };
    client.$transaction = async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx);

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/expenses/other-users-expense`, {
        method: 'DELETE',
        headers: { authorization: bearer('user-42') },
      });

      assert.equal(response.status, 404);
      assert.deepEqual(movementDeleteArgs, []);
    });
  });
});
