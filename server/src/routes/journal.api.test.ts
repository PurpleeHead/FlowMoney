import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'node:net';
import { prisma } from '../services/prisma.js';
import journalRoutes from './journal.js';

const expenseModel = prisma.expense as unknown as { findMany: (...args: any[]) => Promise<any> };
const exchangeModel = prisma.exchange as unknown as { findMany: (...args: any[]) => Promise<any> };
const movementModel = prisma.walletMovement as unknown as { findMany: (...args: any[]) => Promise<any> };
const originalExpenseFindMany = expenseModel.findMany;
const originalExchangeFindMany = exchangeModel.findMany;
const originalMovementFindMany = movementModel.findMany;
const previousSecret = process.env.JWT_SECRET;

afterEach(() => {
  expenseModel.findMany = originalExpenseFindMany;
  exchangeModel.findMany = originalExchangeFindMany;
  movementModel.findMany = originalMovementFindMany;
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
});

async function withApi(run: (baseUrl: string) => Promise<void>) {
  process.env.JWT_SECRET = 'journal-api-test-secret-long-enough-for-jwt-middleware';
  const app = express();
  app.use('/api/journal', journalRoutes);
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

function bearer() {
  return `Bearer ${jwt.sign({ id: 'journal-user', email: 'journal-user@example.com' }, 'journal-api-test-secret-long-enough-for-jwt-middleware')}`;
}

describe('journal API integration', () => {
  it('fetches one extra row per source to calculate hasMore correctly at the maximum page size', async () => {
    let expenseArgs: any;
    let exchangeArgs: any;
    let movementArgs: any;
    expenseModel.findMany = async args => {
      expenseArgs = args;
      return Array.from({ length: 501 }, (_, index) => ({
        id: `expense-${index}`, title: 'Test expense', category: 'Other',
        amount: 1, currency: 'RUB', amountVnd: null, amountRub: null, usdtCharged: null,
        date: new Date('2026-10-18T08:00:00.000Z'), createdAt: new Date('2026-10-18T08:00:00.000Z'),
      }));
    };
    exchangeModel.findMany = async args => { exchangeArgs = args; return []; };
    movementModel.findMany = async args => { movementArgs = args; return []; };

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/journal?limit=500`, {
        headers: { authorization: bearer() },
      });
      assert.equal(response.status, 200);
      const body = await response.json() as { entries: unknown[]; limit: number; hasMore: boolean };
      assert.equal(expenseArgs.take, 501);
      assert.deepEqual(expenseArgs.where, { userId: 'journal-user' });
      assert.deepEqual(exchangeArgs.where, { userId: 'journal-user' });
      assert.deepEqual(movementArgs.where, { userId: 'journal-user' });
      assert.deepEqual(expenseArgs.orderBy, [{ date: 'desc' }, { id: 'asc' }]);
      assert.deepEqual(exchangeArgs.orderBy, [{ createdAt: 'desc' }, { id: 'asc' }]);
      assert.deepEqual(movementArgs.orderBy, [{ occurredAt: 'desc' }, { id: 'asc' }]);
      assert.equal(body.entries.length, 500);
      assert.equal(body.limit, 500);
      assert.equal(body.hasMore, true);
    });
  });
});
