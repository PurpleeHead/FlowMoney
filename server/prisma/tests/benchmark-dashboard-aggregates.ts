import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { performance } from 'node:perf_hooks';
import { prisma } from '../../src/services/prisma.js';
import { explainDashboardExchangeAggregates, getDashboardExchangeAggregates } from '../../src/lib/dashboard-aggregates.js';

const databaseUrl = process.env.DATABASE_URL;
if (process.env.FLOWMONEY_BENCHMARK_DATABASE !== 'disposable') {
  throw new Error('Refusing to write benchmark fixtures: set FLOWMONEY_BENCHMARK_DATABASE=disposable explicitly.');
}
if (!databaseUrl) throw new Error('DATABASE_URL is required.');
const parsed = new URL(databaseUrl);
const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
assert.ok(
  ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname) &&
    /test|bench|disposable/i.test(databaseName),
  'Refusing to seed data unless DATABASE_URL points to a local test/benchmark database.',
);

const suffix = `dashboard-benchmark-${Date.now()}`;
const userIds: string[] = [];
const requestedSampleSize = Number(process.env.DASHBOARD_BENCHMARK_ROWS ?? 10000);
assert.ok(Number.isInteger(requestedSampleSize) && requestedSampleSize >= 1000 && requestedSampleSize <= 50000,
  'DASHBOARD_BENCHMARK_ROWS must be an integer between 1000 and 50000.');
const sampleSize = requestedSampleSize;
const rounds = 7;

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

async function measure<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await run();
  return { value, ms: performance.now() - start };
}

