import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'node:net';
import { prisma } from '../services/prisma.js';
import dashboardRoutes from './dashboard.js';

const userModel = prisma.user as unknown as { findFirst: (...args: any[]) => Promise<any> };
const expenseModel = prisma.expense as unknown as { findMany: (...args: any[]) => Promise<any>; aggregate: (...args: any[]) => Promise<any> };
const exchangeModel = prisma.exchange as unknown as { findMany: (...args: any[]) => Promise<any> };
const originalUserFindFirst = userModel.findFirst;
const originalExpenseFindMany = expenseModel.findMany;
const originalExchangeFindMany = exchangeModel.findMany;
const previousSecret = process.env.JWT_SECRET;
let dashboardAggregateArgs: any[] = [];

afterEach(() => {
  userModel.findFirst = originalUserFindFirst;
  expenseModel.findMany = originalExpenseFindMany;
  exchangeModel.findMany = originalExchangeFindMany;
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
});

async function withApi(run: (baseUrl: string) => Promise<void>) {
  // Fake Prisma aggregate using each test's fixture, while preserving the same predicates
  // as PostgreSQL. This keeps route tests independent of a live database.
  dashboardAggregateArgs = [];
  expenseModel.aggregate = async (args: any) => {
    dashboardAggregateArgs.push(args);
    const rows = await expenseModel.findMany({});
    const where = args.where ?? {};
    const filtered = rows.filter((row: any) => {
      if (where.date?.gte && new Date(row.date) < where.date.gte) return false;
      if (where.amountVnd?.gt != null && !(row.amountVnd != null && Number(row.amountVnd) > where.amountVnd.gt)) return false;
      if (where.usdtCharged?.gt != null && !(row.usdtCharged != null && Number(row.usdtCharged) > where.usdtCharged.gt)) return false;
      return true;
    });
    const sums: Record<string, number | null> = {};
    for (const key of Object.keys(args._sum ?? {})) {
      const values = filtered.map((row: any) => row[key]).filter((value: any) => value != null).map(Number);
      sums[key] = values.length ? values.reduce((sum: number, value: number) => sum + value, 0) : null;
    }
    return { _sum: sums };
  };
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



describe('dashboard query shape', () => {
  it('selects only fields needed for dashboard calculations and visible history', async () => {
    let expenseArgs: any;
    let exchangeArgs: any;
    expenseModel.findMany = async (args: any) => { if (args.select) expenseArgs = args; return []; };
    exchangeModel.findMany = async (args: any) => { exchangeArgs = args; return []; };

    await withApi(async baseUrl => {
      const token = jwt.sign(
        { id: 'dashboard-user', email: 'dashboard-user@example.com' },
        'dashboard-api-test-secret-long-enough-for-jwt-middleware',
      );
      const response = await fetch(`${baseUrl}/api/dashboard`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(response.status, 200);
    });

    assert.equal(expenseArgs.where.userId, 'dashboard-user');
    assert.ok(expenseArgs.where.date.gte instanceof Date);
    const expectedChartStart = new Date(new Date().getFullYear(), new Date().getMonth() - 11, 1);
    assert.equal(expenseArgs.where.date.gte.getTime(), expectedChartStart.getTime());
    assert.deepEqual(expenseArgs.orderBy, { date: 'desc' });
    assert.deepEqual(Object.keys(expenseArgs.select).sort(), [
      'amount', 'amountRub', 'amountVnd', 'category', 'currency', 'date',
      'id', 'title', 'usdtCharged',
    ].sort());
    assert.deepEqual(exchangeArgs.where, { userId: 'dashboard-user' });
    assert.deepEqual(exchangeArgs.orderBy, { createdAt: 'desc' });
    assert.equal(dashboardAggregateArgs.length, 3);
    assert.ok(dashboardAggregateArgs.every(args => args.where.userId === 'dashboard-user'));
    assert.deepEqual(Object.keys(exchangeArgs.select).sort(), [
      'createdAt', 'effectiveRubPerUsdt', 'effectiveVndPerRub', 'id', 'mode',
      'planningVndPerUsdt', 'rubSpent', 'targetCurrency', 'targetReceived',
      'targetToVndRate', 'targetVndEquivalent', 'usdtReceived', 'vndPerUsdt',
      'vndReceived',
    ].sort());
  });
});


describe('dashboard weighted rates preserve actual observations', () => {
  it('weights actual card observations by charged USDT and does not use planning-only rates as actual', async () => {
    expenseModel.findMany = async () => [
      {
        id: 'card-a', title: 'Groceries', category: 'Food', amount: 120000,
        currency: 'VND', amountVnd: 120000, amountRub: 332, usdtCharged: 4,
        date: new Date('2026-10-10T08:00:00.000Z'),
      },
      {
        id: 'card-b', title: 'Dinner', category: 'Food', amount: 60000,
        currency: 'VND', amountVnd: 60000, amountRub: 166, usdtCharged: 3,
        date: new Date('2026-10-11T08:00:00.000Z'),
      },
    ];
    exchangeModel.findMany = async () => [
      {
        ...exchangeFixture(),
        id: 'actual-exchange',
        targetToVndRate: null,
        targetVndEquivalent: null,
        targetReceived: 40,
        rubSpent: 3600,
        planningVndPerUsdt: 26000,
        vndReceived: 1000000,
        usdtReceived: 40,
      },
      {
        ...exchangeFixture(),
        id: 'planning-only-exchange',
        targetToVndRate: null,
        targetVndEquivalent: null,
        targetReceived: 20,
        rubSpent: 1800,
        planningVndPerUsdt: 30000,
        vndReceived: null,
        usdtReceived: 20,
      },
    ];

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
        observedVndPerUsdt: number | null;
        effectiveVndPerUsdt: number | null;
        effectiveRubPerUsdt: number | null;
        planningVndPerUsdt: number | null;
      };
      assert.ok(body.observedVndPerUsdt != null);
      assert.ok(Math.abs(body.observedVndPerUsdt - (180000 / 7)) < 1e-8);
      assert.equal(body.effectiveVndPerUsdt, body.observedVndPerUsdt);
      assert.ok(body.effectiveRubPerUsdt != null);
      assert.ok(Math.abs(body.effectiveRubPerUsdt - (5400 / 60)) < 1e-8);
      assert.ok(body.planningVndPerUsdt != null);
      assert.equal(body.planningVndPerUsdt, 30000);
    });
  });
});


