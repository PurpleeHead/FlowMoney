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
const sampleSize = Math.max(1000, Math.min(50000, Number(process.env.DASHBOARD_BENCHMARK_ROWS ?? 10000)));
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
      acc.count++;
      if (Number(row.rubSpent) > 0 && row.usdtReceived != null && Number(row.usdtReceived) > 0) {
        acc.rub += Number(row.rubSpent);
        acc.usdt += Number(row.usdtReceived);
      }
      if (row.mode === 'RUB_TARGET' && row.targetCurrency.trim().toUpperCase() === 'VND') {
        acc.confirmedVnd += Number(row.targetVndEquivalent ?? row.targetReceived ?? row.vndReceived ?? 0);
      } else {
        acc.confirmedVnd += Number(row.vndReceived ?? 0);
      }
      if (row.usdtReceived != null && row.planningVndPerUsdt != null && row.vndReceived == null) {
        acc.plannedWeightedVnd += Number(row.usdtReceived) * Number(row.planningVndPerUsdt);
        acc.plannedUsdt += Number(row.usdtReceived);
      }
      return acc;
    }, { count: 0, rub: 0, usdt: 0, confirmedVnd: 0, plannedWeightedVnd: 0, plannedUsdt: 0 });
  };

  const sqlResult = await getDashboardExchangeAggregates(user.id);
  const jsResult = await fullHistory();
  assert.equal(sqlResult.exchangeCount, jsResult.count, 'SQL and Node benchmark must read the same number of rows');

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
