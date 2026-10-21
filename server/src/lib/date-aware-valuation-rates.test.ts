import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateDateAwareValuationRates } from './date-aware-valuation-rates.js';
import type { DateAwareValuationAggregate } from './date-aware-valuation-aggregates.js';

function aggregate(overrides: Partial<DateAwareValuationAggregate> = {}): DateAwareValuationAggregate {
  return {
    rubUsdtRub: 0,
    rubUsdtUsdt: 0,
    actualVnd: 0,
    actualUsdt: 0,
    directRub: 0,
    directVnd: 0,
    actualRubForVnd: 0,
    actualVndForRub: 0,
    cardVnd: 0,
    cardUsdt: 0,
    ...overrides,
  };
}

describe('date-aware valuation rates', () => {
  it('returns null rates when there is no valid historical valuation evidence', () => {
    assert.deepEqual(calculateDateAwareValuationRates(aggregate()), {
      rubPerUsdt: null,
      vndPerUsdt: null,
      vndPerRub: null,
    });
  });

  it('combines direct exchanges, indirect actual outcomes, and card debits by weighted RUB cost', () => {
    const rates = calculateDateAwareValuationRates(aggregate({
      rubUsdtRub: 8_300,
      rubUsdtUsdt: 100,
      actualVnd: 2_500_000,
      actualUsdt: 100,
      directRub: 1_000,
      directVnd: 300_000,
      actualRubForVnd: 166,
      actualVndForRub: 50_000,
      cardVnd: 500_000,
      cardUsdt: 20,
    }));

    assert.equal(rates.rubPerUsdt, 83);
    assert.equal(rates.vndPerUsdt, 25_000, 'the actual card purchase rate remains the preferred VND/USDT observation');
    assert.equal(rates.vndPerRub, 850_000 / (1_000 + 166 + 20 * 83),
      'VND/RUB must combine direct, indirect, and card evidence using the actual RUB cost basis');
  });

  it('does not let a zero card denominator suppress a valid actual exchange rate', () => {
    const rates = calculateDateAwareValuationRates(aggregate({
      rubUsdtRub: 8300,
      rubUsdtUsdt: 100,
      actualVnd: 2_500_000,
      actualUsdt: 100,
      actualRubForVnd: 8300,
      actualVndForRub: 2_500_000,
      cardVnd: 0,
      cardUsdt: 0,
    }));
    assert.equal(rates.rubPerUsdt, 83);
    assert.equal(rates.vndPerUsdt, 25_000);
    assert.equal(rates.vndPerRub, 301.2048192771084);
  });

  it('prefers actual card purchase rates over exchange rates for VND/USDT', () => {
    const rates = calculateDateAwareValuationRates(aggregate({
      rubUsdtRub: 8_300,
      rubUsdtUsdt: 100,
      actualVnd: 2_600_000,
      actualUsdt: 100,
      cardVnd: 500_000,
      cardUsdt: 20,
      directRub: 0,
      directVnd: 0,
    }));
    assert.equal(rates.rubPerUsdt, 83);
    assert.equal(rates.vndPerUsdt, 25_000);
  });

  it('does not treat a positive card VND total without a positive USDT denominator as a rate', () => {
    const rates = calculateDateAwareValuationRates(aggregate({
      rubUsdtRub: 8_300,
      rubUsdtUsdt: 100,
      actualVnd: 2_500_000,
      actualUsdt: 100,
      cardVnd: 500_000,
      cardUsdt: 0,
    }));
    assert.equal(rates.rubPerUsdt, 83);
    assert.equal(rates.vndPerUsdt, 25_000);
  });

  it('does not treat a positive card USDT total without a positive VND numerator as a rate', () => {
    const rates = calculateDateAwareValuationRates(aggregate({
      rubUsdtRub: 8_300,
      rubUsdtUsdt: 100,
      actualVnd: 2_500_000,
      actualUsdt: 100,
      cardVnd: 0,
      cardUsdt: 20,
    }));
    assert.equal(rates.rubPerUsdt, 83);
    assert.equal(rates.vndPerUsdt, 25_000);
  });

  it('falls back to actual exchange evidence when card totals are non-positive', () => {
    const rates = calculateDateAwareValuationRates(aggregate({
      rubUsdtRub: 8_300,
      rubUsdtUsdt: 100,
      actualVnd: 2_500_000,
      actualUsdt: 100,
      directRub: 1_000,
      directVnd: 300_000,
      cardVnd: 0,
      cardUsdt: 2,
    }));
    assert.equal(rates.rubPerUsdt, 83);
    assert.equal(rates.vndPerUsdt, 25_000);
    assert.equal(rates.vndPerRub, 300);
  });

  it('falls back to valid exchange evidence when card aggregate values are non-finite', () => {
    const rates = calculateDateAwareValuationRates(aggregate({
      rubUsdtRub: 8_300,
      rubUsdtUsdt: 100,
      actualVnd: 2_500_000,
      actualUsdt: 100,
      directRub: 1_000,
      directVnd: 300_000,
      cardVnd: 'NaN',
      cardUsdt: 2,
    }));
    assert.equal(rates.rubPerUsdt, 83);
    assert.equal(rates.vndPerUsdt, 25_000);
    assert.equal(rates.vndPerRub, 300);
  });

  it('keeps a valid card VND/USDT observation when exchange totals are invalid', () => {
    const rates = calculateDateAwareValuationRates(aggregate({
      rubUsdtRub: 'Infinity',
      rubUsdtUsdt: 100,
      actualVnd: 'NaN',
      actualUsdt: 100,
      cardVnd: 50_000,
      cardUsdt: 2,
    }));
    assert.equal(rates.rubPerUsdt, null);
    assert.equal(rates.vndPerUsdt, 25_000);
    assert.equal(rates.vndPerRub, null);
  });

  it('does not derive RUB/USDT from a zero USDT denominator', () => {
    const rates = calculateDateAwareValuationRates(aggregate({
      rubUsdtRub: 8_300,
      rubUsdtUsdt: 0,
      actualVnd: 2_500_000,
      actualUsdt: 100,
      directRub: 1_000,
      directVnd: 300_000,
      cardVnd: 0,
      cardUsdt: 0,
    }));
    assert.equal(rates.rubPerUsdt, null);
    assert.equal(rates.vndPerUsdt, 25_000);
    assert.equal(rates.vndPerRub, 300);
  });

  it('does not return non-finite rates when finite SQL totals overflow during conversion', () => {
    const rates = calculateDateAwareValuationRates(aggregate({
      rubUsdtRub: Number.MAX_VALUE,
      rubUsdtUsdt: Number.MIN_VALUE,
      actualVnd: Number.MAX_VALUE,
      actualUsdt: Number.MIN_VALUE,
      directRub: Number.MAX_VALUE,
      directVnd: Number.MIN_VALUE,
      actualRubForVnd: Number.MAX_VALUE,
      actualVndForRub: Number.MIN_VALUE,
      cardVnd: Number.MAX_VALUE,
      cardUsdt: Number.MIN_VALUE,
    }));
    for (const rate of Object.values(rates)) {
      assert.ok(rate === null || Number.isFinite(rate), 'derived rates must be finite or null');
    }
  });

  it('does not allow invalid card evidence to contaminate VND/RUB when exchange evidence is valid', () => {
    const rates = calculateDateAwareValuationRates(aggregate({
      rubUsdtRub: 8_300,
      rubUsdtUsdt: 100,
      actualVnd: 2_500_000,
      actualUsdt: 100,
      directRub: 1_000,
      directVnd: 300_000,
      cardVnd: 'Infinity',
      cardUsdt: 'Infinity',
    }));
    assert.equal(rates.rubPerUsdt, 83);
    assert.equal(rates.vndPerUsdt, 25_000);
    assert.equal(rates.vndPerRub, 300);
  });

  it('rejects non-finite aggregate conversions when no other valid evidence exists', () => {
    const rates = calculateDateAwareValuationRates(aggregate({
      rubUsdtRub: 'Infinity',
      rubUsdtUsdt: 100,
      actualVnd: 'NaN',
      actualUsdt: 100,
      directRub: 'Infinity',
      directVnd: 250_000,
      actualRubForVnd: 100,
      actualVndForRub: 'NaN',
      cardVnd: 0,
      cardUsdt: 0,
    }));
    assert.equal(rates.rubPerUsdt, null);
    assert.equal(rates.vndPerUsdt, null);
    assert.equal(rates.vndPerRub, null);
  });
  it('derives VND/RUB from direct exchanges even when RUB/USDT is unknown', () => {
    const rates = calculateDateAwareValuationRates(aggregate({
      directRub: 2_000,
      directVnd: 500_000,
    }));
    assert.equal(rates.rubPerUsdt, null);
    assert.equal(rates.vndPerUsdt, null);
    assert.equal(rates.vndPerRub, 250);
  });

  it('uses actual exchange outcomes for VND/USDT when there are no card purchases', () => {
    const rates = calculateDateAwareValuationRates(aggregate({
      rubUsdtRub: 8_300,
      rubUsdtUsdt: 100,
      actualVnd: 2_750_000,
      actualUsdt: 100,
      actualRubForVnd: 8_300,
      actualVndForRub: 2_750_000,
    }));
    assert.equal(rates.rubPerUsdt, 83);
    assert.equal(rates.vndPerUsdt, 27_500);
    assert.ok(Math.abs(rates.vndPerRub! - (2_750_000 / 8_300)) < 1e-10);
  });

  it('keeps direct VND/RUB evidence valid when indirect exchange totals are incomplete', () => {
    const rates = calculateDateAwareValuationRates(aggregate({
      rubUsdtRub: 8_300,
      rubUsdtUsdt: 0,
      directRub: 1_500,
      directVnd: 450_000,
      actualRubForVnd: 0,
      actualVndForRub: 0,
    }));
    assert.equal(rates.rubPerUsdt, null);
    assert.equal(rates.vndPerUsdt, null);
    assert.equal(rates.vndPerRub, 300);
  });

  it('does not allow incomplete direct exchange totals to suppress valid indirect evidence', () => {
    const rates = calculateDateAwareValuationRates(aggregate({
      rubUsdtRub: 8_300,
      rubUsdtUsdt: 100,
      directRub: 1_000,
      directVnd: 0,
      actualRubForVnd: 8_300,
      actualVndForRub: 2_500_000,
    }));
    assert.equal(rates.rubPerUsdt, 83);
    assert.equal(rates.vndPerUsdt, null);
    assert.equal(rates.vndPerRub, 301.2048192771084);
  });

  it('preserves all valid historical rates when the aggregate includes negative malformed values', () => {
    const rates = calculateDateAwareValuationRates(aggregate({
      rubUsdtRub: -8_300,
      rubUsdtUsdt: 100,
      actualVnd: -2_500_000,
      actualUsdt: 100,
      directRub: -1_000,
      directVnd: 300_000,
      actualRubForVnd: 8_300,
      actualVndForRub: 2_500_000,
      cardVnd: -500_000,
      cardUsdt: 20,
    }));
    assert.equal(rates.rubPerUsdt, null);
    assert.equal(rates.vndPerUsdt, null);
    assert.equal(rates.vndPerRub, 301.2048192771084);
  });

  it('is invariant to scaling every valid aggregate numerator and denominator by the same factor', () => {
    const values = {
      rubUsdtRub: 8_300,
      rubUsdtUsdt: 100,
      actualVnd: 2_500_000,
      actualUsdt: 100,
      directRub: 1_000,
      directVnd: 300_000,
      actualRubForVnd: 166,
      actualVndForRub: 50_000,
      cardVnd: 500_000,
      cardUsdt: 20,
    };
    const baseline = calculateDateAwareValuationRates(aggregate(values));
    const scaled = calculateDateAwareValuationRates(aggregate(
      Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value * 10])) as Partial<DateAwareValuationAggregate>,
    ));
    assert.deepEqual(scaled, baseline);
  });

  it('uses weighted totals rather than averaging individual observed rates arithmetically', () => {
    const rates = calculateDateAwareValuationRates(aggregate({
      rubUsdtRub: 8_300,
      rubUsdtUsdt: 100,
      cardVnd: 1_000_000,
      cardUsdt: 30,
      actualVnd: 1_000_000,
      actualUsdt: 100,
    }));
    assert.equal(rates.vndPerUsdt, 1_000_000 / 30);
    assert.notEqual(rates.vndPerUsdt, (1_000_000 / 30 + 1_000_000 / 100) / 2);
  });

});
