import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'node:net';
import { prisma } from '../services/prisma.js';

const userModel = prisma.user as unknown as { findFirst: (...args: any[]) => Promise<any> };
const originalUserFindFirst = userModel.findFirst;
import expenseRoutes from './expenses.js';

const client = prisma as unknown as { $transaction: (...args: any[]) => Promise<any> };
const expenseModel = prisma.expense as unknown as {
  findFirst: (...args: any[]) => Promise<any>;
  findMany: (...args: any[]) => Promise<any>;
};
const exchangeModel = prisma.exchange as unknown as { findMany: (...args: any[]) => Promise<any> };
const receiptModel = prisma.receipt as unknown as { findFirst: (...args: any[]) => Promise<any> };
const originalTransaction = client.$transaction;
const originalExpenseFindFirst = expenseModel.findFirst;
const originalExpenseFindMany = expenseModel.findMany;
const originalExchangeFindMany = exchangeModel.findMany;
const originalReceiptFindFirst = receiptModel.findFirst;
const previousSecret = process.env.JWT_SECRET;

afterEach(() => {
  userModel.findFirst = originalUserFindFirst;
  client.$transaction = originalTransaction;
  expenseModel.findFirst = originalExpenseFindFirst;
  expenseModel.findMany = originalExpenseFindMany;
  exchangeModel.findMany = originalExchangeFindMany;
  receiptModel.findFirst = originalReceiptFindFirst;
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
});

async function withApi(run: (baseUrl: string) => Promise<void>) {
  userModel.findFirst = async () => ({ tokenVersion: 0 });
  process.env.JWT_SECRET = 'expense-api-test-secret-long-enough-for-jwt-middleware';
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
  return `Bearer ${jwt.sign({ id: userId, email: `${userId}@example.com` }, 'expense-api-test-secret-long-enough-for-jwt-middleware')}`;
}

