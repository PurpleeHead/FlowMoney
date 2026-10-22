import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { prisma } from '../../src/services/prisma.js';
import { aggregateDashboardExchanges } from '../../src/lib/dashboard-exchange-aggregate.js';

const suffix = `dashboard-aggregate-benchmark-${Date.now()}`;
const users: string[] = [];
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

  const plans = await prisma.$queryRaw<Array<{ 'QUERY PLAN': Array<Record<string, unknown>> }>>`
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
    SELECT COALESCE(SUM("rubSpent"), 0)
    FROM "Exchange"
    WHERE "userId" = ${targetUserId}
  `;
  const plan = plans[0]?.['QUERY PLAN']?.[0];
  assert.ok(plan, 'PostgreSQL must return an EXPLAIN ANALYZE plan');
  const planText = JSON.stringify(plan);
  assert.match(planText, /Execution Time/, 'query plan includes measured execution time');
  assert.match(planText, /Plan/, 'query plan includes execution details');

  console.log(JSON.stringify({
    benchmark: 'dashboard-exchange-aggregate',
    database: 'disposable CI PostgreSQL only',
    exchangeRows: EXCHANGES_PER_USER * TENANT_COUNT,
    tenantCount: TENANT_COUNT,
    rowsPerTenant: EXCHANGES_PER_USER,
    aggregateHelperLatencyMs: timingsMs,
    aggregateLatencyMedianMs: [...timingsMs].sort((a, b) => a - b)[Math.floor(timingsMs.length / 2)],
    tenantScopedExplainAnalyze: plan,
  }, null, 2));
} finally {
  if (users.length) await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.$disconnect();
}
