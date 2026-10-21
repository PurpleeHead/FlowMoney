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
      assert.deepEqual(findManyArgs.orderBy, [{ createdAt: 'desc' }, { id: 'asc' }]);
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

describe('receipt cursor pagination', () => {
  it('returns a page and next cursor scoped to the authenticated user', async () => {
    let queryArgs: any;
    receiptModel.findMany = async (args: any) => {
      queryArgs = args;
      return [
        { id: 'receipt-a', createdAt: new Date('2026-10-19T10:00:00.000Z'), rawText: 'A', items: [] },
        { id: 'receipt-b', createdAt: new Date('2026-10-18T10:00:00.000Z'), rawText: 'B', items: [] },
      ];
    };
    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/receipts?limit=1`, {
        headers: { authorization: bearer('user-1') },
      });
      assert.equal(response.status, 200);
      const body = await response.json() as { items: Array<{ id: string; userId?: string }>; hasMore: boolean; nextCursor: string | null };
      assert.deepEqual(body.items.map(item => item.id), ['receipt-a']);
      assert.equal('userId' in body.items[0], false);
      assert.equal(body.hasMore, true);
      assert.equal(typeof body.nextCursor, 'string');
    });
    assert.equal(queryArgs.take, 2);
    assert.deepEqual(queryArgs.where.userId, 'user-1');
    assert.deepEqual(queryArgs.orderBy, [{ createdAt: 'desc' }, { id: 'asc' }]);
  });
});


describe('receipt cursor continuation', () => {
  it('uses the supplied cursor to continue after the previous receipt without changing user scope', async () => {
    let queryArgs: any;
    receiptModel.findMany = async (args: any) => {
      queryArgs = args;
      return [{ id: 'receipt-next', createdAt: new Date('2026-10-18T10:00:00.000Z'), rawText: 'Next page', items: [] }];
    };
    const cursor = Buffer.from(JSON.stringify({
      timestamp: '2026-10-19T10:00:00.000Z',
      id: 'receipt-first',
    }), 'utf8').toString('base64url');

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/receipts?limit=1&cursor=${encodeURIComponent(cursor)}`, {
        headers: { authorization: bearer('user-1') },
      });
      assert.equal(response.status, 200);
      const body = await response.json() as { items: Array<{ id: string }>; hasMore: boolean; nextCursor: string | null };
      assert.deepEqual(body.items.map(item => item.id), ['receipt-next']);
      assert.equal(body.hasMore, false);
      assert.equal(body.nextCursor, null);
    });

    assert.equal(queryArgs.take, 2);
    assert.equal(queryArgs.where.userId, 'user-1');
    assert.deepEqual(queryArgs.where.OR, [
      { createdAt: { lt: new Date('2026-10-19T10:00:00.000Z') } },
      { createdAt: new Date('2026-10-19T10:00:00.000Z'), id: { gt: 'receipt-first' } },
    ]);
  });
});


describe('receipt pagination validation boundaries', () => {
  it('rejects malformed and repeated cursor parameters before querying receipts', async () => {
    let queryCalled = false;
    receiptModel.findMany = async () => { queryCalled = true; return []; };
    await withApi(async baseUrl => {
      for (const query of ['cursor=not-a-cursor', 'limit=1.25', 'limit=10&limit=20']) {
        const response = await fetch(`${baseUrl}/api/receipts?${query}`, {
          headers: { authorization: bearer('user-1') },
        });
        assert.equal(response.status, 400, query);
      }
    });
    assert.equal(queryCalled, false);
  });
});


describe('receipt historical valuation cutoffs', () => {
  it('scopes exchange and card-purchase observations to the receipt save timestamp', async () => {
    let exchangeArgs: any;
    let purchaseArgs: any;
    let savedExpense: any;
    exchangeModel.findMany = async (args: any) => {
      exchangeArgs = args;
      return [{
        mode: 'RUB_USDT_VND',
        rubSpent: 8300,
        usdtReceived: 100,
        vndReceived: null,
        planningVndPerUsdt: 25000,
        targetCurrency: 'VND',
        targetReceived: null,
        targetVndEquivalent: null,
      }];
    };
    expenseModel.findMany = async (args: any) => {
      purchaseArgs = args;
      return [];
    };
    const tx = {
      receipt: { create: async () => ({ id: 'receipt-historical-cutoff' }) },
      expense: {
        create: async (args: any) => {
          savedExpense = args.data;
          return { id: 'expense-historical-cutoff', ...args.data, usdtCharged: null };
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
          rawText: 'Historical Vietnamese receipt',
          items: [{ name: 'Coffee', price: 50000, currency: 'VND', amountVnd: 50000 }],
        }),
      });
      assert.equal(response.status, 201);
    });

    assert.deepEqual(exchangeArgs.where.userId, 'user-1');
    assert.ok(exchangeArgs.where.createdAt.lte instanceof Date);
    assert.deepEqual(purchaseArgs.where, {
      userId: 'user-1',
      date: { lte: exchangeArgs.where.createdAt.lte },
      usdtCharged: { not: null },
    });
    assert.equal(savedExpense.date.getTime(), exchangeArgs.where.createdAt.lte.getTime());
    assert.equal(savedExpense.amountRub, null, 'a planning-only rate must not become a historical factual valuation');
  });
});


describe('receipt legacy direct VND exchange rates', () => {
  it('uses normalized target currency and legacy target amount when valuing a receipt', async () => {
    exchangeModel.findMany = async () => [{
      mode: 'RUB_TARGET',
      rubSpent: 500,
      usdtReceived: null,
      vndReceived: null,
      planningVndPerUsdt: null,
      targetCurrency: ' vnd ',
      targetReceived: 125000,
      targetVndEquivalent: null,
    }];
    expenseModel.findMany = async () => [];
    let savedExpense: any;
    const tx = {
      receipt: { create: async () => ({ id: 'receipt-legacy-direct-vnd' }) },
      expense: {
        create: async (args: any) => {
          savedExpense = args.data;
          return { id: 'expense-legacy-direct-vnd', ...args.data, usdtCharged: null };
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
          rawText: 'Legacy direct VND exchange',
          items: [{ name: 'Coffee', price: 50000, currency: 'VND', amountVnd: 50000 }],
        }),
      });
      assert.equal(response.status, 201);
    });

    assert.equal(savedExpense.amountRub, 200, '50,000 VND at 250 VND/RUB must persist as 200 RUB');
  });
});