describe('expense API ledger synchronization', () => {
  it('does not return success when wallet ledger synchronization fails during creation', async () => {
    expenseModel.findMany = async () => [];
    exchangeModel.findMany = async () => [];
    const tx = {
      expense: {
        create: async () => ({
          id: 'expense-failing', userId: 'user-42', title: 'Lunch', category: 'Food',
          amount: 100, currency: 'RUB', amountVnd: null, amountRub: 100,
          usdtCharged: null, date: new Date('2026-10-18T08:00:00.000Z'), receiptId: null,
        }),
      },
      walletMovement: {
        deleteMany: async () => ({ count: 0 }),
        createMany: async () => { throw new Error('simulated ledger write failure'); },
      },
    };
    client.$transaction = async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx);

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/expenses`, {
        method: 'POST',
        headers: { authorization: bearer('user-42'), 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Lunch', category: 'Food', amount: 100, currency: 'RUB' }),
      });

      assert.equal(response.status, 500);
    });
  });

  it('rejects a VND expense whose source amount conflicts with amountVnd', async () => {
    expenseModel.findMany = async () => { throw new Error('database should not be queried for invalid input'); };
    exchangeModel.findMany = async () => { throw new Error('database should not be queried for invalid input'); };

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/expenses`, {
        method: 'POST',
        headers: { authorization: bearer('user-42'), 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Groceries', category: 'Food', amount: 100000, currency: 'VND', amountVnd: 1,
        }),
      });

      assert.equal(response.status, 400);
    });
  });

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

  it('preserves the existing USDT card debit when PATCH omits usdtCharged', async () => {
    const existing = {
      id: 'expense-keep-card-debit', userId: 'user-42', title: 'Old title', category: 'Food',
      amount: 100000, currency: 'VND', amountVnd: 100000, amountRub: null,
      usdtCharged: 4, date: new Date('2026-10-18T08:00:00.000Z'), receiptId: null,
    };
    let updateArgs: any;
    const createdMovements: any[] = [];
    expenseModel.findFirst = async () => existing;
    expenseModel.findMany = async () => [];
    exchangeModel.findMany = async () => [{
      mode: 'RUB_USDT_VND', rubSpent: 8300, usdtReceived: 100, vndReceived: null,
      planningVndPerUsdt: 20000, targetCurrency: 'VND', targetReceived: null, targetVndEquivalent: null,
    }];
    const tx = {
      expense: {
        updateMany: async (args: any) => { updateArgs = args; return { count: 1 }; },
        findFirst: async () => ({ ...existing, title: 'Updated title' }),
      },
      walletMovement: {
        deleteMany: async () => ({ count: 1 }),
        createMany: async (args: any) => { createdMovements.push(args); return { count: args.data.length }; },
      },
    };
    client.$transaction = async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx);

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/expenses/expense-keep-card-debit`, {
        method: 'PATCH',
        headers: { authorization: bearer('user-42'), 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Updated title', category: 'Food', amount: 100000, currency: 'VND',
        }),
      });

      assert.equal(response.status, 200);
      assert.equal(updateArgs.data.usdtCharged, 4, 'omitting usdtCharged must preserve the existing actual card debit');
      assert.equal(updateArgs.data.amountRub, 332, 'RUB cost must use the preserved actual debit (4 USDT × 83 RUB/USDT), not the planning estimate');
      const movements = createdMovements[0].data as Array<{ currency: string; amountDelta: number }>;
      assert.deepEqual(movements.map(item => [item.currency, item.amountDelta]), [['USDT', -4]]);
    });
  });

  it('keeps the actual USDT debit when the VND amount is edited', async () => {
    const existing = {
      id: 'expense-edit-vnd-amount', userId: 'user-42', title: 'Old groceries', category: 'Food',
      amount: 100000, currency: 'VND', amountVnd: 100000, amountRub: 332,
      usdtCharged: 4, date: new Date('2026-10-18T08:00:00.000Z'), receiptId: null,
    };
    let updateData: any;
    const createdMovements: any[] = [];
    expenseModel.findFirst = async () => existing;
    expenseModel.findMany = async () => [];
    exchangeModel.findMany = async () => [{
      mode: 'RUB_USDT_VND', rubSpent: 8300, usdtReceived: 100, vndReceived: null,
      planningVndPerUsdt: 20000, targetCurrency: 'VND', targetReceived: null, targetVndEquivalent: null,
    }];
    const tx = {
      expense: {
        updateMany: async ({ data }: any) => { updateData = data; return { count: 1 }; },
        findFirst: async () => ({ ...existing, ...updateData }),
      },
      walletMovement: {
        deleteMany: async () => ({ count: 1 }),
        createMany: async ({ data }: any) => { createdMovements.push(...data); return { count: data.length }; },
      },
    };
    client.$transaction = async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx);

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/expenses/expense-edit-vnd-amount`, {
        method: 'PATCH',
        headers: { authorization: bearer('user-42'), 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Updated groceries', category: 'Food', amount: 120000, amountVnd: 120000, currency: 'VND',
        }),
      });

      assert.equal(response.status, 200);
      assert.equal(updateData.amount, 120000);
      assert.equal(updateData.amountVnd, 120000);
      assert.equal(updateData.usdtCharged, 4, 'editing VND amount must not erase the recorded actual USDT debit');
      assert.equal(updateData.amountRub, 332, 'RUB cost must remain based on 4 actual USDT × 83 RUB/USDT, not the planning estimate');
      assert.deepEqual(createdMovements.map((item: any) => [item.currency, item.amountDelta]), [['USDT', -4]]);
    });
  });

  it('includes direct RUB_TARGET → VND exchanges when recalculating a patched expense', async () => {
    const existing = {
      id: 'expense-target-vnd-rate', userId: 'user-42', title: 'Old title', category: 'Food',
      amount: 100000, currency: 'VND', amountVnd: 100000, amountRub: null,
      usdtCharged: null, date: new Date('2026-10-18T08:00:00.000Z'), receiptId: null,
    };
    expenseModel.findFirst = async () => existing;
    expenseModel.findMany = async () => [];
    exchangeModel.findMany = async () => [{
      mode: 'RUB_TARGET', rubSpent: 2000, usdtReceived: null, vndReceived: null,
      planningVndPerUsdt: null, targetCurrency: ' vNd ', targetReceived: 460000,
      targetVndEquivalent: null, // legacy row only has targetReceived and non-canonical currency casing
    }];
    let updateData: any;
    const tx = {
      expense: {
        updateMany: async ({ data }: any) => { updateData = data; return { count: 1 }; },
        findFirst: async () => ({ ...existing, ...updateData }),
      },
      walletMovement: {
        deleteMany: async () => ({ count: 0 }),
        createMany: async ({ data }: any) => ({ count: data.length }),
      },
    };
    client.$transaction = async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx);

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/expenses/expense-target-vnd-rate`, {
        method: 'PATCH',
        headers: { authorization: bearer('user-42'), 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Updated groceries', category: 'Food', amount: 100000, currency: 'VND',
        }),
      });

      assert.equal(response.status, 200);
      const body = await response.json() as any;
      assert.ok(Math.abs(body.amountRub - (100000 / (460000 / 2000))) < 0.0001,
        'PATCH must include actual direct RUB_TARGET → VND outcomes in its historical VND/RUB rate');
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

  it('returns 404 and leaves ledger rows untouched when updating another user expense', async () => {
    let transactionCalls = 0;
    expenseModel.findFirst = async args => {
      assert.deepEqual(args.where, { id: 'another-users-expense', userId: 'user-42' });
      return null;
    };
    const originalTx = client.$transaction;
    client.$transaction = async (...args: any[]) => {
      transactionCalls += 1;
      return originalTx(...args);
    };

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/expenses/another-users-expense`, {
        method: 'PATCH',
        headers: { authorization: bearer('user-42'), 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Tampered expense', category: 'Food', amount: 100,
          currency: 'RUB',
        }),
      });

      assert.equal(response.status, 404);
      assert.equal(transactionCalls, 0, 'must not start a write transaction for another user expense');
    });
  });


  it('rejects attaching another user receipt to an expense', async () => {
    const existing = {
      id: 'expense-owned', userId: 'user-42', title: 'Groceries', category: 'Food',
      amount: 100000, currency: 'VND', amountVnd: 100000, amountRub: null,
      usdtCharged: null, date: new Date('2026-10-18T08:00:00.000Z'), receiptId: null,
    };
    let transactionCalls = 0;
    expenseModel.findFirst = async args => {
      assert.deepEqual(args.where, { id: 'expense-owned', userId: 'user-42' });
      return existing;
    };
    receiptModel.findFirst = async args => {
      assert.deepEqual(args.where, { id: 'foreign-receipt', userId: 'user-42' });
      return null;
    };
    const originalTx = client.$transaction;
    client.$transaction = async (...args: any[]) => {
      transactionCalls += 1;
      return originalTx(...args);
    };

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/expenses/expense-owned`, {
        method: 'PATCH',
        headers: { authorization: bearer('user-42'), 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Groceries', category: 'Food', amount: 100000,
          currency: 'VND', receiptId: 'foreign-receipt',
        }),
      });

      assert.equal(response.status, 400);
      assert.equal(transactionCalls, 0, 'must not write expense or ledger when receipt ownership check fails');
    });
  });


  it('limits valuation observations to the expense effective date', async () => {
    const effectiveDate = new Date('2026-10-12T09:30:00.000Z');
    let exchangeQuery: any;
    let purchaseQuery: any;
    let createdData: any;
    exchangeModel.findMany = async (args: any) => { exchangeQuery = args; return []; };
    expenseModel.findMany = async (args: any) => { purchaseQuery = args; return []; };
    const tx = {
      expense: {
        create: async (args: any) => {
          createdData = args.data;
          return { id: 'expense-historical-date', ...args.data };
        },
      },
      walletMovement: {
        deleteMany: async () => ({ count: 0 }),
        createMany: async (args: any) => ({ count: args.data.length }),
      },
    };
    client.$transaction = async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx);

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/expenses`, {
        method: 'POST',
        headers: { authorization: bearer('user-42'), 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Historical groceries', category: 'Food', amount: 120000,
          amountVnd: 120000, currency: 'VND', date: effectiveDate.toISOString(),
        }),
      });

      assert.equal(response.status, 201);
      assert.equal(createdData.date.toISOString(), effectiveDate.toISOString());
    });

    assert.deepEqual(exchangeQuery.where, {
      userId: 'user-42',
      createdAt: { lte: effectiveDate },
    });
    assert.deepEqual(purchaseQuery.where, {
      userId: 'user-42',
      date: { lte: effectiveDate },
      usdtCharged: { not: null },
    });
  });

  it('keeps a planning VND/USDT rate out of saved factual expense valuations', async () => {
    expenseModel.findMany = async () => [];
    exchangeModel.findMany = async () => [{
      mode: 'RUB_USDT_VND',
      rubSpent: 1000,
      usdtReceived: 100,
      vndReceived: null,
      planningVndPerUsdt: 25000,
      targetCurrency: 'VND',
      targetReceived: null,
      targetVndEquivalent: null,
    }];
    let createdData: any;
    const tx = {
      expense: {
        create: async (args: any) => {
          createdData = args.data;
          return { id: 'expense-planning-rate', ...args.data, date: new Date('2026-10-18T08:00:00.000Z') };
        },
      },
      walletMovement: {
        deleteMany: async () => ({ count: 0 }),
        createMany: async (args: any) => ({ count: args.data.length }),
      },
    };
    client.$transaction = async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx);

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/expenses`, {
        method: 'POST',
        headers: { authorization: bearer('user-42'), 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'USDT purchase', category: 'Other', amount: 10, currency: 'USDT' }),
      });

      assert.equal(response.status, 201);
      assert.equal(createdData.amountVnd, null, 'a planning rate must not be persisted as actual VND');
      assert.equal(createdData.amountRub, 100, 'known RUB/USDT exchange rate can still value the source amount in RUB');
    });
  });

  it('keeps planning VND/USDT rate out of PATCH factual valuation', async () => {
    const existing = {
      id: 'expense-patch-planning-rate', userId: 'user-42', title: 'Old purchase', category: 'Other',
      amount: 5, currency: 'USDT', amountVnd: null, amountRub: 50,
      usdtCharged: null, date: new Date('2026-10-18T08:00:00.000Z'), receiptId: null,
    };
    let updateData: any;
    expenseModel.findFirst = async () => existing;
    expenseModel.findMany = async () => [];
    exchangeModel.findMany = async () => [{
      mode: 'RUB_USDT_VND', rubSpent: 8300, usdtReceived: 100, vndReceived: null,
      planningVndPerUsdt: 25000, targetCurrency: 'VND', targetReceived: null, targetVndEquivalent: null,
    }];
    const tx = {
      expense: {
        updateMany: async (args: any) => { updateData = args.data; return { count: 1 }; },
        findFirst: async () => ({ ...existing, ...updateData }),
      },
      walletMovement: {
        deleteMany: async () => ({ count: 0 }),
        createMany: async (args: any) => ({ count: args.data.length }),
      },
    };
    client.$transaction = async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx);

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/expenses/expense-patch-planning-rate`, {
        method: 'PATCH',
        headers: { authorization: bearer('user-42'), 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Updated purchase', category: 'Other', amount: 10, currency: 'USDT' }),
      });

      assert.equal(response.status, 200);
      assert.equal(updateData.amountVnd, null, 'PATCH must not persist the planning rate as factual VND');
      assert.equal(updateData.amountRub, 830, 'known RUB/USDT rate still values the source amount');
    });
  });

  it('does not infer a RUB expense VND amount from an unrelated target rate when RUB/VND is unknown', async () => {
    expenseModel.findMany = async () => [];
    exchangeModel.findMany = async () => [];
    let createdData: any;
    const tx = {
      expense: {
        create: async (args: any) => {
          createdData = args.data;
          return { id: 'expense-unknown-rub-vnd', ...args.data, date: new Date('2026-10-18T08:00:00.000Z') };
        },
      },
      walletMovement: {
        deleteMany: async () => ({ count: 0 }),
        createMany: async (args: any) => ({ count: args.data.length }),
      },
    };
    client.$transaction = async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx);

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/expenses`, {
        method: 'POST',
        headers: { authorization: bearer('user-42'), 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Cash expense', category: 'Other', amount: 100, currency: 'RUB',
          targetToVndRate: 25000,
        }),
      });

      assert.equal(response.status, 201);
      assert.equal(createdData.amountVnd, null);
      assert.equal(createdData.amountRub, 100);
    });
  });

  it('does not infer a patched USDT expense VND amount from an unrelated target rate when USDT/VND is unknown', async () => {
    const existing = {
      id: 'expense-unknown-usdt-vnd', userId: 'user-42', title: 'Old title', category: 'Other',
      amount: 10, currency: 'USDT', amountVnd: null, amountRub: null,
      usdtCharged: null, date: new Date('2026-10-18T08:00:00.000Z'), receiptId: null,
    };
    let updateData: any;
    expenseModel.findFirst = async () => existing;
    expenseModel.findMany = async () => [];
    exchangeModel.findMany = async () => [];
    const tx = {
      expense: {
        updateMany: async (args: any) => { updateData = args.data; return { count: 1 }; },
        findFirst: async () => ({ ...existing, ...updateData }),
      },
      walletMovement: {
        deleteMany: async () => ({ count: 0 }),
        createMany: async (args: any) => ({ count: args.data.length }),
      },
    };
    client.$transaction = async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx);

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/expenses/expense-unknown-usdt-vnd`, {
        method: 'PATCH',
        headers: { authorization: bearer('user-42'), 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Updated expense', category: 'Other', amount: 10, currency: 'USDT',
          targetToVndRate: 25000,
        }),
      });

      assert.equal(response.status, 200);
      assert.equal(updateData.amountVnd, null);
      assert.equal(updateData.amountRub, null);
    });
  });

});


