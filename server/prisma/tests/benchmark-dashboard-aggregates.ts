import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { prisma } from '../../src/services/prisma.js';
import { getDashboardExchangeAggregates } from '../../src/lib/dashboard-aggregates.js';

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
let userId: string | undefined;
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
  const user = await prisma.user.create({
    data: { email: `${suffix}@example.invalid`, passwordHash: 'benchmark-only' },
  });
  userId = user.id;

  const batchSize = 1000;
  for (let offset = 0; offset < sampleSize; offset += batchSize) {
    const data = Array.from({ length: Math.min(batchSize, sampleSize - offset) }, (_, index) => {
      const n = offset + index;
      const mode = n % 5 === 0 ? 'RUB_VND' : n % 5 === 1 ? 'RUB_TARGET' : 'RUB_USDT_VND';
      const rubSpent = 100 + (n % 5000);
      const usdtReceived = mode === 'RUB_VND' ? null : 1 + (n % 100) / 10;
      const vndReceived = n % 7 === 0 ? null : 10000 + (n % 100000);
      return {
        userId: user!.id,
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

  const fullHistory = async () => {
    const rows = await prisma.exchange.findMany({
      where: { userId: user!.id },
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

      if (row.mode === 'RUB_USDT_VND' && usdt != null && usdt > 0 && vnd != null && vnd > 0) {
        acc.actualVnd += vnd;
        acc.actualUsdt += usdt;
      }
      if (row.mode !== 'RUB_VND' && !(row.mode === 'RUB_TARGET' && target === 'VND') &&
          vnd == null && usdt != null && row.planningVndPerUsdt != null) {
        acc.plannedWeightedVnd += usdt * Number(row.planningVndPerUsdt);
        acc.plannedUsdt += usdt;
      }

      if (row.mode === 'RUB_TARGET' && target === 'VND') {
        acc.confirmedVnd += targetVnd ?? targetReceived ?? vnd ?? 0;
      } else {
        acc.confirmedVnd += vnd ?? 0;
      }
      if (row.mode === 'RUB_TARGET' && target !== 'VND' && targetVnd != null) {
        acc.estimatedTargetVnd += targetVnd;
      }
      if (row.mode !== 'RUB_VND' && !(row.mode === 'RUB_TARGET' && target === 'VND') &&
          vnd == null && (
            (row.mode === 'RUB_TARGET' && target === 'USDT' && targetReceived != null && targetVnd == null) ||
            usdt != null
          )) {
        acc.estimatedUsdt += row.mode === 'RUB_TARGET' && target === 'USDT' ? targetReceived ?? 0 : usdt ?? 0;
      }
      return acc;
    }, { count: 0, rubUsdtRub: 0, rubUsdtUsdt: 0, actualVnd: 0, actualUsdt: 0, confirmedVnd: 0, estimatedTargetVnd: 0, estimatedUsdt: 0, plannedWeightedVnd: 0, plannedUsdt: 0 });
  };

  const sqlResult = await getDashboardExchangeAggregates(user.id);
  const jsResult = await fullHistory();
  assert.equal(sqlResult.exchangeCount, jsResult.count, 'SQL and Node benchmark must read the same number of rows');
  for (const key of ['rubUsdtRub', 'rubUsdtUsdt', 'actualVnd', 'actualUsdt', 'confirmedVnd', 'estimatedTargetVnd', 'estimatedUsdt', 'plannedWeightedVnd', 'plannedUsdt'] as const) {
    assert.ok(Math.abs(sqlResult[key] - jsResult[key]) < 0.01, `benchmark fixture SQL/Node mismatch for ${key}: ${sqlResult[key]} vs ${jsResult[key]}`);
  }

  const sqlSamples: number[] = [];
  const nodeSamples: number[] = [];
  for (let i = 0; i < rounds + 2; i++) {
    const sql = await measure(() => getDashboardExchangeAggregates(user!.id));
    const node = await measure(fullHistory);
    if (i >= 2) {
      sqlSamples.push(sql.ms);
      nodeSamples.push(node.ms);
    }
  }

  const report = {
    benchmark: 'dashboard-exchange-aggregates',
    database: databaseName,
    fixtureRows: sampleSize,
    measuredRounds: rounds,
    timingsMs: {
      postgresAggregate: { median: Number(percentile(sqlSamples, 0.5).toFixed(2)), p95: Number(percentile(sqlSamples, 0.95).toFixed(2)), samples: sqlSamples.map(x => Number(x.toFixed(2))) },
      fetchAndAggregateInNode: { median: Number(percentile(nodeSamples, 0.5).toFixed(2)), p95: Number(percentile(nodeSamples, 0.95).toFixed(2)), samples: nodeSamples.map(x => Number(x.toFixed(2))) },
    },
    note: 'Disposable local database only. Compare timings on the same host and database; this microbenchmark is directional, not a production latency guarantee.',
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (userId) {
    await prisma.user.delete({ where: { id: userId } }).catch((error) => {
      console.error('Benchmark cleanup failed; remove the disposable user manually:', userId, error);
      process.exitCode = 1;
    });
  }
  await prisma.$disconnect();
}
