import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { areSupportedStoredAmounts, isSupportedStoredAmount, MAX_STORED_AMOUNT } from './amount-limits.js';

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
});