try {
  // Keep the benchmark user's history at the requested size while adding unrelated
  // users so PostgreSQL can choose a realistic user-scoped access path.
  const benchmarkUsers = 5;
  for (let index = 0; index < benchmarkUsers; index++) {
    const user = await prisma.user.create({
      data: { email: `${suffix}-${index}@example.invalid`, passwordHash: 'benchmark-only' },
    });
    userIds.push(user.id);
  }
  const benchmarkUserId = userIds[0];

  const batchSize = 1000;
  for (let userIndex = 0; userIndex < userIds.length; userIndex++) {
    for (let offset = 0; offset < sampleSize; offset += batchSize) {
      const data = Array.from({ length: Math.min(batchSize, sampleSize - offset) }, (_, index) => {
      const n = offset + index;
      const mode = n % 5 === 0 ? 'RUB_VND' : n % 5 === 1 ? 'RUB_TARGET' : 'RUB_USDT_VND';
      const rubSpent = 100 + (n % 5000);
      const usdtReceived = mode === 'RUB_VND' ? null : 1 + (n % 100) / 10;
      const vndReceived = n % 7 === 0 ? null : 10000 + (n % 100000);
      return {
        userId: userIds[userIndex],
        mode,
        targetCurrency: mode === 'RUB_TARGET' ? (n % 2 ? 'VND' : 'USDT') : 'VND',
        rubSpent,
        usdtReceived,
        targetReceived: mode === 'RUB_TARGET' ? (n % 2 ? 50000 + (n % 20000) : usdtReceived) : null,
        targetVndEquivalent: mode === 'RUB_TARGET' && n % 2 ? 50000 + (n % 20000) : null,
        vndReceived: mode === 'RUB_TARGET' && n % 2 ? null : vndReceived,
        planningVndPerUsdt: vndReceived == null && usdtReceived != null ? 25000 : null,
      };
      });
      await prisma.exchange.createMany({ data });
    }
  }

  const exchangeActivitySelect = {
    id: true, mode: true, targetCurrency: true, targetReceived: true, targetToVndRate: true,
    targetVndEquivalent: true, rubSpent: true, usdtReceived: true, vndPerUsdt: true,
    planningVndPerUsdt: true, vndReceived: true, effectiveVndPerRub: true,
    effectiveRubPerUsdt: true, createdAt: true,
  } as const;
  const fullActivityPayload = async () => prisma.exchange.findMany({
    where: { userId: benchmarkUserId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: exchangeActivitySelect,
  });
  const boundedActivityPayload = async () => prisma.exchange.findMany({
    where: { userId: benchmarkUserId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 100,
    select: exchangeActivitySelect,
  });
  const toDashboardExchangePayload = (rows: Array<Record<string, unknown>>) => rows.map(row => {
    const numberOrNull = (value: unknown) => value == null ? null : Number(value);
    return {
      ...row,
      rubSpent: Number(row.rubSpent),
      usdtReceived: numberOrNull(row.usdtReceived),
      vndPerUsdt: numberOrNull(row.vndPerUsdt),
      planningVndPerUsdt: numberOrNull(row.planningVndPerUsdt),
      vndReceived: numberOrNull(row.vndReceived),
      targetReceived: numberOrNull(row.targetReceived),
      targetToVndRate: numberOrNull(row.targetToVndRate),
      targetVndEquivalent: numberOrNull(row.targetVndEquivalent),
      effectiveVndPerRub: numberOrNull(row.effectiveVndPerRub),
      effectiveRubPerUsdt: numberOrNull(row.effectiveRubPerUsdt),
    };
  });
  const explainBoundedActivity = async () => {
    const [row] = await prisma.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(Prisma.sql`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT "id", "mode", "targetCurrency", "targetReceived", "targetToVndRate",
        "targetVndEquivalent", "rubSpent", "usdtReceived", "vndPerUsdt",
        "planningVndPerUsdt", "vndReceived", "effectiveVndPerRub",
        "effectiveRubPerUsdt", "createdAt"
      FROM "Exchange"
      WHERE "userId" = ${benchmarkUserId}
      ORDER BY "createdAt" DESC, "id" DESC
      LIMIT 100
    `);
    return row?.['QUERY PLAN'] ?? null;
  };

  const fullHistory = async () => {
    const rows = await prisma.exchange.findMany({
      where: { userId: benchmarkUserId },
      select: {
        mode: true,
        targetCurrency: true,
        rubSpent: true,
        usdtReceived: true,
        targetReceived: true,
        targetVndEquivalent: true,
        vndReceived: true,
        planningVndPerUsdt: true,
      },
    });
    // Force equivalent Node-side aggregation work rather than measuring fetch time alone.
    return rows.reduce((acc, row) => {
      const target = row.targetCurrency.trim().toUpperCase();
      const rub = Number(row.rubSpent);
      const usdt = row.usdtReceived == null ? null : Number(row.usdtReceived);
      const targetReceived = row.targetReceived == null ? null : Number(row.targetReceived);
      const targetVnd = row.targetVndEquivalent == null ? null : Number(row.targetVndEquivalent);
      const vnd = row.vndReceived == null ? null : Number(row.vndReceived);
      acc.count++;

      if (row.mode === 'RUB_USDT_VND' && rub > 0 && usdt != null && usdt > 0) {
        acc.rubUsdtRub += rub;
        acc.rubUsdtUsdt += usdt;
      } else if (row.mode === 'RUB_TARGET' && target === 'USDT' && rub > 0 && targetReceived != null && targetReceived > 0) {
        acc.rubUsdtRub += rub;
        acc.rubUsdtUsdt += targetReceived;
      }

      if (row.mode === 'RUB_USDT_VND' && rub > 0 && usdt != null && usdt > 0 && vnd != null && vnd > 0) {
        acc.actualVnd += vnd;
        acc.actualUsdt += usdt;
      }
      if (row.mode === 'RUB_USDT_VND' && rub > 0 &&
          vnd == null && usdt != null && usdt > 0 &&
          row.planningVndPerUsdt != null && Number(row.planningVndPerUsdt) > 0) {
        acc.plannedWeightedVnd += usdt * Number(row.planningVndPerUsdt);
        acc.plannedUsdt += usdt;
      }

      if (row.mode === 'RUB_TARGET' && target === 'VND') {
        acc.confirmedVnd += targetVnd ?? targetReceived ?? vnd ?? 0;
      } else if (row.mode === 'RUB_VND' || row.mode === 'RUB_USDT_VND') {
        acc.confirmedVnd += vnd ?? 0;
      }
      if (row.mode === 'RUB_TARGET' && target !== 'VND' && target !== 'RUB' && targetVnd != null) {
        acc.estimatedTargetVnd += targetVnd;
      }
      if ((row.mode === 'RUB_TARGET' && target === 'USDT' && rub > 0 && targetReceived != null && targetReceived > 0 && targetVnd == null) ||
          (row.mode === 'RUB_USDT_VND' && rub > 0 && vnd == null && usdt != null && usdt > 0)) {
        acc.estimatedUsdt += row.mode === 'RUB_TARGET' && target === 'USDT' ? targetReceived ?? 0 : usdt ?? 0;
      }
      return acc;
    }, { count: 0, rubUsdtRub: 0, rubUsdtUsdt: 0, actualVnd: 0, actualUsdt: 0, confirmedVnd: 0, estimatedTargetVnd: 0, estimatedUsdt: 0, plannedWeightedVnd: 0, plannedUsdt: 0 });
  };

  // Refresh planner statistics after bulk fixture insertion; this runs only on the guarded disposable database.
  await prisma.$executeRaw`ANALYZE "Exchange"`;
  const queryPlan = await explainDashboardExchangeAggregates(benchmarkUserId);
  const boundedActivityQueryPlan = await explainBoundedActivity();
  const sqlResult = await getDashboardExchangeAggregates(benchmarkUserId);
  const [fullActivityRows, boundedActivityRows] = await Promise.all([
    fullActivityPayload(), boundedActivityPayload(),
  ]);
  const fullActivityBytes = Buffer.byteLength(JSON.stringify(toDashboardExchangePayload(fullActivityRows)));
  const boundedActivityBytes = Buffer.byteLength(JSON.stringify(toDashboardExchangePayload(boundedActivityRows)));
  assert.equal(boundedActivityRows.length, Math.min(sampleSize, 100),
    'bounded activity must return at most 100 newest rows');
  assert.ok(boundedActivityBytes <= fullActivityBytes,
    'bounded exchange payload must not exceed the full-history exchange payload');
  const boundedActivitySamples: number[] = [];
  const fullActivitySamples: number[] = [];
  for (let i = 0; i < rounds + 2; i++) {
    const bounded = await measure(boundedActivityPayload);
    const full = await measure(fullActivityPayload);
    if (i >= 2) {
      boundedActivitySamples.push(bounded.ms);
      fullActivitySamples.push(full.ms);
    }
  }
  const jsResult = await fullHistory();
  assert.equal(sqlResult.exchangeCount, jsResult.count, 'SQL and Node benchmark must read the same number of rows');
  for (const key of ['rubUsdtRub', 'rubUsdtUsdt', 'actualVnd', 'actualUsdt', 'confirmedVnd', 'estimatedTargetVnd', 'estimatedUsdt', 'plannedWeightedVnd', 'plannedUsdt'] as const) {
    assert.ok(Math.abs(sqlResult[key] - jsResult[key]) < 0.01, `benchmark fixture SQL/Node mismatch for ${key}: ${sqlResult[key]} vs ${jsResult[key]}`);
  }

  const sqlSamples: number[] = [];
  const nodeSamples: number[] = [];
  for (let i = 0; i < rounds + 2; i++) {
    const sql = await measure(() => getDashboardExchangeAggregates(benchmarkUserId));
    const node = await measure(fullHistory);
    if (i >= 2) {
      sqlSamples.push(sql.ms);
      nodeSamples.push(node.ms);
    }
  }

  const report = {
    benchmark: 'dashboard-exchange-aggregates',
    database: databaseName,
    fixtureRows: sampleSize * userIds.length,
    benchmarkUserRows: sampleSize,
    fixtureUsers: userIds.length,
    measuredRounds: rounds,
    queryPlan,
    queryPlanNote: 'EXPLAIN ANALYZE BUFFERS covers the exact multi-bucket dashboard aggregate SQL statement.',
    boundedActivityQueryPlan,
    boundedActivityQueryPlanNote: 'EXPLAIN ANALYZE BUFFERS covers the exact latest-100 activity query used by GET /api/dashboard.',
    exchangeActivityPayloadBytes: {
      boundedLatest100: boundedActivityBytes,
      fullHistoryBaseline: fullActivityBytes,
      reductionPercent: fullActivityBytes > 0
        ? Number(((1 - boundedActivityBytes / fullActivityBytes) * 100).toFixed(2))
        : 0,
    },
    activityQueryTimingsMs: {
      boundedLatest100: { median: Number(percentile(boundedActivitySamples, 0.5).toFixed(2)), p95: Number(percentile(boundedActivitySamples, 0.95).toFixed(2)) },
      fullHistoryBaseline: { median: Number(percentile(fullActivitySamples, 0.5).toFixed(2)), p95: Number(percentile(fullActivitySamples, 0.95).toFixed(2)) },
    },
    timingsMs: {
      postgresAggregate: { median: Number(percentile(sqlSamples, 0.5).toFixed(2)), p95: Number(percentile(sqlSamples, 0.95).toFixed(2)), samples: sqlSamples.map(x => Number(x.toFixed(2))) },
      fetchAndAggregateInNode: { median: Number(percentile(nodeSamples, 0.5).toFixed(2)), p95: Number(percentile(nodeSamples, 0.95).toFixed(2)), samples: nodeSamples.map(x => Number(x.toFixed(2))) },
    },
    note: 'Disposable local database only. Compare timings on the same host and database; this microbenchmark is directional, not a production latency guarantee.',
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const userId of userIds) {
    await prisma.user.delete({ where: { id: userId } }).catch((error) => {
      console.error('Benchmark cleanup failed; remove the disposable user manually:', userId, error);
      process.exitCode = 1;
    });
  }
  await prisma.$disconnect();
}
