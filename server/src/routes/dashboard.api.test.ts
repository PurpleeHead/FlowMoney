import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'node:net';
import { prisma } from '../services/prisma.js';
import dashboardRoutes from './dashboard.js';

const userModel = prisma.user as unknown as { findFirst: (...args: any[]) => Promise<any> };
const expenseModel = prisma.expense as unknown as { findMany: (...args: any[]) => Promise<any> };
const exchangeModel = prisma.exchange as unknown as { findMany: (...args: any[]) => Promise<any> };
const originalUserFindFirst = userModel.findFirst;
const originalExpenseFindMany = expenseModel.findMany;
const originalExchangeFindMany = exchangeModel.findMany;
const previousSecret = process.env.JWT_SECRET;

afterEach(() => {
  userModel.findFirst = originalUserFindFirst;
  expenseModel.findMany = originalExpenseFindMany;
  exchangeModel.findMany = originalExchangeFindMany;
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
});

async function withApi(run: (baseUrl: string) => Promise<void>) {
  userModel.findFirst = async () => ({ tokenVersion: 0 });
  process.env.JWT_SECRET = 'dashboard-api-test-secret-long-enough-for-jwt-middleware';
  const app = express();
  app.use('/api/dashboard', dashboardRoutes);
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

function exchangeFixture() {
  return {
    id: 'direct-usdt',
    mode: 'RUB_TARGET',
    rubSpent: 8300,
    usdtReceived: null,
    vndPerUsdt: null,
    planningVndPerUsdt: null,
    vndFee: 0,
    vndReceived: null,
    effectiveVndPerRub: null,
    effectiveRubPerUsdt: null,
    targetCurrency: 'USDT',
    targetReceived: 93.7853,
    targetToVndRate: 25400,
    targetVndEquivalent: 2382156.62,
    createdAt: new Date('2026-10-18T08:00:00.000Z'),
  };
}

describe('dashboard unpriced USDT balance', () => {
  it('does not present an unknown VND balance as zero after a direct USDT top-up', async () => {
    expenseModel.findMany = async () => [];
    exchangeModel.findMany = async () => [{
      ...exchangeFixture(),
      targetToVndRate: null,
      targetVndEquivalent: null,
    }];

    await withApi(async baseUrl => {
      const token = jwt.sign(
        { id: 'dashboard-user', email: 'dashboard-user@example.com' },
        'dashboard-api-test-secret-long-enough-for-jwt-middleware',
      );
      const response = await fetch(`${baseUrl}/api/dashboard`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(response.status, 200);
      const body = await response.json() as { balanceVnd: number | null; estimatedUnconvertedVnd: number };
      assert.equal(body.balanceVnd, null);
      assert.equal(body.estimatedUnconvertedVnd, 0);
    });
  });
});

describe('dashboard exchange rates', () => {
  it('includes direct RUB-to-USDT target exchanges in the effective RUB/USDT rate', async () => {
    expenseModel.findMany = async () => [];
    exchangeModel.findMany = async ({ where }: any) => {
      assert.deepEqual(where, { userId: 'dashboard-user' });
      return [exchangeFixture()];
    };

    await withApi(async baseUrl => {
      const token = jwt.sign(
        { id: 'dashboard-user', email: 'dashboard-user@example.com' },
        'dashboard-api-test-secret-long-enough-for-jwt-middleware',
      );
      const response = await fetch(`${baseUrl}/api/dashboard`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(response.status, 200);
      const body = await response.json() as { effectiveRubPerUsdt: number | null };
      assert.ok(body.effectiveRubPerUsdt != null);
      assert.ok(Math.abs(body.effectiveRubPerUsdt - (8300 / 93.7853)) < 1e-10);
    });
  });
});
