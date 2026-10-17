import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildJournal } from './journal.js';

describe('unified journal', () => {
  it('merges expenses and exchanges newest-first without inventing missing conversions', () => {
    const entries = buildJournal(
      [{
        id: 'expense-1', title: 'Coffee', category: 'Food', amount: 45_000,
        currency: 'VND', amountVnd: 45_000, amountRub: null, usdtCharged: 1.8,
        date: '2026-10-16T08:00:00.000Z', createdAt: '2026-10-16T08:00:01.000Z',
      }],
      [{
        id: 'exchange-1', mode: 'RUB_USDT_VND', rubSpent: 8300, usdtReceived: 93.7853,
        vndReceived: null, targetCurrency: 'VND', targetReceived: null,
        targetVndEquivalent: null, createdAt: '2026-10-16T07:00:00.000Z',
      }],
    );

    assert.equal(entries.length, 2);
    assert.equal(entries[0].id, 'expense:expense-1');
    assert.equal(entries[0].type, 'expense');
    if (entries[0].type === 'expense') {
      assert.equal(entries[0].amount, 45_000);
      assert.equal(entries[0].usdtCharged, 1.8);
      assert.equal(entries[0].amountRub, null);
    }
    assert.equal(entries[1].id, 'exchange:exchange-1');
    if (entries[1].type === 'exchange') {
      assert.equal(entries[1].vndReceived, null);
      assert.equal(entries[1].usdtReceived, 93.7853);
    }
  });

  it('clamps the requested limit and uses stable ordering for equal timestamps', () => {
    const expenses = ['b', 'a'].map(id => ({
      id, title: id, category: 'Other', amount: 1, currency: 'RUB',
      amountVnd: null, amountRub: 1, usdtCharged: null,
      date: '2026-10-16T08:00:00.000Z', createdAt: '2026-10-16T08:00:00.000Z',
    }));
    assert.deepEqual(buildJournal(expenses, [], 0).map(x => x.id), ['expense:a']);
    assert.equal(buildJournal(expenses, [], 999).length, 2);
  });

  it('does not expose non-finite values as numeric amounts', () => {
    const entries = buildJournal([{
      id: 'bad', title: 'Invalid', category: 'Other', amount: Number.NaN,
      currency: 'RUB', amountVnd: Number.POSITIVE_INFINITY, amountRub: null,
      usdtCharged: null, date: '2026-10-16T08:00:00.000Z', createdAt: '2026-10-16T08:00:00.000Z',
    }], []);
    assert.equal(entries[0].type, 'expense');
    if (entries[0].type === 'expense') {
      assert.equal(entries[0].amount, 0);
      assert.equal(entries[0].amountVnd, null);
    }
  });
});
