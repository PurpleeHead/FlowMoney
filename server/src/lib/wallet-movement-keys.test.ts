import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { adjustmentSourceKey, openingBalanceSourceKey } from './wallet-movement-keys.js';

describe('wallet movement source keys', () => {
  it('generates the same opening key for concurrent attempts by one user and currency', () => {
    assert.equal(openingBalanceSourceKey('user-1', 'USDT'), openingBalanceSourceKey('user-1', 'USDT'));
  });

  it('isolates opening balances by user and currency', () => {
    const keys = new Set([
      openingBalanceSourceKey('user-1', 'RUB'),
      openingBalanceSourceKey('user-1', 'USDT'),
      openingBalanceSourceKey('user-1', 'VND'),
      openingBalanceSourceKey('user-2', 'USDT'),
    ]);
    assert.equal(keys.size, 4);
  });

  it('keeps manual adjustments unique even for the same user', () => {
    assert.notEqual(adjustmentSourceKey('user-1', 'movement-a'), adjustmentSourceKey('user-1', 'movement-b'));
  });
});
