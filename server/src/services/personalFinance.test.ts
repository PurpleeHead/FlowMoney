import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateActualBalance, calculateCoverage, calculateForecastBalance, generateOccurrences } from './personalFinance.js';

const date = (value: string) => new Date(`${value}T00:00:00.000Z`);
const keys = (values: Date[]) => values.map(value => value.toISOString().slice(0, 10));

test('daily recurrence includes both boundaries', () => {
  assert.deepEqual(keys(generateOccurrences('DAILY', {}, date('2026-11-06'), date('2026-11-08'))), ['2026-11-06', '2026-11-07', '2026-11-08']);
});

test('twice monthly clamps dates to month end and removes duplicates', () => {
  assert.deepEqual(keys(generateOccurrences('TWICE_MONTHLY', { firstDay: 15, secondDay: 31 }, date('2026-02-01'), date('2026-02-28'))), ['2026-02-15', '2026-02-28']);
});

test('twice monthly rejects identical configured days', () => {
  assert.throws(() => generateOccurrences('TWICE_MONTHLY', { firstDay: 10, secondDay: 10 }, date('2026-11-01'), date('2026-11-30')), /different/);
});

test('yearly recurrence handles leap day by clamping in non-leap years', () => {
  assert.deepEqual(keys(generateOccurrences('YEARLY', { month: 2, day: 29 }, date('2025-01-01'), date('2028-12-31'))), ['2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29']);
});

test('actual balance excludes planned income', () => {
  assert.equal(calculateActualBalance(1000, 5000, 2000), 4000);
});

test('forecast adds planned income and subtracts unpaid obligations', () => {
  assert.equal(calculateForecastBalance(4000, 5000, 3000), 6000);
});

test('coverage reports shortfall and surplus', () => {
  assert.deepEqual(calculateCoverage(5000, 10000), { covered: false, difference: -5000, shortfall: 5000, surplus: 0 });
  assert.deepEqual(calculateCoverage(12000, 10000), { covered: true, difference: 2000, shortfall: 0, surplus: 2000 });
});
