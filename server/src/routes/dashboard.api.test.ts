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
const originalExpenseAggregate = expenseModel.aggregate;
const originalExchangeFindMany = exchangeModel.findMany;
const previousSecret = process.env.JWT_SECRET;
let dashboardAggregateArgs: any[] = [];

afterEach(() => {
  userModel.findFirst = originalUserFindFirst;
  expenseModel.findMany = originalExpenseFindMany;
  expenseModel.aggregate = originalExpenseAggregate;
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
    const allTimeAggregate = dashboardAggregateArgs.find(args => args._sum.amountVnd && !args.where.date);
    const monthAggregate = dashboardAggregateArgs.find(args => args.where.date?.gte);
    const purchaseAggregate = dashboardAggregateArgs.find(args => args._sum.usdtCharged);
    assert.ok(allTimeAggregate, 'all-time expense aggregate must not have a date limit');
    assert.ok(monthAggregate, 'month aggregate must have a date boundary');
    assert.ok(purchaseAggregate, 'weighted card aggregate must sum VND and USDT');
    assert.ok(monthAggregate.where.date.gte instanceof Date);
    assert.deepEqual(purchaseAggregate.where, {
      userId: 'dashboard-user', amountVnd: { gt: 0 }, usdtCharged: { gt: 0 },
    });
    assert.deepEqual(Object.keys(purchaseAggregate._sum).sort(), ['amountVnd', 'usdtCharged']);
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


describe('dashboard direct RUB-to-VND target exchange', () => {
  it('counts the direct VND target equivalent once as confirmed VND, not as an estimate', async () => {
    expenseModel.findMany = async () => [];
    exchangeModel.findMany = async ({ where }: any) => {
      assert.deepEqual(where, { userId: 'dashboard-user' });
      return [{
        id: 'direct-vnd-target',
        mode: 'RUB_TARGET',
        rubSpent: 3500,
        usdtReceived: null,
        vndPerUsdt: null,
        planningVndPerUsdt: null,
        vndFee: 0,
        vndReceived: null,
        effectiveVndPerRub: 1000000 / 3500,
        effectiveRubPerUsdt: null,
        targetCurrency: 'VND',
        targetReceived: 1000000,
        targetToVndRate: 1,
        targetVndEquivalent: 1000000,
        createdAt: new Date('2026-10-18T08:00:00.000Z'),
      }];
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
      const body = await response.json() as {
        confirmedExchangeVnd: number;
        estimatedUnconvertedVnd: number;
        balanceVnd: number | null;
        balanceIsEstimated: boolean;
        effectiveVndPerRub: number | null;
        observedVndPerUsdt: number | null;
        effectiveVndPerUsdt: number | null;
      };
      assert.equal(body.confirmedExchangeVnd, 1000000);
      assert.equal(body.estimatedUnconvertedVnd, 0);
      assert.equal(body.balanceVnd, 1000000);
      assert.equal(body.balanceIsEstimated, false);
      // A legacy direct VND target is not a RUB→USDT→VND rate observation,
      // even when stale USDT/VND fields remain on the record.
      assert.equal(body.observedVndPerUsdt, null);
      assert.equal(body.effectiveVndPerUsdt, null);
      assert.ok(body.effectiveVndPerRub != null);
      assert.ok(
        Math.abs(body.effectiveVndPerRub - (1000000 / 3500)) < 1e-10,
        'direct target VND exchange must contribute exactly once to the observed VND/RUB rate',
      );
    });
  });
});

describe('dashboard direct VND target legacy compatibility', () => {
  it('does not double-count a direct VND target if legacy vndReceived is also populated', async () => {
    expenseModel.findMany = async () => [];
    exchangeModel.findMany = async () => [
      {
        id: 'legacy-direct-vnd-target-with-duplicate-fields',
        mode: 'RUB_TARGET',
        rubSpent: 3500,
        usdtReceived: null,
        vndPerUsdt: null,
        planningVndPerUsdt: null,
        vndFee: 0,
        vndReceived: 1000000,
        effectiveVndPerRub: 1000000 / 3500,
        effectiveRubPerUsdt: null,
        targetCurrency: 'VND',
        targetReceived: 1000000,
        targetToVndRate: 1,
        targetVndEquivalent: 1000000,
        createdAt: new Date('2026-10-18T08:00:00.000Z'),
      },
      {
        id: 'legacy-direct-vnd-target-without-equivalent',
        mode: 'RUB_TARGET',
        rubSpent: 3500,
        usdtReceived: null,
        vndPerUsdt: null,
        planningVndPerUsdt: null,
        vndFee: 0,
        vndReceived: null,
        effectiveVndPerRub: null,
        effectiveRubPerUsdt: null,
        targetCurrency: 'VND',
        targetReceived: 500000,
        targetToVndRate: null,
        targetVndEquivalent: null,
        createdAt: new Date('2026-10-18T08:00:00.000Z'),
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
        confirmedExchangeVnd: number;
        estimatedUnconvertedVnd: number;
        balanceVnd: number | null;
        effectiveVndPerRub: number | null;
      };
      assert.equal(body.confirmedExchangeVnd, 1500000);
      assert.equal(body.estimatedUnconvertedVnd, 0);
      assert.equal(body.balanceVnd, 1500000);
      assert.ok(body.effectiveVndPerRub != null);
      assert.ok(Math.abs(body.effectiveVndPerRub - (1500000 / 7000)) < 1e-10);
    });
  });
});


