import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'node:net';
import { prisma } from '../services/prisma.js';

const userModel = prisma.user as unknown as { findFirst: (...args: any[]) => Promise<any> };
const originalUserFindFirst = userModel.findFirst;
import journalRoutes from './journal.js';

const expenseModel = prisma.expense as unknown as { findMany: (...args: any[]) => Promise<any> };
const exchangeModel = prisma.exchange as unknown as { findMany: (...args: any[]) => Promise<any> };
const movementModel = prisma.walletMovement as unknown as { findMany: (...args: any[]) => Promise<any> };
const originalExpenseFindMany = expenseModel.findMany;
const originalExchangeFindMany = exchangeModel.findMany;
const originalMovementFindMany = movementModel.findMany;
const previousSecret = process.env.JWT_SECRET;

afterEach(() => {
  userModel.findFirst = originalUserFindFirst;
  expenseModel.findMany = originalExpenseFindMany;
  exchangeModel.findMany = originalExchangeFindMany;
  movementModel.findMany = originalMovementFindMany;
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
});

async function withApi(run: (baseUrl: string) => Promise<void>) {
  userModel.findFirst = async () => ({ tokenVersion: 0 });
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
      const body = await response.json() as { entries: unknown[]; limit: number; hasMore: boolean; nextCursor: string | null };
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
      assert.equal(typeof body.nextCursor, 'string');
    });
  });

  it('applies a stable timestamp/type/id cursor to all user-scoped sources', async () => {
    let expenseArgs: any;
    let exchangeArgs: any;
    let movementArgs: any;
    expenseModel.findMany = async args => { expenseArgs = args; return []; };
    exchangeModel.findMany = async args => { exchangeArgs = args; return []; };
    movementModel.findMany = async args => { movementArgs = args; return []; };
    const cursor = Buffer.from(JSON.stringify({
      occurredAt: '2026-10-18T08:00:00.000Z',
      id: 'exchange:ex-5',
      type: 'exchange',
    })).toString('base64url');

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/journal?limit=25&cursor=${encodeURIComponent(cursor)}`, {
        headers: { authorization: bearer() },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(expenseArgs.where.userId, 'journal-user');
      assert.deepEqual(exchangeArgs.where.userId, 'journal-user');
      assert.deepEqual(movementArgs.where.userId, 'journal-user');
      assert.equal(expenseArgs.where.OR.length, 2);
      assert.equal(exchangeArgs.where.OR.length, 2);
      assert.equal(movementArgs.where.OR.length, 2);
      assert.deepEqual(exchangeArgs.where.OR[1], {
        createdAt: new Date('2026-10-18T08:00:00.000Z'),
        id: { gt: 'ex-5' },
      });
      assert.deepEqual(await response.json(), { entries: [], limit: 25, hasMore: false, nextCursor: null });
    });
  });

  it('rejects malformed journal cursors without querying records', async () => {
    let queryCount = 0;
    expenseModel.findMany = async () => { queryCount++; return []; };
    exchangeModel.findMany = async () => { queryCount++; return []; };
    movementModel.findMany = async () => { queryCount++; return []; };
    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/journal?cursor=not-a-valid-cursor`, {
        headers: { authorization: bearer() },
      });
      assert.equal(response.status, 400);
      assert.equal(queryCount, 0);
    });
  });

  it('rejects a cursor whose type does not match its prefixed ID', async () => {
    let queryCount = 0;
    expenseModel.findMany = async () => { queryCount++; return []; };
    exchangeModel.findMany = async () => { queryCount++; return []; };
    movementModel.findMany = async () => { queryCount++; return []; };
    const cursor = Buffer.from(JSON.stringify({
      occurredAt: '2026-10-18T08:00:00.000Z',
      id: 'expense:exp-7',
      type: 'exchange',
    })).toString('base64url');

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/journal?cursor=${encodeURIComponent(cursor)}`, {
        headers: { authorization: bearer() },
      });
      assert.equal(response.status, 400);
      assert.equal(queryCount, 0);
    });
  });

  it('accepts the wallet-movement cursor shape emitted by journal entries', async () => {
    let movementArgs: any;
    expenseModel.findMany = async () => [];
    exchangeModel.findMany = async () => [];
    movementModel.findMany = async args => { movementArgs = args; return []; };
    const cursor = Buffer.from(JSON.stringify({
      occurredAt: '2026-10-18T08:00:00.000Z',
      id: 'movement:move-7',
      type: 'wallet_movement',
    })).toString('base64url');

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/journal?limit=25&cursor=${encodeURIComponent(cursor)}`, {
        headers: { authorization: bearer() },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(movementArgs.where.OR[1], {
        occurredAt: new Date('2026-10-18T08:00:00.000Z'),
        id: { gt: 'move-7' },
      });
    });
  });

  it('continues after the last entry without repeating equal-timestamp records', async () => {
    const timestamp = new Date('2026-10-18T08:00:00.000Z');
    const expenseRows = ['a', 'b'].map(id => ({
      id: `expense-${id}`, title: id, category: 'Other', amount: 1, currency: 'RUB',
      amountVnd: null, amountRub: 1, usdtCharged: null, date: timestamp, createdAt: timestamp,
    }));
    const exchangeRow = {
      id: 'exchange-a', mode: 'RUB_TARGET', rubSpent: 1000, usdtReceived: null,
      vndReceived: 100000, targetCurrency: 'VND', targetReceived: 100000,
      targetVndEquivalent: 100000, createdAt: timestamp,
    };
    let expenseCalls = 0;
    let exchangeCalls = 0;
    expenseModel.findMany = async () => {
      expenseCalls++;
      return expenseCalls === 1 ? expenseRows : [expenseRows[1]];
    };
    exchangeModel.findMany = async () => {
      exchangeCalls++;
      return exchangeCalls === 1 ? [exchangeRow] : [];
    };
    movementModel.findMany = async () => [];

    await withApi(async baseUrl => {
      const first = await fetch(`${baseUrl}/api/journal?limit=2`, {
        headers: { authorization: bearer() },
      });
      assert.equal(first.status, 200);
      const firstBody = await first.json() as {
        entries: Array<{ id: string }>;
        hasMore: boolean;
        nextCursor: string | null;
      };
      assert.deepEqual(firstBody.entries.map(entry => entry.id), ['exchange:exchange-a', 'expense:expense-a']);
      assert.equal(firstBody.hasMore, true);
      assert.ok(firstBody.nextCursor);
      const decoded = JSON.parse(Buffer.from(firstBody.nextCursor!, 'base64url').toString('utf8'));
      assert.deepEqual(decoded, {
        occurredAt: timestamp.toISOString(),
        id: 'expense:expense-a',
        type: 'expense',
      });

      const second = await fetch(`${baseUrl}/api/journal?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor!)}`, {
        headers: { authorization: bearer() },
      });
      assert.equal(second.status, 200);
      const secondBody = await second.json() as {
        entries: Array<{ id: string }>;
        hasMore: boolean;
        nextCursor: string | null;
      };
      assert.deepEqual(secondBody.entries.map(entry => entry.id), ['expense:expense-b']);
      assert.equal(secondBody.hasMore, false);
      assert.equal(secondBody.nextCursor, null);
    });
  });
});
