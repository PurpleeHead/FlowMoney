import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'node:net';
import { prisma } from '../services/prisma.js';
import expenseRoutes from './expenses.js';

const client = prisma as unknown as { $transaction: (...args: any[]) => Promise<any> };
const expenseModel = prisma.expense as unknown as {
  findFirst: (...args: any[]) => Promise<any>;
  findMany: (...args: any[]) => Promise<any>;
};
const exchangeModel = prisma.exchange as unknown as { findMany: (...args: any[]) => Promise<any> };
const originalTransaction = client.$transaction;
const originalExpenseFindFirst = expenseModel.findFirst;
const originalExpenseFindMany = expenseModel.findMany;
const originalExchangeFindMany = exchangeModel.findMany;
const previousSecret = process.env.JWT_SECRET;

afterEach(() => {
  client.$transaction = originalTransaction;
  expenseModel.findFirst = originalExpenseFindFirst;
  expenseModel.findMany = originalExpenseFindMany;
  exchangeModel.findMany = originalExchangeFindMany;
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
  it('creates an expense and records its source-currency debit atomically', async () => {
    expenseModel.findMany = async () => [];
    exchangeModel.findMany = async () => [];
    const createdMovements: any[] = [];
    const deletedMovements: any[] = [];
    const createdExpense = {
      id: 'expense-new', userId: 'user-42', title: 'Lunch', category: 'Food',
      amount: 100, currency: 'RUB', amountVnd: null, amountRub: 100,
      usdtCharged: null, date: new Date('2026-10-18T08:00:00.000Z'), receiptId: null,
    };
    const tx = {
      expense: {
        create: async (args: any) => {
          assert.equal(args.data.userId, 'user-42');
          assert.equal(args.data.title, 'Lunch');
          return createdExpense;
        },
      },
      walletMovement: {
        deleteMany: async (args: any) => { deletedMovements.push(args); return { count: 0 }; },
        createMany: async (args: any) => { createdMovements.push(args); return { count: args.data.length }; },
      },
    };
    client.$transaction = async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx);

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/expenses`, {
        method: 'POST',
        headers: { authorization: bearer('user-42'), 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Lunch', category: 'Food', amount: 100, currency: 'RUB' }),
      });

      assert.equal(response.status, 201);
      assert.deepEqual(deletedMovements, [{
        where: { userId: 'user-42', sourceKey: { startsWith: 'expense:expense-new:' } },
      }]);
      const movements = createdMovements[0].data as Array<{ currency: string; amountDelta: number }>;
      assert.deepEqual(movements.map(item => [item.currency, item.amountDelta]), [['RUB', -100]]);
    });
  });

  it('updates an expense and replaces its wallet debit in the same owner-scoped transaction', async () => {
    const existing = {
      id: 'expense-1', userId: 'user-42', title: 'Old title', category: 'Food',
      amount: 100000, currency: 'VND', amountVnd: 100000, amountRub: null,
      usdtCharged: 4, date: new Date('2026-10-18T08:00:00.000Z'), receiptId: null,
    };
    let updateArgs: any;
    const deletedMovements: any[] = [];
    const createdMovements: any[] = [];
    expenseModel.findFirst = async args => {
      assert.deepEqual(args.where, { id: 'expense-1', userId: 'user-42' });
      return existing;
    };
    expenseModel.findMany = async () => [];
    exchangeModel.findMany = async () => [];
    const tx = {
      expense: {
        updateMany: async (args: any) => {
          updateArgs = args;
          return { count: 1 };
        },
        findFirst: async () => ({ ...existing, title: 'Updated groceries', usdtCharged: 2.5 }),
      },
      walletMovement: {
        deleteMany: async (args: any) => {
          deletedMovements.push(args);
          return { count: 1 };
        },
        createMany: async (args: any) => {
          createdMovements.push(args);
          return { count: args.data.length };
        },
      },
    };
    client.$transaction = async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx);

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/expenses/expense-1`, {
        method: 'PATCH',
        headers: { authorization: bearer('user-42'), 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Updated groceries', category: 'Food', amount: 100000,
          currency: 'VND', usdtCharged: 2.5,
        }),
      });

      assert.equal(response.status, 200);
      assert.deepEqual(updateArgs.where, { id: 'expense-1', userId: 'user-42' });
      assert.equal(updateArgs.data.usdtCharged, 2.5);
      assert.deepEqual(deletedMovements, [{
        where: { userId: 'user-42', sourceKey: { startsWith: 'expense:expense-1:' } },
      }]);
      const movements = createdMovements[0].data as Array<{ currency: string; amountDelta: number }>;
      assert.deepEqual(movements.map(item => [item.currency, item.amountDelta]), [['USDT', -2.5]]);
    });
  });

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