describe('dashboard mixed direct VND exchange modes', () => {
  it('weights RUB_VND and RUB_TARGET-to-VND outcomes once in the same observed rate', async () => {
    expenseModel.findMany = async () => [];
    exchangeModel.findMany = async ({ where }: any) => {
      assert.deepEqual(where, { userId: 'dashboard-user' });
      return [
        {
          id: 'direct-rub-vnd',
          mode: 'RUB_VND',
          rubSpent: 2500,
          usdtReceived: null,
          vndPerUsdt: null,
          planningVndPerUsdt: null,
          vndFee: 0,
          vndReceived: 500000,
          effectiveVndPerRub: 200,
          effectiveRubPerUsdt: null,
          targetCurrency: null,
          targetReceived: null,
          targetToVndRate: null,
          targetVndEquivalent: null,
          createdAt: new Date('2026-10-17T08:00:00.000Z'),
        },
        {
          id: 'direct-vnd-target',
          mode: 'RUB_TARGET',
          rubSpent: 3500,
          usdtReceived: null,
          vndPerUsdt: null,
          planningVndPerUsdt: null,
          vndFee: 0,
          vndReceived: null,
          effectiveVndPerRub: 1000000 / 3500,
          effectiveRubPerUsdt: null,
          targetCurrency: 'VND',
          targetReceived: 1000000,
          targetToVndRate: 1,
          targetVndEquivalent: 1000000,
          createdAt: new Date('2026-10-18T08:00:00.000Z'),
        },
      ];
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
      const body = await response.json() as {
        confirmedExchangeVnd: number;
        estimatedUnconvertedVnd: number;
        balanceVnd: number | null;
        effectiveVndPerRub: number | null;
      };
      assert.equal(body.confirmedExchangeVnd, 1500000);
      assert.equal(body.estimatedUnconvertedVnd, 0);
      assert.equal(body.balanceVnd, 1500000);
      assert.ok(body.effectiveVndPerRub != null);
      assert.ok(
        Math.abs(body.effectiveVndPerRub - (1500000 / 6000)) < 1e-10,
        'both direct exchange modes must contribute their actual VND and RUB exactly once',
      );
    });
  });
});



