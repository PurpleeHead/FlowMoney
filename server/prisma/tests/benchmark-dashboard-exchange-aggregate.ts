import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import jwt from 'jsonwebtoken';
import { Prisma } from '@prisma/client';
import { prisma } from '../../src/services/prisma.js';
import { aggregateDashboardExchanges, dashboardExchangeAggregateQuery } from '../../src/lib/dashboard-exchange-aggregate.js';
import dashboardRoutes from '../../src/routes/dashboard.js';

const suffix = `dashboard-aggregate-benchmark-${Date.now()}`;
const users: string[] = [];
let apiServer: ReturnType<typeof createServer> | undefined;
const EXCHANGES_PER_USER = 2_500;
const EXPENSES_PER_USER = 1_000;
const TENANT_COUNT = 10;
const EXPECTED_EXPENSE_VND = Array.from({ length: EXPENSES_PER_USER }, (_, i) => 20_000 + (i % 37) * 1_000)
  .reduce((total, amount) => total + amount, 0);

try {
  // Disposable CI database only: model a multi-tenant table with 25k exchange rows.
  for (let tenant = 0; tenant < TENANT_COUNT; tenant += 1) {
    const user = await prisma.user.create({
      data: { email: `${suffix}-${tenant}@example.invalid`, passwordHash: 'test-only' },
    });
    users.push(user.id);
    await prisma.exchange.createMany({
      data: Array.from({ length: EXCHANGES_PER_USER }, (_, i) => ({
        userId: user.id,
        mode: i % 7 === 0 ? 'RUB_TARGET' : 'RUB_USDT_VND',
        targetCurrency: i % 7 === 0 ? 'USDT' : 'VND',
        rubSpent: 1_000 + (i % 19) * 17,
        usdtReceived: i % 13 === 0 ? null : 10 + (i % 11),
        targetReceived: i % 7 === 0 ? 12 + (i % 5) : null,
        vndReceived: i % 13 === 0 ? null : 200_000 + (i % 31) * 1_000,
        planningVndPerUsdt: i % 13 === 0 ? 24_000 : null,
      })),
    });
    await prisma.expense.createMany({
      data: Array.from({ length: EXPENSES_PER_USER }, (_, i) => ({
        userId: user.id,
        title: `Synthetic dashboard expense ${i + 1}`,
        category: i % 4 === 0 ? 'Food' : i % 4 === 1 ? 'Transport' : i % 4 === 2 ? 'Shopping' : 'Other',
        amount: 20_000 + (i % 37) * 1_000,
        currency: 'VND',
        amountVnd: 20_000 + (i % 37) * 1_000,
        amountRub: 60 + (i % 19),
        usdtCharged: 0.8 + (i % 13) / 10,
        date: new Date(Date.now() - (i % 300) * 24 * 60 * 60 * 1_000),
      })),
    });
  }

  await prisma.$executeRaw`ANALYZE "Exchange"`;
  await prisma.$executeRaw`ANALYZE "Expense"`;
  const targetUserId = users[0];

  // Warm the connection/cache, then report multiple real timings for the exact
  // runtime aggregate helper called by the dashboard route.
  await aggregateDashboardExchanges(targetUserId);
  const timingsMs: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const started = performance.now();
    const result = await aggregateDashboardExchanges(targetUserId);
    timingsMs.push(Number((performance.now() - started).toFixed(3)));
    assert.ok(Number.isFinite(result.rubUsdtRub), 'runtime aggregate returns finite tenant-scoped totals');
  }

  const historyStarted = performance.now();
  const history = await prisma.exchange.findMany({
    where: { userId: targetUserId },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      id: true, mode: true, targetCurrency: true, targetReceived: true,
      targetToVndRate: true, targetVndEquivalent: true, rubSpent: true,
      usdtReceived: true, vndPerUsdt: true, planningVndPerUsdt: true,
      vndReceived: true, effectiveVndPerRub: true, effectiveRubPerUsdt: true,
      createdAt: true,
    },
  });
  const historyQueryMs = Number((performance.now() - historyStarted).toFixed(3));
  const historyPayloadBytes = Buffer.byteLength(JSON.stringify(history), 'utf8');
  assert.equal(history.length, 100, 'dashboard history response must remain capped at 100 exchanges');

  // Exercise the real dashboard route against this disposable database so the
  // benchmark captures end-to-end API latency and the complete JSON response size.
  const secret = `${suffix}-jwt-secret-long-enough-for-dashboard-benchmark`;
  process.env.JWT_SECRET = secret;
  const app = express();
  app.use('/api/dashboard', dashboardRoutes);
  apiServer = createServer(app);
  apiServer.listen(0, '127.0.0.1');
  await once(apiServer, 'listening');
  const address = apiServer.address() as AddressInfo;
  const token = jwt.sign({ id: targetUserId, email: `${suffix}-0@example.invalid`, tokenVersion: 0 }, secret);
  const apiStarted = performance.now();
  const apiResponse = await fetch(`http://127.0.0.1:${address.port}/api/dashboard`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const apiPayload = await apiResponse.text();
  const dashboardApiMs = Number((performance.now() - apiStarted).toFixed(3));
  assert.equal(apiResponse.status, 200, `dashboard API benchmark failed: ${apiPayload}`);
  const dashboardBody = JSON.parse(apiPayload) as { totalExchangeCount: number; totalExpenseCount: number; totalVnd: number; observedVnd: number; expenses: unknown[]; exchanges: unknown[] };
  assert.equal(dashboardBody.totalExchangeCount, EXCHANGES_PER_USER, 'real dashboard response counts full tenant history');
  assert.equal(dashboardBody.exchanges.length, 100, 'real dashboard response returns only bounded exchange history');
  assert.equal(dashboardBody.totalExpenseCount, EXPENSES_PER_USER, 'real dashboard response counts full tenant expense history');
  assert.equal(dashboardBody.totalVnd, EXPECTED_EXPENSE_VND, 'real dashboard response sums all and only this tenant\'s expenses');
  assert.equal(dashboardBody.observedVnd, EXPECTED_EXPENSE_VND, 'weighted card-purchase rate uses all eligible priced expenses');
  assert.equal(dashboardBody.expenses.length, EXPENSES_PER_USER, 'real dashboard response includes the chart expense window');
  const dashboardResponsePayloadBytes = Buffer.byteLength(apiPayload, 'utf8');

  // Small concurrency smoke benchmark catches connection-pool or tenant-scope
  // regressions that a single request cannot reveal.
  const concurrentRequestCount = 10;
  const concurrentApiTimings = await Promise.all(Array.from({ length: concurrentRequestCount }, async () => {
    const started = performance.now();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/dashboard`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const payload = await response.text();
    assert.equal(response.status, 200, `concurrent dashboard request failed: ${payload}`);
    const body = JSON.parse(payload) as { totalExchangeCount: number; totalExpenseCount: number; totalVnd: number; expenses: unknown[]; exchanges: unknown[] };
    assert.equal(body.totalExchangeCount, EXCHANGES_PER_USER, 'concurrent dashboard response keeps lifetime count scoped');
    assert.equal(body.exchanges.length, 100, 'concurrent dashboard response keeps history bounded');
    assert.equal(body.totalExpenseCount, EXPENSES_PER_USER, 'concurrent dashboard response keeps lifetime expense count scoped');
    assert.equal(body.totalVnd, EXPECTED_EXPENSE_VND, 'concurrent dashboard totals stay tenant-scoped');
    assert.equal(body.expenses.length, EXPENSES_PER_USER, 'concurrent dashboard response keeps the chart expense window');
    return Number((performance.now() - started).toFixed(3));
  }));
  const sortedConcurrentApiTimings = [...concurrentApiTimings].sort((a, b) => a - b);

  const runtimePlans = await prisma.$queryRaw<Array<{ 'QUERY PLAN': Array<Record<string, unknown>> }>>(
    Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${dashboardExchangeAggregateQuery(targetUserId)}`,
  );
  const runtimePlan = runtimePlans[0]?.['QUERY PLAN']?.[0];
  assert.ok(runtimePlan, 'PostgreSQL must return an EXPLAIN ANALYZE plan for the exact runtime aggregate');
  const runtimePlanText = JSON.stringify(runtimePlan);
  assert.match(runtimePlanText, /Execution Time/, 'runtime aggregate plan includes measured execution time');
  assert.match(runtimePlanText, /Plan/, 'runtime aggregate plan includes execution details');

  // Keep the index assertion on a representative selective user/time query;
  // the planner may correctly choose a sequential scan for a wider aggregate.
  const scopedPlans = await prisma.$queryRaw<Array<{ 'QUERY PLAN': Array<Record<string, unknown>> }>>`
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
    SELECT COALESCE(SUM("rubSpent"), 0)
    FROM "Exchange"
    WHERE "userId" = ${targetUserId}
  `;
  const scopedPlan = scopedPlans[0]?.['QUERY PLAN']?.[0];
  assert.ok(scopedPlan, 'PostgreSQL must return an EXPLAIN ANALYZE plan for the selective tenant query');
  assert.match(JSON.stringify(scopedPlan), /Exchange_userId_createdAt_idx/, 'selective tenant-scoped query should use the existing user/time index');

  console.log(JSON.stringify({
    benchmark: 'dashboard-exchange-aggregate',
    database: 'disposable CI PostgreSQL only',
    exchangeRows: EXCHANGES_PER_USER * TENANT_COUNT,
    expenseRows: EXPENSES_PER_USER * TENANT_COUNT,
    totalSeededRows: (EXCHANGES_PER_USER + EXPENSES_PER_USER) * TENANT_COUNT,
    tenantCount: TENANT_COUNT,
    exchangesPerTenant: EXCHANGES_PER_USER,
    expensesPerTenant: EXPENSES_PER_USER,
    aggregateHelperLatencyMs: timingsMs,
    aggregateLatencyMedianMs: [...timingsMs].sort((a, b) => a - b)[Math.floor(timingsMs.length / 2)],
    recentHistoryRows: history.length,
    recentHistoryQueryMs: historyQueryMs,
    recentHistoryPayloadBytes: historyPayloadBytes,
    dashboardApiLatencyMs: dashboardApiMs,
    dashboardApiResponsePayloadBytes: dashboardResponsePayloadBytes,
    dashboardApiReturnedExchanges: dashboardBody.exchanges.length,
    dashboardApiTotalExchangeCount: dashboardBody.totalExchangeCount,
    dashboardApiReturnedExpenses: dashboardBody.expenses.length,
    dashboardApiTotalExpenseCount: dashboardBody.totalExpenseCount,
    concurrentDashboardRequests: concurrentRequestCount,
    concurrentDashboardLatencyMs: concurrentApiTimings,
    concurrentDashboardLatencyP50Ms: sortedConcurrentApiTimings[Math.floor((sortedConcurrentApiTimings.length - 1) * 0.5)],
    concurrentDashboardLatencyP95Ms: sortedConcurrentApiTimings[Math.ceil((sortedConcurrentApiTimings.length - 1) * 0.95)],
    runtimeAggregateExplainAnalyze: runtimePlan,
    selectiveTenantExplainAnalyze: scopedPlan,
  }, null, 2));
} finally {
  if (apiServer?.listening) {
    await new Promise<void>((resolve, reject) => apiServer!.close(error => error ? reject(error) : resolve()));
  }
  if (users.length) await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.$disconnect();
}
