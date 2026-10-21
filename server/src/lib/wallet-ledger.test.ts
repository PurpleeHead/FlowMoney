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

  it('does not reinterpret a malformed VND card debit as a cash expense', () => {
    for (const usdtCharged of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const drafts = expenseLedgerDrafts({
        id: `e-invalid-card-${String(usdtCharged)}`, userId: 'u1', amount: 40000,
        currency: 'VND', usdtCharged, date: new Date('2026-10-16T08:00:00.000Z'),
      });
      assert.deepEqual(drafts, []);
    }
  });

  it('ignores stale card-debit fields on non-VND expenses', () => {
    const rub = expenseLedgerDrafts({
      id: 'e-stale-card-rub', userId: 'u1', amount: 2500, currency: 'RUB',
      usdtCharged: 4.5, date: new Date('2026-10-16T08:00:00.000Z'),
    });
    const usdt = expenseLedgerDrafts({
      id: 'e-stale-card-usdt', userId: 'u1', amount: 7.25, currency: 'USDT',
      usdtCharged: 4.5, date: new Date('2026-10-16T08:00:00.000Z'),
    });

    assert.deepEqual(rub.map(x => [x.currency, x.amountDelta]), [['RUB', -2500]]);
    assert.deepEqual(usdt.map(x => [x.currency, x.amountDelta]), [['USDT', -7.25]]);
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

  it('does not credit gross legacy VND when a fee exists but net VND is unknown', () => {
    const drafts = exchangeLedgerDrafts({
      id: 'x-fee-net-unknown', userId: 'u1', mode: 'RUB_VND', rubSpent: 1000,
      usdtReceived: null, vndReceived: null, vndFee: 5000, targetCurrency: 'VND',
      targetReceived: 250000, createdAt: new Date('2026-10-16T07:00:00.000Z'),
    });

    assert.deepEqual(drafts.map(x => [x.currency, x.amountDelta]), [['RUB', -1000]]);
  });

  it('preserves the legacy gross-VND fallback when the fee is explicitly zero', () => {
    const drafts = exchangeLedgerDrafts({
      id: 'x-zero-fee-legacy', userId: 'u1', mode: 'RUB_VND', rubSpent: 1000,
      usdtReceived: null, vndReceived: null, vndFee: 0, targetCurrency: 'VND',
      targetReceived: 250000, createdAt: new Date('2026-10-16T07:00:00.000Z'),
    });
    assert.deepEqual(drafts.map(x => [x.currency, x.amountDelta]), [
      ['RUB', -1000],
      ['VND', 250000],
    ]);
  });

  it('does not use gross legacy VND when the stored fee is malformed', () => {
    for (const vndFee of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const drafts = exchangeLedgerDrafts({
        id: `x-invalid-fee-${String(vndFee)}`, userId: 'u1', mode: 'RUB_VND',
        rubSpent: 1000, usdtReceived: null, vndReceived: null, vndFee,
        targetCurrency: 'VND', targetReceived: 250000,
        createdAt: new Date('2026-10-16T07:00:00.000Z'),
      });
      assert.deepEqual(drafts.map(x => [x.currency, x.amountDelta]), [['RUB', -1000]]);
    }
  });

  it('does not fall back to gross target VND when a legacy net amount is invalid', () => {
    for (const vndReceived of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const drafts = exchangeLedgerDrafts({
        id: `x-invalid-net-${String(vndReceived)}`, userId: 'u1', mode: 'RUB_VND', rubSpent: 1000,
        usdtReceived: null, vndReceived, targetCurrency: 'VND',
        targetReceived: 250000, createdAt: new Date('2026-10-16T07:00:00.000Z'),
      });
      assert.deepEqual(drafts.map(x => [x.currency, x.amountDelta]), [
        ['RUB', -1000],
      ]);
    }
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

  it('does not treat an unknown exchange mode as an indirect top-up', () => {
    const drafts = exchangeLedgerDrafts({
      id: 'x-unknown-mode', userId: 'u1', mode: 'UNRECOGNIZED_MODE', rubSpent: 500,
      usdtReceived: 10, vndReceived: 250000, targetCurrency: 'VND',
      targetReceived: 250000, createdAt: new Date('2026-10-16T07:00:00.000Z'),
    });

    assert.deepEqual(drafts.map(x => [x.currency, x.amountDelta]), [['RUB', -500]]);
  });

  it('preserves one effective timestamp across every emitted exchange currency leg', () => {
    const createdAt = new Date('2026-10-19T12:34:56.000Z');
    const drafts = exchangeLedgerDrafts({
      id: 'x-ledger-time', userId: 'u1', mode: 'RUB_USDT_VND', rubSpent: 8300,
      usdtReceived: 93.7853, vndReceived: 2_300_000, targetCurrency: 'VND',
      targetReceived: null, createdAt,
    });

    assert.equal(drafts.length, 3);
    assert.ok(drafts.every(draft => draft.occurredAt === createdAt));
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

describe('wallet ledger identity and malformed inputs', () => {
  it('keeps an expense source key stable when its amount changes', () => {
    const date = new Date('2026-10-18T08:00:00.000Z');
    const before = expenseLedgerDrafts({
      id: 'expense-edit-1', userId: 'u1', amount: 100000, currency: 'VND',
      usdtCharged: 3.25, date,
    });
    const after = expenseLedgerDrafts({
      id: 'expense-edit-1', userId: 'u1', amount: 125000, currency: 'VND',
      usdtCharged: 4.1, date,
    });

    assert.equal(before.length, 1);
    assert.equal(after.length, 1);
    assert.equal(before[0].sourceKey, 'expense:expense-edit-1:USDT');
    assert.equal(after[0].sourceKey, before[0].sourceKey);
    assert.equal(before[0].amountDelta, -3.25);
    assert.equal(after[0].amountDelta, -4.1);
  });

  it('isolates otherwise identical expense source keys by expense ID and user', () => {
    const base = {
      amount: 100, currency: 'RUB', usdtCharged: null,
      date: new Date('2026-10-18T08:00:00.000Z'),
    };
    const first = expenseLedgerDrafts({ ...base, id: 'expense-a', userId: 'u1' });
    const second = expenseLedgerDrafts({ ...base, id: 'expense-b', userId: 'u1' });
    const otherUser = expenseLedgerDrafts({ ...base, id: 'expense-a', userId: 'u2' });

    assert.notEqual(first[0].sourceKey, second[0].sourceKey);
    assert.equal(first[0].sourceKey, otherUser[0].sourceKey);
    assert.notEqual(first[0].userId, otherUser[0].userId);
  });

  it('does not emit ledger movements for non-finite or unsupported expense values', () => {
    const date = new Date('2026-10-18T08:00:00.000Z');
    assert.deepEqual(expenseLedgerDrafts({
      id: 'expense-nan', userId: 'u1', amount: Number.NaN, currency: 'RUB',
      usdtCharged: null, date,
    }), []);
    assert.deepEqual(expenseLedgerDrafts({
      id: 'expense-unsupported', userId: 'u1', amount: 100, currency: 'EUR',
      usdtCharged: null, date,
    }), []);
  });

  it('uses the expense effective date as the ledger movement timestamp', () => {
    const date = new Date('2026-10-18T08:00:00.000Z');
    const [draft] = expenseLedgerDrafts({
      id: 'expense-date', userId: 'u1', amount: 100, currency: 'RUB',
      usdtCharged: null, date,
    });
    assert.equal(draft.occurredAt, date);
  });
});

