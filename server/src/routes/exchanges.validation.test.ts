import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { exchangeSchema } from './exchanges.js';
import { MAX_STORED_AMOUNT } from '../lib/amount-limits.js';

describe('exchange request validation', () => {
  it('accepts ordinary exchange inputs within the persisted amount limit', () => {
    assert.equal(exchangeSchema.safeParse({ rubSpent: 8300, usdtReceived: 93.7853 }).success, true);
    assert.equal(exchangeSchema.safeParse({ rubSpent: MAX_STORED_AMOUNT, usdtReceived: 1 }).success, true);
  });

  it('rejects positive exchange inputs below the persisted column precision', () => {
    assert.equal(exchangeSchema.safeParse({ rubSpent: 0.00001, usdtReceived: 1 }).success, false);
    assert.equal(exchangeSchema.safeParse({ rubSpent: 1, usdtReceived: 0.000000001 }).success, false);
    assert.equal(exchangeSchema.safeParse({ rubSpent: 1, usdtReceived: 1, vndPerUsdt: 0.00001 }).success, false);
    assert.equal(exchangeSchema.safeParse({ rubSpent: 1, usdtReceived: 1, vndFee: 0.00001 }).success, false);
  });

  it('rejects source values with excess fractional digits', () => {
    assert.equal(exchangeSchema.safeParse({ rubSpent: 1.23456, usdtReceived: 1 }).success, false);
    assert.equal(exchangeSchema.safeParse({ rubSpent: 1, usdtReceived: 1.123456789 }).success, false);
    assert.equal(exchangeSchema.safeParse({ mode: 'RUB_VND', rubSpent: 1, vndReceived: 100.00001 }).success, false);
  });

  it('rejects oversized amounts, rates, and fees before database writes', () => {
    assert.equal(exchangeSchema.safeParse({ rubSpent: MAX_STORED_AMOUNT + 1, usdtReceived: 1 }).success, false);
    assert.equal(exchangeSchema.safeParse({ rubSpent: 1, usdtReceived: MAX_STORED_AMOUNT + 1 }).success, false);
    assert.equal(exchangeSchema.safeParse({ rubSpent: 1, usdtReceived: 1, vndPerUsdt: MAX_STORED_AMOUNT + 1 }).success, false);
    assert.equal(exchangeSchema.safeParse({ rubSpent: 1, usdtReceived: 1, vndFee: MAX_STORED_AMOUNT + 1 }).success, false);
    assert.equal(exchangeSchema.safeParse({ mode: 'RUB_TARGET', rubSpent: 1, targetCurrency: 'USD', targetReceived: MAX_STORED_AMOUNT + 1, targetToVndRate: 1 }).success, false);
  });
});
