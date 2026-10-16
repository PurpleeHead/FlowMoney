import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateExpenseRub,
  calculateObservedVndPerUsdt,
  calculateRubPerUsdt,
  estimateRubFromVnd,
  resolveExchangeVndOutcome,
} from './lib/money.js';

test('RUB/USDT uses a weighted effective rate from actual top-ups', () => {
  assert.equal(calculateRubPerUsdt([
    { rubSpent: 10_000, usdtReceived: 100 },
    { rubSpent: 4_500, usdtReceived: 50 },
  ]), 96.66666666666667);
});

test('VND/USDT uses total actual VND and card USDT debits', () => {
  assert.equal(calculateObservedVndPerUsdt([
    { amountVnd: 79_000, usdtCharged: 3 },
    { amountVnd: 40_000, usdtCharged: 1.5 },
  ]), 26_444.444444444445);
});

test('known card debit determines RUB cost when the RUB/USDT cost basis is known', () => {
  assert.equal(calculateExpenseRub({
    currency: 'VND',
    amount: 79_000,
    amountVnd: 79_000,
    usdtCharged: 3,
  }, 10_000 / 113, 26_333, 2_600), 3 * (10_000 / 113));
});

test('known card debit does not fall back to a forecast when RUB/USDT cost basis is unknown', () => {
  assert.equal(calculateExpenseRub({
    currency: 'VND',
    amount: 79_000,
    amountVnd: 79_000,
    usdtCharged: 3,
  }, null, 26_333, 2_600), null);
});

test('currency codes are normalized before calculating RUB cost', () => {
  assert.equal(calculateExpenseRub({
    currency: 'rub',
    amount: 125,
    amountVnd: 3_000_000,
  }, null, null), 125);
});

test('forecast conversion returns null when a required rate is unavailable', () => {
  assert.equal(estimateRubFromVnd(79_000, null, 88), null);
});

test('exchange outcome never invents actual VND when it is unknown', () => {
  assert.deepEqual(resolveExchangeVndOutcome({ usdtReceived: 113 }), {
    vndReceived: null,
    vndPerUsdt: null,
  });
});

test('exchange outcome derives the observed rate from actual received amounts', () => {
  assert.deepEqual(resolveExchangeVndOutcome({ usdtReceived: 113, vndReceived: 2_800_000 }), {
    vndReceived: 2_800_000,
    vndPerUsdt: 2_800_000 / 113,
  });
});

test('exchange outcome rejects a rate without an actual VND amount', () => {
  assert.throws(
    () => resolveExchangeVndOutcome({ usdtReceived: 113, vndPerUsdt: 25_000 }),
    /Actual VND received is required/,
  );
});
