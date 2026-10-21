import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { expenseLedgerDrafts, exchangeLedgerDrafts } from './wallet-ledger.js';

describe('wallet ledger mapping', () => {
  it('records a card purchase as a USDT debit only, not a duplicate VND debit', () => {
    const drafts = expenseLedgerDrafts({
      id: 'e1', userId: 'u1', amount: 55536, currency: 'VND',
      usdtCharged: 2.19, date: new Date('2026-10-16T08:00:00.000Z'),
    });
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].currency, 'USDT');
    assert.equal(drafts[0].amountDelta, -2.19);
  });

  it('records a cash VND expense in VND when there is no card debit', () => {
    const drafts = expenseLedgerDrafts({
      id: 'e2', userId: 'u1', amount: 40000, currency: 'vnd',
      usdtCharged: null, date: new Date('2026-10-16T08:00:00.000Z'),
    });
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].currency, 'VND');
    assert.equal(drafts[0].amountDelta, -40000);
  });

  it('keeps an unknown VND exchange outcome unknown while recording known RUB and USDT legs', () => {
    const drafts = exchangeLedgerDrafts({
      id: 'x1', userId: 'u1', mode: 'RUB_USDT_VND', rubSpent: 8300,
      usdtReceived: 93.7853, vndReceived: null, targetCurrency: 'VND',
      targetReceived: null, createdAt: new Date('2026-10-16T07:00:00.000Z'),
    });
    assert.deepEqual(drafts.map(x => [x.currency, x.amountDelta]), [
      ['RUB', -8300],
      ['USDT', 93.7853],
    ]);
  });

  it('does not double-credit VND for a direct RUB to VND exchange', () => {
    const drafts = exchangeLedgerDrafts({
      id: 'x2', userId: 'u1', mode: 'RUB_VND', rubSpent: 1000,
      usdtReceived: null, vndReceived: 250000, targetCurrency: 'VND',
      targetReceived: 250000, createdAt: new Date('2026-10-16T07:00:00.000Z'),
    });
    assert.deepEqual(drafts.map(x => [x.currency, x.amountDelta]), [
      ['RUB', -1000],
      ['VND', 250000],
    ]);
  });

  it('uses net VND received rather than a gross legacy target amount when an exchange fee exists', () => {
    const drafts = exchangeLedgerDrafts({
      id: 'x-fee', userId: 'u1', mode: 'RUB_VND', rubSpent: 1000,
      usdtReceived: null, vndReceived: 245000, targetCurrency: 'VND',
      targetReceived: 250000, createdAt: new Date('2026-10-16T07:00:00.000Z'),
    });
    assert.deepEqual(drafts.map(x => [x.currency, x.amountDelta]), [
      ['RUB', -1000],
      ['VND', 245000],
    ]);
  });

  it('does not fall back to gross target VND when a legacy net amount is zero', () => {
    const drafts = exchangeLedgerDrafts({
      id: 'x-zero-net', userId: 'u1', mode: 'RUB_VND', rubSpent: 1000,
      usdtReceived: null, vndReceived: 0, targetCurrency: 'VND',
      targetReceived: 250000, createdAt: new Date('2026-10-16T07:00:00.000Z'),
    });
    assert.deepEqual(drafts.map(x => [x.currency, x.amountDelta]), [
      ['RUB', -1000],
    ]);
  });

  it('does not fall back to gross target VND when a legacy net amount is invalid', () => {
    const drafts = exchangeLedgerDrafts({
      id: 'x-invalid-net', userId: 'u1', mode: 'RUB_VND', rubSpent: 1000,
      usdtReceived: null, vndReceived: -1, targetCurrency: 'VND',
      targetReceived: 250000, createdAt: new Date('2026-10-16T07:00:00.000Z'),
    });
    assert.deepEqual(drafts.map(x => [x.currency, x.amountDelta]), [
      ['RUB', -1000],
    ]);
  });

  it('credits actual USDT received in a direct RUB to USDT exchange', () => {
    const drafts = exchangeLedgerDrafts({
      id: 'x4', userId: 'u1', mode: 'RUB_TARGET', rubSpent: 8300,
      usdtReceived: null, vndReceived: null, targetCurrency: 'USDT',
      targetReceived: 93.7853, createdAt: new Date('2026-10-16T07:00:00.000Z'),
    });
    assert.deepEqual(drafts.map(x => [x.currency, x.amountDelta]), [
      ['RUB', -8300],
      ['USDT', 93.7853],
    ]);
  });

  it('credits only the actual target currency amount, not its estimated VND equivalent', () => {
    const drafts = exchangeLedgerDrafts({
      id: 'x5', userId: 'u1', mode: 'RUB_TARGET', rubSpent: 1000,
      usdtReceived: null, vndReceived: null, targetCurrency: 'VND',
      targetReceived: 250000, createdAt: new Date('2026-10-16T07:00:00.000Z'),
    });
    assert.deepEqual(drafts.map(x => [x.currency, x.amountDelta]), [
      ['RUB', -1000],
      ['VND', 250000],
    ]);
  });

  it('does not count target VND equivalent as a real VND wallet inflow', () => {
    const drafts = exchangeLedgerDrafts({
      id: 'x3', userId: 'u1', mode: 'RUB_TARGET', rubSpent: 1000,
      usdtReceived: null, vndReceived: null, targetCurrency: 'USD',
      targetReceived: 12, createdAt: new Date('2026-10-16T07:00:00.000Z'),
    });
    assert.deepEqual(drafts.map(x => [x.currency, x.amountDelta]), [
      ['RUB', -1000],
    ]);
  });

  it('does not create a RUB credit for an invalid legacy RUB_TARGET record', () => {
    const drafts = exchangeLedgerDrafts({
      id: 'x-invalid', userId: 'u1', mode: 'RUB_TARGET', rubSpent: 200,
      usdtReceived: null, vndReceived: null, targetCurrency: 'RUB',
      targetReceived: 100, createdAt: new Date('2026-10-16T07:00:00.000Z'),
    });
    assert.deepEqual(drafts.map(x => [x.currency, x.amountDelta]), [
      ['RUB', -200],
    ]);
  });
});
