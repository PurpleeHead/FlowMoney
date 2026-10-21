import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { prisma } from '../../src/services/prisma.js';
import { explainDateAwareValuationAggregate, getDateAwareValuationAggregate } from '../../src/lib/date-aware-valuation-aggregates.js';
import {
  mapActualVndExchanges,
  mapActualVndUsdtExchanges,
  mapDirectVndExchanges,
  mapRubUsdtExchanges,
} from '../../src/lib/money.js';

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

const suffix = `date-aware-benchmark-${Date.now()}`;
const userIds: string[] = [];
const sampleSize = Number(process.env.DATE_AWARE_BENCHMARK_ROWS ?? 10000);
assert.ok(Number.isInteger(sampleSize) && sampleSize >= 1000 && sampleSize <= 50000,
  'DATE_AWARE_BENCHMARK_ROWS must be an integer between 1000 and 50000.');
const valuationDate = new Date('2026-10-15T00:00:00.000Z');
const rounds = 5;

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

async function measure<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await run();
  return { value, ms: performance.now() - start };
}

function finitePositive(value: unknown): number | null {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

async function calculateNodeReference(userId: string) {
  const [exchanges, expenses] = await Promise.all([
    prisma.exchange.findMany({
      where: { userId, createdAt: { lte: valuationDate } },
      select: {
        mode: true, rubSpent: true, usdtReceived: true, vndReceived: true,
        targetCurrency: true, targetReceived: true, targetVndEquivalent: true,
      },
    }),
    prisma.expense.findMany({
      where: { userId, date: { lte: valuationDate } },
      select: { id: true, currency: true, amountVnd: true, usdtCharged: true },
    }),
  ]);
  const mapped = exchanges.map(row => ({
    mode: row.mode,
    rubSpent: Number(row.rubSpent),
    usdtReceived: row.usdtReceived == null ? null : Number(row.usdtReceived),
    vndReceived: row.vndReceived == null ? null : Number(row.vndReceived),
    targetCurrency: row.targetCurrency,
    targetReceived: row.targetReceived == null ? null : Number(row.targetReceived),
    targetVndEquivalent: row.targetVndEquivalent == null ? null : Number(row.targetVndEquivalent),
  }));
  const rubUsdt = mapRubUsdtExchanges(mapped);
  const actual = mapActualVndUsdtExchanges(mapped);
  const direct = mapDirectVndExchanges(mapped).filter(row =>
    Number.isFinite(row.rubSpent) && row.rubSpent > 0 &&
    Number.isFinite(row.vndReceived) && row.vndReceived > 0);
  const indirect = mapActualVndExchanges(mapped);
  const cards = expenses.filter(row => row.currency.trim().toUpperCase() === 'VND')
    .map(row => ({
      amountVnd: finitePositive(row.amountVnd),
      usdtCharged: finitePositive(row.usdtCharged),
    }))
    .filter(row => row.amountVnd != null && row.usdtCharged != null);

  return {
    rubUsdtRub: rubUsdt.reduce((sum, row) => sum + row.rubSpent, 0),
    rubUsdtUsdt: rubUsdt.reduce((sum, row) => sum + row.usdtReceived, 0),
    actualVnd: actual.reduce((sum, row) => sum + row.vndReceived, 0),
    actualUsdt: actual.reduce((sum, row) => sum + row.usdtReceived, 0),
    directRub: direct.reduce((sum, row) => sum + row.rubSpent, 0),
    directVnd: direct.reduce((sum, row) => sum + row.vndReceived, 0),
    actualRubForVnd: indirect.reduce((sum, row) => sum + row.rubSpent, 0),
    actualVndForRub: indirect.reduce((sum, row) => sum + row.vndReceived, 0),
    cardVnd: cards.reduce((sum, row) => sum + row.amountVnd!, 0),
    cardUsdt: cards.reduce((sum, row) => sum + row.usdtCharged!, 0),
  };
}

try {
  for (let index = 0; index < 3; index++) {
    const user = await prisma.user.create({
      data: { email: `${suffix}-${index}@example.invalid`, passwordHash: 'benchmark-only' },
    });
    userIds.push(user.id);
  }

  const batchSize = 1000;
  for (const userId of userIds) {
    for (let offset = 0; offset < sampleSize; offset += batchSize) {
      const count = Math.min(batchSize, sampleSize - offset);
      const exchanges = Array.from({ length: count }, (_, index) => {
        const n = offset + index;
        const mode = n % 6 === 0 || n % 6 === 1 ? 'RUB_USDT_VND'
          : n % 6 === 2 ? 'RUB_VND' : 'RUB_TARGET';
        const targetCurrency = mode !== 'RUB_TARGET' ? 'VND'
          : n % 6 === 3 ? 'VND' : n % 6 === 4 ? 'USDT' : 'EUR';
        const usdtReceived = mode === 'RUB_VND' ? null : 1 + (n % 100) / 10;
        const vndReceived = mode === 'RUB_VND' ? 10000 + (n % 100000)
          : mode === 'RUB_USDT_VND' && n % 6 === 0 ? 10000 + (n % 100000)
          : null;
        const targetReceived = mode !== 'RUB_TARGET' ? null
          : targetCurrency === 'USDT' ? usdtReceived
          : 50000 + (n % 20000);
        return {
          userId, mode, targetCurrency,
          rubSpent: 100 + (n % 5000),
          usdtReceived: mode === 'RUB_USDT_VND' ? usdtReceived : null,
          targetReceived,
          targetVndEquivalent: mode === 'RUB_TARGET' && targetCurrency !== 'USDT'
            ? 50000 + (n % 20000) : null,
          vndReceived,
          planningVndPerUsdt: mode === 'RUB_USDT_VND' && vndReceived == null ? 25000 : null,
          createdAt: new Date(valuationDate.getTime() - ((n % 20) + 1) * 86400000),
        };
      });
      const expenses = Array.from({ length: count }, (_, index) => {
        const n = offset + index;
        const currency = n % 10 === 0 ? 'RUB' : 'VND';
        return {
          userId,
          title: `Benchmark expense ${n}`,
          category: 'Benchmark',
          amount: 100 + (n % 10000),
          currency,
          amountVnd: 10000 + (n % 100000),
          amountRub: currency === 'RUB' ? 100 + (n % 10000) : null,
          usdtCharged: n % 11 === 0 ? null : 0.1 + (n % 100) / 100,
          date: new Date(valuationDate.getTime() - ((n % 20) + 1) * 86400000),
        };
      });
      await prisma.exchange.createMany({ data: exchanges });
      await prisma.expense.createMany({ data: expenses });
    }
  }

  await prisma.$executeRaw`ANALYZE "Exchange"`;
  await prisma.$executeRaw`ANALYZE "Expense"`;
  const benchmarkUserId = userIds[0];
  const queryPlan = await explainDateAwareValuationAggregate(benchmarkUserId, valuationDate);
  const sqlResult = await getDateAwareValuationAggregate(benchmarkUserId, valuationDate);
  const nodeResult = await calculateNodeReference(benchmarkUserId);
  for (const key of Object.keys(nodeResult) as Array<keyof typeof nodeResult>) {
    assert.ok(Math.abs(Number(sqlResult[key]) - nodeResult[key]) < 0.01,
      `date-aware SQL/Node mismatch for ${key}: ${String(sqlResult[key])} vs ${nodeResult[key]}`);
  }

  const sqlSamples: number[] = [];
  const nodeSamples: number[] = [];
  for (let i = 0; i < rounds + 2; i++) {
    const sql = await measure(() => getDateAwareValuationAggregate(benchmarkUserId, valuationDate));
    const node = await measure(() => calculateNodeReference(benchmarkUserId));
    if (i >= 2) {
      sqlSamples.push(sql.ms);
      nodeSamples.push(node.ms);
    }
  }

  console.log(JSON.stringify({
    benchmark: 'date-aware-valuation-aggregates',
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
    fixtureRowsPerTablePerUser: sampleSize,
    fixtureUsers: userIds.length,
    measuredRounds: rounds,
    queryPlan,
    queryPlanNote: 'EXPLAIN (ANALYZE, BUFFERS) covers the exact date-aware aggregate statement on disposable PostgreSQL.',
    timingsMs: {
      postgresAggregate: { median: Number(percentile(sqlSamples, 0.5).toFixed(2)), p95: Number(percentile(sqlSamples, 0.95).toFixed(2)), samples: sqlSamples.map(x => Number(x.toFixed(2))) },
      fetchAndAggregateInNode: { median: Number(percentile(nodeSamples, 0.5).toFixed(2)), p95: Number(percentile(nodeSamples, 0.95).toFixed(2)), samples: nodeSamples.map(x => Number(x.toFixed(2))) },
    },
    note: 'Disposable local PostgreSQL only. Timings compare the same user-scoped, date-bounded data; they are directional microbenchmark evidence, not production latency guarantees.',
  }, null, 2));
} finally {
  for (const userId of userIds) {
    await prisma.user.delete({ where: { id: userId } }).catch(error => {
      console.error('Benchmark cleanup failed; remove the disposable user manually:', userId, error);
      process.exitCode = 1;
    });
  }
  await prisma.$disconnect();
}
