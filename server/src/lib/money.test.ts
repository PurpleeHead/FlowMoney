import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateExpenseRub,
  calculateTargetVndEquivalent,
  calculateObservedVndPerUsdt,
  calculateObservedVndPerRub,
  calculateRubPerUsdt,
  mapDirectVndExchanges,
  estimateRubFromVnd,
  resolveExchangeVndOutcome,
} from './money.js';

describe('unified RUB cost formula', () => {
  const exchange = [{ rubSpent: 8300, usdtReceived: 93.7853 }];
  const purchases = [
    { amountVnd: 55536, usdtCharged: 2.19 },
    { amountVnd: 40000, usdtCharged: 1.57 },
    { amountVnd: 722728, usdtCharged: 28.39 },
  ];

  it('calculates the effective exchange and card-purchase rates from the real example', () => {
    const rubPerUsdt = calculateRubPerUsdt(exchange);
    const vndPerUsdt = calculateObservedVndPerUsdt(purchases);
    assert.ok(rubPerUsdt);
    assert.ok(vndPerUsdt);
    assert.ok(Math.abs(rubPerUsdt - 88.5000101) < 0.00001);
    assert.ok(Math.abs(vndPerUsdt - 25451.4463) < 0.01);
    assert.ok(Math.abs(estimateRubFromVnd(100000, vndPerUsdt, rubPerUsdt)! - 347.7209) < 0.01);
  });

  it('uses actual card debit for the recorded expense and estimates when debit is unknown', () => {
    const rubPerUsdt = calculateRubPerUsdt(exchange)!;
    const vndPerUsdt = calculateObservedVndPerUsdt(purchases)!;
    assert.ok(Math.abs(calculateExpenseRub({
      currency: 'VND', amount: 55536, amountVnd: 55536, usdtCharged: 2.19,
    }, rubPerUsdt, vndPerUsdt)! - 193.8150) < 0.01);
    assert.ok(Math.abs(calculateExpenseRub({
      currency: 'VND', amount: 100000, amountVnd: 100000,
    }, rubPerUsdt, vndPerUsdt)! - 347.7209) < 0.01);
  });

  it('combines direct RUB-to-VND exchanges and card observations for future estimates', () => {
    const vndPerRub = calculateObservedVndPerRub({
      directExchanges: [{ rubSpent: 10000, vndReceived: 2500000 }],
      cardPurchases: [{ amountVnd: 100000, usdtCharged: 3 }],
      rubPerUsdt: 100,
    });
    assert.ok(vndPerRub);
    assert.ok(Math.abs(vndPerRub - (2600000 / 10300)) < 0.000001);
    assert.ok(Math.abs(calculateExpenseRub({
      currency: 'VND', amount: 79000, amountVnd: 79000,
    }, 100, 33333.3333, vndPerRub)! - (79000 / vndPerRub)) < 0.000001);
  });

  it('keeps VND rate unknown until a real outcome is recorded', () => {
    assert.equal(calculateObservedVndPerUsdt([]), null);
    assert.equal(calculateRubPerUsdt(exchange), 8300 / 93.7853);
  });

  it('stores actual VND received and derives the observed rate from the actual amounts', () => {
    assert.deepEqual(resolveExchangeVndOutcome({ usdtReceived: 100, vndReceived: 2500000 }), {
      vndReceived: 2500000,
      vndPerUsdt: 25000,
    });
  });

  it('allows recording RUB to USDT while VND is still unknown', () => {
    assert.deepEqual(resolveExchangeVndOutcome({ usdtReceived: 100 }), {
      vndReceived: null,
      vndPerUsdt: null,
    });
  });

  it('rejects a rate without an actual VND outcome', () => {
    assert.throws(() => resolveExchangeVndOutcome({ usdtReceived: 100, vndPerUsdt: 25000 }));
  });

  it('returns null rather than inventing a RUB estimate when rates are missing', () => {
    assert.equal(estimateRubFromVnd(100000, null, 88.5), null);
    assert.equal(estimateRubFromVnd(100000, 25451, null), null);
  });
});

describe('direct exchange observations', () => {
  it('includes RUB_TARGET VND equivalents when recalculating historical VND/RUB rates', () => {
    assert.deepEqual(mapDirectVndExchanges([
      { mode: 'RUB_VND', rubSpent: 1000, vndReceived: 250000 },
      { mode: 'RUB_TARGET', rubSpent: 2000, targetVndEquivalent: 460000 },
      { mode: 'RUB_USDT_VND', rubSpent: 3000, vndReceived: null },
    ]), [
      { rubSpent: 1000, vndReceived: 250000 },
      { rubSpent: 2000, vndReceived: 460000 },
    ]);
  });
});

describe('direct target-currency exchange', () => {
  it('uses a 1:1 rate for VND and preserves the actual received amount', () => {
    assert.equal(calculateTargetVndEquivalent('VND', 2500000, null), 2500000);
  });

  it('converts a non-VND target amount into the shared VND budget', () => {
    assert.equal(calculateTargetVndEquivalent('GEL', 100, 9200), 920000);
  });

  it('requires a VND-per-unit rate for non-VND target currencies', () => {
    assert.throws(() => calculateTargetVndEquivalent('GEL', 100, null));
    assert.throws(() => calculateTargetVndEquivalent('TRY', 100, 0));
  });
});


describe('conservative card-expense RUB cost', () => {
  const cardExpense = {
    currency: 'VND',
    amount: 79_000,
    amountVnd: 79_000,
    usdtCharged: 3,
  };

  it('does not fall back to VND/RUB when the RUB/USDT cost basis is unknown', () => {
    assert.equal(calculateExpenseRub(cardExpense, null, 26_333, 2_600), null);
  });

  it('uses actual USDT debit multiplied by the known RUB/USDT cost basis', () => {
    assert.equal(calculateExpenseRub(cardExpense, 8_300 / 93.7853, 26_333, 2_600), 3 * (8_300 / 93.7853));
  });

  it('does not fall back when the RUB/USDT rate is zero or invalid', () => {
    assert.equal(calculateExpenseRub(cardExpense, 0, 26_333, 2_600), null);
    assert.equal(calculateExpenseRub(cardExpense, Number.NaN, 26_333, 2_600), null);
  });

  it('does not estimate a card expense when the recorded USDT debit is invalid', () => {
    assert.equal(calculateExpenseRub({ ...cardExpense, usdtCharged: 0 }, 88.5, 26_333, 2_600), null);
    assert.equal(calculateExpenseRub({ ...cardExpense, usdtCharged: Number.NaN }, 88.5, 26_333, 2_600), null);
  });

  it('normalizes currency codes before calculating RUB cost', () => {
    assert.equal(calculateExpenseRub({ currency: 'rub', amount: 125, amountVnd: 125 }, null, null), 125);
    assert.equal(calculateExpenseRub({ ...cardExpense, currency: 'vnd' }, null, 26_333, 2_600), null);
  });

  it('does not treat an unsupported target currency as VND', () => {
    assert.equal(calculateExpenseRub({
      currency: 'GEL', amount: 100, amountVnd: 920_000,
    }, 88.5, 25_000, 2_600), null);
    assert.equal(calculateExpenseRub({
      currency: 'TRY', amount: 100, amountVnd: 100,
    }, 88.5, 25_000, 2_600), null);
  });

  it('rejects non-finite VND values instead of persisting an invalid RUB cost', () => {
    assert.equal(calculateExpenseRub({
      currency: 'VND', amount: Number.POSITIVE_INFINITY, amountVnd: Number.POSITIVE_INFINITY,
    }, 88.5, 25_000, null), null);
  });
});
