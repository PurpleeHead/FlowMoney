import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateExpenseRub,
  calculateObservedVndPerRub,
  calculateObservedVndPerUsdt,
  calculateRubPerUsdt,
  calculateTargetVndEquivalent,
  estimateRubFromVnd,
  mapActualVndExchanges,
  mapActualVndUsdtExchanges,
  mapDirectVndExchanges,
  mapRubUsdtExchanges,
} from './money.js';

describe('money regression boundaries', () => {
  it('normalizes direct-target currency casing consistently for historical rates', () => {
    const exchanges = [{
      mode: 'RUB_TARGET',
      rubSpent: 1_000,
      usdtReceived: null,
      vndReceived: null,
      targetCurrency: ' vNd ',
      targetReceived: 250_000,
      targetVndEquivalent: null,
    }];

    assert.deepEqual(mapDirectVndExchanges(exchanges), [
      { rubSpent: 1_000, vndReceived: 250_000 },
    ]);
    assert.deepEqual(mapActualVndExchanges(exchanges), []);
    assert.deepEqual(mapActualVndUsdtExchanges(exchanges), []);
  });

  it('does not double-count direct VND target exchanges in indirect actual observations', () => {
    const exchanges = [
      { mode: 'RUB_TARGET', rubSpent: 1_000, usdtReceived: null, vndReceived: 250_000, targetCurrency: 'VND', targetReceived: 250_000, targetVndEquivalent: 250_000 },
      { mode: 'RUB_USDT_VND', rubSpent: 2_000, usdtReceived: 20, vndReceived: 500_000, targetCurrency: 'VND', targetReceived: null, targetVndEquivalent: null },
    ];

    assert.deepEqual(mapDirectVndExchanges(exchanges), [
      { rubSpent: 1_000, vndReceived: 250_000 },
    ]);
    assert.deepEqual(mapActualVndExchanges(exchanges), [
      { rubSpent: 2_000, vndReceived: 500_000 },
    ]);
    assert.deepEqual(mapActualVndUsdtExchanges(exchanges), [
      { usdtReceived: 20, vndReceived: 500_000 },
    ]);
  });

  it('normalizes direct USDT target currency and excludes unrelated legacy target rows from RUB/USDT basis', () => {
    const exchanges = [
      { mode: 'RUB_TARGET', rubSpent: 1_000, usdtReceived: null, targetCurrency: ' usdt ', targetReceived: 11 },
      { mode: 'RUB_TARGET', rubSpent: 2_000, usdtReceived: 99, targetCurrency: ' VND ', targetReceived: 500_000 },
      { mode: 'RUB_USDT_VND', rubSpent: 3_000, usdtReceived: 30, targetCurrency: 'VND', targetReceived: null },
    ];

    assert.deepEqual(mapRubUsdtExchanges(exchanges), [
      { rubSpent: 1_000, usdtReceived: 11 },
      { rubSpent: 3_000, usdtReceived: 30 },
    ]);
    assert.equal(calculateRubPerUsdt(mapRubUsdtExchanges(exchanges)), 4_000 / 41);
  });

  it('weights multiple RUB-to-USDT top-ups by their actual amounts, not by averaging rates', () => {
    const exchanges = [
      { rubSpent: 8_300, usdtReceived: 93.7853 },
      { rubSpent: 4_000, usdtReceived: 50 },
    ];

    assert.equal(
      calculateRubPerUsdt(exchanges),
      (8_300 + 4_000) / (93.7853 + 50),
    );
  });

  it('weights observed VND-to-USDT card rates by the USDT actually charged', () => {
    const purchases = [
      { amountVnd: 55_536, usdtCharged: 2.19 },
      { amountVnd: 40_000, usdtCharged: 1.57 },
      { amountVnd: 722_728, usdtCharged: 28.39 },
    ];

    assert.equal(
      calculateObservedVndPerUsdt(purchases),
      (55_536 + 40_000 + 722_728) / (2.19 + 1.57 + 28.39),
    );
  });

  it('ignores invalid observations instead of contaminating weighted rates', () => {
    assert.equal(calculateRubPerUsdt([
      { rubSpent: 1_000, usdtReceived: 10 },
      { rubSpent: Number.NaN, usdtReceived: 20 },
      { rubSpent: 500, usdtReceived: Number.POSITIVE_INFINITY },
      { rubSpent: -1, usdtReceived: 1 },
    ]), 100);

    assert.equal(calculateObservedVndPerUsdt([
      { amountVnd: 250_000, usdtCharged: 10 },
      { amountVnd: Number.POSITIVE_INFINITY, usdtCharged: 10 },
      { amountVnd: 100, usdtCharged: 0 },
    ]), 25_000);
  });

  it('returns null instead of an infinite weighted rate when finite rows overflow their aggregate', () => {
    assert.equal(calculateRubPerUsdt([
      { rubSpent: Number.MAX_VALUE, usdtReceived: 1 },
      { rubSpent: Number.MAX_VALUE, usdtReceived: 1 },
    ]), null);

    assert.equal(calculateObservedVndPerUsdt([
      { amountVnd: Number.MAX_VALUE, usdtCharged: 1 },
      { amountVnd: Number.MAX_VALUE, usdtCharged: 1 },
    ]), null);

    assert.equal(calculateObservedVndPerRub({
      directExchanges: [
        { rubSpent: Number.MAX_VALUE, vndReceived: Number.MAX_VALUE },
        { rubSpent: Number.MAX_VALUE, vndReceived: Number.MAX_VALUE },
      ],
      rubPerUsdt: null,
    }), null);
  });

  it('does not create a RUB estimate from zero, negative, or non-finite rates', () => {
    for (const rate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(estimateRubFromVnd(100_000, rate, 88.5), null);
      assert.equal(estimateRubFromVnd(100_000, 25_000, rate), null);
    }
  });

  it('rejects an overflowed target-currency equivalent', () => {
    assert.throws(
      () => calculateTargetVndEquivalent('GEL', Number.MAX_VALUE, 2),
      /must be positive/,
    );
  });

  it('returns no RUB estimate for currencies without an explicit conversion path', () => {
    assert.equal(calculateExpenseRub({
      currency: ' GEL ',
      amount: 100,
      amountVnd: 920_000,
    }, 88.5, 25_000, 2_600), null);
  });


  it('rejects an invalid source amount even if a separate VND equivalent is valid', () => {
    for (const amount of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(calculateExpenseRub({
        currency: 'VND',
        amount,
        amountVnd: 100_000,
        usdtCharged: 3,
      }, 88.5, 25_000, 2_600), null);
    }
  });

  it('uses actual RUB amount directly and does not require exchange rates for RUB expenses', () => {
    assert.equal(calculateExpenseRub({
      currency: ' rub ',
      amount: 1_234.56,
      amountVnd: 1_234.56,
    }, null, null), 1_234.56);
  });

  it('keeps a card expense unknown when its recorded USDT debit is positive but RUB/USDT basis is missing', () => {
    assert.equal(calculateExpenseRub({
      currency: 'VND',
      amount: 100_000,
      amountVnd: 100_000,
      usdtCharged: 3.8,
    }, null, 26_000, 2_500), null);
  });

  it('rejects invalid direct target rates instead of returning an invalid VND equivalent', () => {
    for (const rate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => calculateTargetVndEquivalent('GEL', 100, rate));
    }
  });

  it('ignores invalid direct observations when building a weighted VND/RUB rate', () => {
    assert.equal(calculateObservedVndPerRub({
      directExchanges: [
        { rubSpent: 1_000, vndReceived: 250_000 },
        { rubSpent: 0, vndReceived: 900_000 },
        { rubSpent: 500, vndReceived: Number.NaN },
      ],
      actualVndExchanges: [
        { rubSpent: 2_000, vndReceived: 500_000 },
      ],
      cardPurchases: [
        { amountVnd: 100_000, usdtCharged: 4 },
        { amountVnd: Number.POSITIVE_INFINITY, usdtCharged: 1 },
      ],
      rubPerUsdt: 100,
    }), 850_000 / 3_400);
  });

  it('combines direct exchanges and card observations into a weighted VND/RUB rate', () => {
    const rate = calculateObservedVndPerRub({
      directExchanges: [{ rubSpent: 10_000, vndReceived: 2_500_000 }],
      cardPurchases: [{ amountVnd: 100_000, usdtCharged: 3 }],
      rubPerUsdt: 100,
    });

    assert.equal(rate, 2_600_000 / 10_300);
  });
});
