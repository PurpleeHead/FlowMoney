import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateWalletBalances } from './wallet-balances.js';

const at = (value: string) => new Date(value);

describe('wallet balance calculation', () => {
  it('keeps the available balance unknown until an opening snapshot exists', () => {
    const balances = calculateWalletBalances([
      { currency: 'USDT', amountDelta: 93.7853, kind: 'EXCHANGE', createdAt: at('2026-10-16T08:00:00Z'), occurredAt: at('2026-10-16T08:00:00Z') },
      { currency: 'USDT', amountDelta: -2.19, kind: 'EXPENSE', createdAt: at('2026-10-16T09:00:00Z'), occurredAt: at('2026-10-16T09:00:00Z') },
    ]);
    assert.deepEqual(balances.find(item => item.currency === 'USDT'), {
      currency: 'USDT', netMovement: '91.5953', hasOpeningBalance: false, balance: null,
    });
    assert.deepEqual(balances.map(item => item.currency), ['RUB', 'USDT', 'VND']);
  });

  it('uses the opening balance and applies movements created at or after it', () => {
    const balances = calculateWalletBalances([
      { currency: 'VND', amountDelta: -50000, kind: 'ADJUSTMENT', createdAt: at('2026-10-16T07:00:00Z'), occurredAt: at('2026-10-16T07:00:00Z') },
      { currency: 'VND', amountDelta: 1000000, kind: 'OPENING', createdAt: at('2026-10-16T08:00:00Z'), occurredAt: at('2026-10-16T08:00:00Z') },
      { currency: 'VND', amountDelta: -40000, kind: 'EXPENSE', createdAt: at('2026-10-16T09:00:00Z'), occurredAt: at('2026-10-16T09:00:00Z') },
    ]);
    assert.deepEqual(balances.find(item => item.currency === 'VND'), {
      currency: 'VND', netMovement: '910000', hasOpeningBalance: true, balance: '960000',
    });
  });

  it('does not re-apply a pre-opening expense just because it was edited later', () => {
    const balances = calculateWalletBalances([
      {
        currency: 'USDT', amountDelta: 50, kind: 'OPENING',
        createdAt: at('2026-10-16T08:00:00Z'), occurredAt: at('2026-10-16T08:00:00Z'),
      },
      {
        currency: 'USDT', amountDelta: -2.19, kind: 'EXPENSE',
        // The ledger row was recreated after the opening snapshot, but the purchase itself predates it.
        createdAt: at('2026-10-17T08:00:00Z'), occurredAt: at('2026-10-16T07:00:00Z'),
      },
      {
        currency: 'USDT', amountDelta: -1.5, kind: 'EXPENSE',
        createdAt: at('2026-10-17T09:00:00Z'), occurredAt: at('2026-10-16T09:00:00Z'),
      },
    ]);
    assert.equal(balances.find(item => item.currency === 'USDT')?.balance, '48.5');
  });

  it('excludes a pre-opening movement with the exact same occurrence timestamp', () => {
    const balances = calculateWalletBalances([
      {
        currency: 'USDT', amountDelta: -2, kind: 'EXPENSE',
        createdAt: at('2026-10-16T08:00:00.000Z'), occurredAt: at('2026-10-16T08:00:00.000Z'),
      },
      {
        currency: 'USDT', amountDelta: 50, kind: 'OPENING',
        createdAt: at('2026-10-16T08:00:00.001Z'), occurredAt: at('2026-10-16T08:00:00.000Z'),
      },
    ]);
    assert.equal(balances.find(item => item.currency === 'USDT')?.balance, '50');
  });

  it('returns stable currency ordering and keeps currencies independent', () => {
    const balances = calculateWalletBalances([
      { currency: 'VND', amountDelta: 100, kind: 'OPENING', createdAt: at('2026-10-16T08:00:00Z'), occurredAt: at('2026-10-16T08:00:00Z') },
      { currency: 'RUB', amountDelta: 500, kind: 'OPENING', createdAt: at('2026-10-16T08:00:00Z'), occurredAt: at('2026-10-16T08:00:00Z') },
    ]);
    assert.deepEqual(balances.map(item => item.currency), ['RUB', 'USDT', 'VND']);
    assert.deepEqual(balances.map(item => item.balance), ['500', null, '100']);
  });
});

describe('empty wallets', () => {
  it('returns all supported currencies with unknown balances before opening snapshots', () => {
    assert.deepEqual(calculateWalletBalances([]), [
      { currency: 'RUB', netMovement: '0', hasOpeningBalance: false, balance: null },
      { currency: 'USDT', netMovement: '0', hasOpeningBalance: false, balance: null },
      { currency: 'VND', netMovement: '0', hasOpeningBalance: false, balance: null },
    ]);
  });
});


describe('exact wallet arithmetic', () => {
  it('preserves tiny USDT movements alongside a large balance', () => {
    const balances = calculateWalletBalances([
      { currency: 'USDT', amountDelta: '90000000', kind: 'OPENING', createdAt: at('2026-10-16T08:00:00Z'), occurredAt: at('2026-10-16T08:00:00Z') },
      { currency: 'USDT', amountDelta: '0.00000001', kind: 'ADJUSTMENT', createdAt: at('2026-10-16T09:00:00Z'), occurredAt: at('2026-10-16T09:00:00Z') },
      { currency: 'USDT', amountDelta: '-0.00000002', kind: 'ADJUSTMENT', createdAt: at('2026-10-16T10:00:00Z'), occurredAt: at('2026-10-16T10:00:00Z') },
    ]);
    assert.equal(balances.find(item => item.currency === 'USDT')?.netMovement, '89999999.99999999');
    assert.equal(balances.find(item => item.currency === 'USDT')?.balance, '89999999.99999999');
  });

  it('sums decimal inputs without binary floating point drift', () => {
    const balances = calculateWalletBalances([
      { currency: 'RUB', amountDelta: '0.1', kind: 'OPENING', createdAt: at('2026-10-16T08:00:00Z'), occurredAt: at('2026-10-16T08:00:00Z') },
      { currency: 'RUB', amountDelta: '0.2', kind: 'ADJUSTMENT', createdAt: at('2026-10-16T09:00:00Z'), occurredAt: at('2026-10-16T09:00:00Z') },
    ]);
    assert.equal(balances.find(item => item.currency === 'RUB')?.netMovement, '0.3');
    assert.equal(balances.find(item => item.currency === 'RUB')?.balance, '0.3');
  });

  it('supports exponent notation from numeric inputs', () => {
    const balances = calculateWalletBalances([
      { currency: 'USDT', amountDelta: 1e-8, kind: 'OPENING', createdAt: at('2026-10-16T08:00:00Z'), occurredAt: at('2026-10-16T08:00:00Z') },
    ]);
    assert.equal(balances.find(item => item.currency === 'USDT')?.netMovement, '0.00000001');
    assert.equal(balances.find(item => item.currency === 'USDT')?.balance, '0.00000001');
  });
});
