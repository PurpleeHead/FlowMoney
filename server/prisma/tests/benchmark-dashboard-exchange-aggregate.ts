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
const TENANT_COUNT = 10;

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
  }

  await prisma.$executeRaw`ANALYZE "Exchange"`;
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
  const dashboardBody = JSON.parse(apiPayload) as { totalExchangeCount: number; exchanges: unknown[] };
  assert.equal(dashboardBody.totalExchangeCount, EXCHANGES_PER_USER, 'real dashboard response counts full tenant history');
  assert.equal(dashboardBody.exchanges.length, 100, 'real dashboard response returns only bounded exchange history');
  const dashboardResponsePayloadBytes = Buffer.byteLength(apiPayload, 'utf8');

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
    tenantCount: TENANT_COUNT,
    rowsPerTenant: EXCHANGES_PER_USER,
    aggregateHelperLatencyMs: timingsMs,
    aggregateLatencyMedianMs: [...timingsMs].sort((a, b) => a - b)[Math.floor(timingsMs.length / 2)],
    recentHistoryRows: history.length,
    recentHistoryQueryMs: historyQueryMs,
    recentHistoryPayloadBytes: historyPayloadBytes,
    dashboardApiLatencyMs: dashboardApiMs,
    dashboardApiResponsePayloadBytes: dashboardResponsePayloadBytes,
    dashboardApiReturnedExchanges: dashboardBody.exchanges.length,
    dashboardApiTotalExchangeCount: dashboardBody.totalExchangeCount,
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
