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
});
