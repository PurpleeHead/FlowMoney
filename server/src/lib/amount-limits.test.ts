import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { areRepresentableDecimals, areSupportedStoredAmounts, isRepresentableDecimal, isSupportedStoredAmount, MAX_STORED_AMOUNT } from './amount-limits.js';

describe('persisted amount limits', () => {
  it('accepts null optional values and finite values within the supported bound', () => {
    assert.equal(isSupportedStoredAmount(null), true);
    assert.equal(isSupportedStoredAmount(undefined), true);
    assert.equal(isSupportedStoredAmount(0), true);
    assert.equal(isSupportedStoredAmount(MAX_STORED_AMOUNT), true);
    assert.equal(areSupportedStoredAmounts([100, null, -250]), true);
  });

  it('rejects non-finite values and values beyond the supported bound', () => {
    assert.equal(isSupportedStoredAmount(Number.NaN), false);
    assert.equal(isSupportedStoredAmount(Number.POSITIVE_INFINITY), false);
    assert.equal(isSupportedStoredAmount(MAX_STORED_AMOUNT + 0.01), false);
    assert.equal(isSupportedStoredAmount(-MAX_STORED_AMOUNT - 1), false);
    assert.equal(areSupportedStoredAmounts([100, Number.POSITIVE_INFINITY]), false);
  });
  
  it('rejects non-zero values below a column scale and permits zero only when explicit', () => {
    assert.equal(isRepresentableDecimal(0.0001, 4), true);
    assert.equal(isRepresentableDecimal(0.00001, 4), false);
    assert.equal(isRepresentableDecimal(0, 4), false);
    assert.equal(isRepresentableDecimal(0, 4, true), true);
    assert.equal(isRepresentableDecimal(null, 4), true);
    assert.equal(areRepresentableDecimals([
      { value: 1e-8, scale: 8 },
      { value: 0, scale: 4, allowZero: true },
      { value: null, scale: 4 },
    ]), true);
    assert.equal(areRepresentableDecimals([{ value: 1e-9, scale: 8 }]), false);
  });
});