describe('dashboard observed VND/RUB combines all actual source types once', () => {
  it('weights direct exchanges, actual exchange outcomes, and card purchases without double counting', async () => {
    expenseModel.findMany = async () => [{
      id: 'card-observation',
      title: 'Market',
      category: 'Food',
      amount: 50000,
      currency: 'VND',
      amountVnd: 50000,
      amountRub: null,
      usdtCharged: 5,
      date: new Date('2026-10-19T08:00:00.000Z'),
    }];
    exchangeModel.findMany = async () => [
      {
        ...exchangeFixture(),
        id: 'direct-rub-vnd',
        mode: 'RUB_VND',
        rubSpent: 1000,
        usdtReceived: null,
        targetCurrency: null,
        targetReceived: null,
        targetToVndRate: null,
        targetVndEquivalent: null,
        vndReceived: 200000,
        planningVndPerUsdt: null,
        effectiveVndPerRub: 200,
        effectiveRubPerUsdt: null,
      },
      {
        ...exchangeFixture(),
        id: 'direct-vnd-target',
        mode: 'RUB_TARGET',
        rubSpent: 2000,
        usdtReceived: null,
        targetCurrency: 'VND',
        targetReceived: 400000,
        targetToVndRate: 1,
        targetVndEquivalent: 400000,
        vndReceived: null,
        planningVndPerUsdt: null,
        effectiveVndPerRub: 200,
        effectiveRubPerUsdt: null,
      },
      {
        ...exchangeFixture(),
        id: 'actual-usdt-vnd',
        mode: 'RUB_USDT_VND',
        rubSpent: 3000,
        usdtReceived: 30,
        targetCurrency: null,
        targetReceived: null,
        targetToVndRate: null,
        targetVndEquivalent: null,
        vndReceived: 750000,
        planningVndPerUsdt: null,
        effectiveVndPerRub: 250,
        effectiveRubPerUsdt: 100,
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
        confirmedExchangeVnd: number;
        estimatedUnconvertedVnd: number;
        balanceVnd: number | null;
        effectiveVndPerRub: number | null;
      };
      assert.equal(body.confirmedExchangeVnd, 1350000);
      assert.equal(body.estimatedUnconvertedVnd, 0);
      assert.equal(body.balanceVnd, 1300000, 'the 50,000 VND card purchase must reduce the exchange balance');
      assert.ok(body.effectiveVndPerRub != null);
      assert.ok(
        Math.abs(body.effectiveVndPerRub - (1400000 / 6500)) < 1e-10,
        'observed VND/RUB must combine 600,000 direct VND, 750,000 exchange VND, and 50,000 card VND against 6,000 RUB plus 500 RUB card cost',
      );
    });
  });
});


describe('dashboard planning rates stay separate from factual rates', () => {
  it('does not promote a planning-only exchange rate into observed or effective VND/USDT', async () => {
    expenseModel.findMany = async () => [];
    exchangeModel.findMany = async () => [{
      ...exchangeFixture(),
      id: 'planning-only',
      mode: 'RUB_USDT_VND',
      targetCurrency: null,
      targetReceived: null,
      targetToVndRate: null,
      targetVndEquivalent: null,
      usdtReceived: 100,
      vndReceived: null,
      vndPerUsdt: null,
      planningVndPerUsdt: 26000,
      rubSpent: 9000,
      effectiveVndPerRub: null,
      effectiveRubPerUsdt: 90,
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
        observedVndPerUsdt: number | null;
        effectiveVndPerUsdt: number | null;
        planningVndPerUsdt: number | null;
        confirmedExchangeVnd: number;
        estimatedUnconvertedVnd: number;
      };
      assert.equal(body.observedVndPerUsdt, null);
      assert.equal(body.effectiveVndPerUsdt, null);
      assert.equal(body.planningVndPerUsdt, 26000);
      assert.equal(body.confirmedExchangeVnd, 0);
      assert.equal(body.estimatedUnconvertedVnd, 2600000);
    });
  });
});


describe('dashboard legacy direct VND target records', () => {
  it('does not treat a legacy direct VND target as an unconverted USDT top-up', async () => {
    expenseModel.findMany = async () => [];
    exchangeModel.findMany = async () => [{
      ...exchangeFixture(),
      id: 'legacy-direct-vnd',
      mode: 'RUB_TARGET',
      targetCurrency: 'VND',
      targetReceived: 1000000,
      targetToVndRate: 1,
      targetVndEquivalent: 1000000,
      // Older records may have retained this field from an earlier exchange form.
      usdtReceived: 10,
      vndReceived: null,
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
        confirmedExchangeVnd: number;
        estimatedUnconvertedVnd: number;
        balanceVnd: number | null;
        balanceIsEstimated: boolean;
        observedVndPerUsdt: number | null;
        effectiveVndPerUsdt: number | null;
      };
      assert.equal(body.confirmedExchangeVnd, 1000000);
      assert.equal(body.estimatedUnconvertedVnd, 0);
      assert.equal(body.balanceVnd, 1000000);
      assert.equal(body.balanceIsEstimated, false);
      assert.equal(body.observedVndPerUsdt, null);
      assert.equal(body.effectiveVndPerUsdt, null);
    });
  });
});
