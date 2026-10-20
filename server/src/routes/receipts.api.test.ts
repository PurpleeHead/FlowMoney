import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'node:net';
import { prisma } from '../services/prisma.js';

const userModel = prisma.user as unknown as { findFirst: (...args: any[]) => Promise<any> };
const originalUserFindFirst = userModel.findFirst;
import receiptRoutes from './receipts.js';

const receiptModel = prisma.receipt as unknown as {
  findMany: (...args: any[]) => Promise<any>;
};
const exchangeModel = prisma.exchange as unknown as { findMany: (...args: any[]) => Promise<any> };
const expenseModel = prisma.expense as unknown as { findMany: (...args: any[]) => Promise<any> };
const client = prisma as unknown as { $transaction: (...args: any[]) => Promise<any> };
const originalFindMany = receiptModel.findMany;
const originalExchangeFindMany = exchangeModel.findMany;
const originalExpenseFindMany = expenseModel.findMany;
const originalTransaction = client.$transaction;
const previousSecret = process.env.JWT_SECRET;

afterEach(() => {
  userModel.findFirst = originalUserFindFirst;
  receiptModel.findMany = originalFindMany;
  exchangeModel.findMany = originalExchangeFindMany;
  expenseModel.findMany = originalExpenseFindMany;
  client.$transaction = originalTransaction;
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
});

async function withApi(run: (baseUrl: string) => Promise<void>) {
  userModel.findFirst = async () => ({ tokenVersion: 0 });
  process.env.JWT_SECRET = 'receipt-api-test-secret-long-enough-for-jwt-middleware';
  const app = express();
  app.use(express.json());
  app.use('/api/receipts', receiptRoutes);
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
  return `Bearer ${jwt.sign({ id: userId, email: `${userId}@example.com` }, 'receipt-api-test-secret-long-enough-for-jwt-middleware')}`;
}

describe('receipt API ownership', () => {
  it('lists only receipts belonging to the authenticated user', async () => {
    let findManyArgs: any;
    receiptModel.findMany = async (args: any) => {
      findManyArgs = args;
      return [{ id: 'receipt-user-1', rawText: 'receipt', items: [], createdAt: new Date('2026-10-19T08:00:00.000Z') }];
    };

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/receipts`, {
        headers: { authorization: bearer('user-1') },
      });

      assert.equal(response.status, 200);
      assert.deepEqual(findManyArgs.where, { userId: 'user-1' });
      assert.deepEqual(findManyArgs.orderBy, { createdAt: 'desc' });
      assert.equal(findManyArgs.take, 100);
      assert.deepEqual(Object.keys(findManyArgs.select).sort(), ['createdAt', 'id', 'items', 'rawText'].sort());
      const receipts = await response.json() as Array<{ id: string; userId?: string }>;
      assert.deepEqual(receipts.map(receipt => receipt.id), ['receipt-user-1']);
      assert.equal('userId' in receipts[0], false);
    });
  });

  it('rejects receipt items with inconsistent VND price and amountVnd before database writes', async () => {
    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/receipts`, {
        method: 'POST',
        headers: { authorization: bearer('user-1'), 'content-type': 'application/json' },
        body: JSON.stringify({
          rawText: 'Vietnamese receipt',
          items: [{ name: 'Coffee', price: 50000, currency: 'VND', amountVnd: 1 }],
        }),
      });

      assert.equal(response.status, 400);
    });
  });

  it('rejects receipt items labelled in a non-VND currency', async () => {
    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/receipts`, {
        method: 'POST',
        headers: { authorization: bearer('user-1'), 'content-type': 'application/json' },
        body: JSON.stringify({
          rawText: 'Vietnamese receipt',
          items: [{ name: 'Coffee', price: 50000, currency: 'USD', amountVnd: 50000 }],
        }),
      });

      assert.equal(response.status, 400);
    });
  });

  it('rejects receipt listing without authentication', async () => {
    let queryCalled = false;
    receiptModel.findMany = async () => {
      queryCalled = true;
      return [];
    };

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/receipts`);
      assert.equal(response.status, 401);
      assert.equal(queryCalled, false);
    });
  });
  it('does not value receipt expenses using a planning-only VND/USDT rate', async () => {
    exchangeModel.findMany = async () => [{
      mode: 'RUB_USDT_VND',
      rubSpent: 8300,
      usdtReceived: 100,
      vndReceived: null,
      planningVndPerUsdt: 25000,
      targetCurrency: 'VND',
      targetReceived: null,
      targetVndEquivalent: null,
    }];
    expenseModel.findMany = async () => [];
    let savedExpense: any;
    const tx = {
      receipt: {
        create: async () => ({ id: 'receipt-planning-only' }),
      },
      expense: {
        create: async (args: any) => {
          savedExpense = args.data;
          return {
            id: 'expense-receipt-planning-only',
            ...args.data,
            usdtCharged: null,
          };
        },
      },
      walletMovement: {
        deleteMany: async () => ({ count: 0 }),
        createMany: async (args: any) => ({ count: args.data.length }),
      },
    };
    client.$transaction = async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx);

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/receipts`, {
        method: 'POST',
        headers: { authorization: bearer('user-1'), 'content-type': 'application/json' },
        body: JSON.stringify({
          rawText: 'Vietnamese receipt',
          items: [{ name: 'Coffee', price: 50000, currency: 'VND', amountVnd: 50000 }],
        }),
      });

      assert.equal(response.status, 201);
      assert.equal(savedExpense.amountVnd, 50000);
      assert.equal(savedExpense.amountRub, null, 'planning rate must not be persisted as an actual RUB valuation');
    });
  });

});