describe('expense list response privacy', () => {
  it('scopes the query to the authenticated user and omits the internal userId field', async () => {
    let queryArgs: any;
    expenseModel.findMany = async (args: any) => {
      queryArgs = args;
      return [{
        id: 'expense-list-1', title: 'Lunch', category: 'Food',
        amount: 100, currency: 'RUB', amountVnd: null, amountRub: 100,
        usdtCharged: null, date: new Date('2026-10-18T08:00:00.000Z'),
        createdAt: new Date('2026-10-18T08:00:00.000Z'),
        updatedAt: new Date('2026-10-18T08:00:00.000Z'), receiptId: null,
      }];
    };

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/expenses`, {
        headers: { authorization: bearer('user-42') },
      });
      assert.equal(response.status, 200);
      const body = await response.json() as Array<Record<string, unknown>>;
      assert.equal(body.length, 1);
      assert.equal(body[0].id, 'expense-list-1');
      assert.equal('userId' in body[0], false);
    });

    assert.deepEqual(queryArgs.where, { userId: 'user-42' });
    assert.deepEqual(queryArgs.orderBy, [{ date: 'desc' }, { id: 'asc' }]);
    assert.equal(queryArgs.take, 500);
    assert.equal('userId' in queryArgs.select, false);
  });
});

describe('expense cursor pagination', () => {
  it('returns a page and next cursor without crossing user scope', async () => {
    let queryArgs: any;
    expenseModel.findMany = async (args: any) => {
      queryArgs = args;
      return [
        { id: 'expense-a', date: new Date('2026-10-19T10:00:00.000Z') },
        { id: 'expense-b', date: new Date('2026-10-18T10:00:00.000Z') },
      ];
    };
    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/expenses?limit=1`, {
        headers: { authorization: bearer('user-42') },
      });
      assert.equal(response.status, 200);
      const body = await response.json() as { items: Array<{ id: string }>; hasMore: boolean; nextCursor: string | null };
      assert.deepEqual(body.items.map(item => item.id), ['expense-a']);
      assert.equal(body.hasMore, true);
      assert.equal(typeof body.nextCursor, 'string');
    });
    assert.equal(queryArgs.take, 2);
    assert.deepEqual(queryArgs.where.userId, 'user-42');
    assert.deepEqual(queryArgs.orderBy, [{ date: 'desc' }, { id: 'asc' }]);
  });
});
