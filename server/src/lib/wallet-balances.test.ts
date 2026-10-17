import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateWalletBalances } from './wallet-balances.js';

const at = (value: string) => new Date(value);

describe('wallet balance calculation', () => {
  it('keeps the available balance unknown until an opening snapshot exists', () => {
    const balances = calculateWalletBalances([
      { currency: 'USDT', amountDelta: 93.7853, kind: 'EXCHANGE', createdAt: at('2026-10-16T08:00:00Z') },
      { currency: 'USDT', amountDelta: -2.19, kind: 'EXPENSE', createdAt: at('2026-10-16T09:00:00Z') },
    ]);
    assert.deepEqual(balances, [{
      currency: 'USDT', netMovement: 91.5953, hasOpeningBalance: false, balance: null,
    }]);
  });

  it('uses the opening balance and applies movements created at or after it', () => {
    const balances = calculateWalletBalances([
      { currency: 'VND', amountDelta: -50000, kind: 'ADJUSTMENT', createdAt: at('2026-10-16T07:00:00Z') },
      { currency: 'VND', amountDelta: 1000000, kind: 'OPENING', createdAt: at('2026-10-16T08:00:00Z') },
      { currency: 'VND', amountDelta: -40000, kind: 'EXPENSE', createdAt: at('2026-10-16T09:00:00Z') },
    ]);
    assert.deepEqual(balances, [{
      currency: 'VND', netMovement: 910000, hasOpeningBalance: true, balance: 960000,
    }]);
  });

  it('returns stable currency ordering and keeps currencies independent', () => {
    const balances = calculateWalletBalances([
      { currency: 'VND', amountDelta: 100, kind: 'OPENING', createdAt: at('2026-10-16T08:00:00Z') },
      { currency: 'RUB', amountDelta: 500, kind: 'OPENING', createdAt: at('2026-10-16T08:00:00Z') },
    ]);
    assert.deepEqual(balances.map(item => item.currency), ['RUB', 'VND']);
    assert.deepEqual(balances.map(item => item.balance), [500, 100]);
  });
});
