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
    targetVndEquivalent: 2382146.62,
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

describe('dashboard confirmed and estimated VND totals', () => {
  it('keeps non-VND target equivalents in estimates rather than confirmed VND received', async () => {
    expenseModel.findMany = async () => [];
    exchangeModel.findMany = async () => [exchangeFixture()];

    await withApi(async baseUrl => {
      const token = jwt.sign(
        { id: 'dashboard-user', email: 'dashboard-user@example.com' },
        'dashboard-api-test-secret-long-enough-for-jwt-middleware',
      );
      const response = await fetch(`${baseUrl}/api/dashboard`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(response.status, 200);
      const body = await response.json() as {
        confirmedExchangeVnd: number;
        estimatedUnconvertedVnd: number;
        balanceIsEstimated: boolean;
      };
      assert.equal(body.confirmedExchangeVnd, 0);
      assert.equal(body.estimatedUnconvertedVnd, 2382146.62);
      assert.equal(body.balanceIsEstimated, true);
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

describe('dashboard confirmed direct VND outcomes', () => {
  it('prefers actual net VND and counts a direct-target exchange only once', async () => {
    expenseModel.findMany = async () => [];
    const token = jwt.sign(
      { id: 'dashboard-user', email: 'dashboard-user@example.com' },
      'dashboard-api-test-secret-long-enough-for-jwt-middleware',
    );

    for (const scenario of [
      { vndReceived: 900000, expected: 900000, label: 'net outcome' },
      { vndReceived: 0, expected: 0, label: 'explicit zero outcome' },
    ]) {
      exchangeModel.findMany = async () => [{
        ...exchangeFixture(),
        mode: 'RUB_TARGET',
        targetCurrency: 'VND',
        targetReceived: 1000000,
        targetVndEquivalent: 950000,
        vndReceived: scenario.vndReceived,
      }];

      await withApi(async baseUrl => {
        const response = await fetch(`${baseUrl}/api/dashboard`, {
          headers: { authorization: `Bearer ${token}` },
        });
        assert.equal(response.status, 200);
        const body = await response.json() as { confirmedExchangeVnd: number };
        assert.equal(body.confirmedExchangeVnd, scenario.expected, scenario.label);
      });
    }
  });
});

describe('dashboard direct VND rate precedence', () => {
  it('uses the actual net VND outcome instead of the legacy target equivalent', async () => {
    expenseModel.findMany = async () => [];
    exchangeModel.findMany = async () => [{
      ...exchangeFixture(),
      mode: 'RUB_TARGET',
      targetCurrency: 'VND',
      targetReceived: 1000000,
      targetVndEquivalent: 950000,
      vndReceived: 900000,
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
      const body = await response.json() as { effectiveVndPerRub: number | null };
      assert.ok(body.effectiveVndPerRub != null);
      assert.ok(Math.abs(body.effectiveVndPerRub - (900000 / 8300)) < 1e-10);
    });
  });
});

describe('dashboard historical expense snapshots', () => {
  it('returns the stored RUB valuation instead of recalculating past expenses from current exchange rates', async () => {
    expenseModel.findMany = async () => [{
      id: 'historical-card-purchase',
      userId: 'dashboard-user',
      title: 'Groceries',
      category: 'Food',
      amount: 120000,
      currency: 'VND',
      amountVnd: 120000,
      amountRub: 332,
      usdtCharged: 4,
      date: new Date('2026-10-10T08:00:00.000Z'),
      receiptId: null,
    }];
    exchangeModel.findMany = async () => [{
      ...exchangeFixture(),
      rubSpent: 8300,
      targetReceived: 40,
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
      const body = await response.json() as {
        expenses: Array<{ id: string; amountRub: number | null; amountVnd: number | null; usdtCharged: number | null }>;
      };
      assert.equal(body.expenses.length, 1);
      assert.equal(body.expenses[0].id, 'historical-card-purchase');
      assert.equal(body.expenses[0].amountRub, 332);
      assert.equal(body.expenses[0].amountVnd, 120000);
      assert.equal(body.expenses[0].usdtCharged, 4);
    });
  });
});