describe('dashboard aggregates stay independent from chart history window', () => {
  it('keeps all-time totals and weighted purchase rates while returning only chart-window expenses', async () => {
    const recent = {
      id: 'recent-expense', title: 'Recent', category: 'Food', amount: 50000,
      currency: 'VND', amountVnd: 50000, amountRub: 140, usdtCharged: 2,
      date: new Date(), receiptId: null,
    };
    const old = {
      id: 'old-expense', title: 'Old', category: 'Food', amount: 100000,
      currency: 'VND', amountVnd: 100000, amountRub: 280, usdtCharged: 5,
      date: new Date('2024-01-15T08:00:00.000Z'), receiptId: null,
    };
    expenseModel.findMany = async (args: any) => {
      const all = [recent, old];
      return args.where?.date?.gte
        ? all.filter(row => row.date >= args.where.date.gte)
        : all;
    };
    exchangeModel.findMany = async () => [];

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
        totalVnd: number;
        monthVnd: number;
        observedVnd: number;
        observedUsdt: number;
        observedVndPerUsdt: number | null;
        expenses: Array<{ id: string }>;
      };
      assert.equal(body.totalVnd, 150000);
      assert.equal(body.monthVnd, 50000);
      assert.equal(body.observedVnd, 150000);
      assert.equal(body.observedUsdt, 7);
      assert.ok(body.observedVndPerUsdt != null);
      assert.ok(Math.abs(body.observedVndPerUsdt - (150000 / 7)) < 1e-8);
      assert.deepEqual(body.expenses.map(row => row.id), ['recent-expense']);
    });
  });
});
