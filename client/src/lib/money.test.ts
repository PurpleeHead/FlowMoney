import { describe, it, expect } from 'vitest';
import { calculateActualExchangeRates, calculateExchange, calculateObservedVndPerUsdt, estimateRubFromVnd } from './money';
describe('calculateExchange', () => {
  it('records RUB to USDT even before the VND rate is known', () => {
    expect(calculateExchange({ rubSpent: 10000, usdtReceived: 100 })).toEqual({ effectiveRubPerUsdt: 100 });
  });
  it('calculates an estimated VND rate when explicitly provided', () => {
    const r = calculateExchange({ rubSpent: 10000, usdtReceived: 100, vndPerUsdt: 25000, vndFee: 50000 });
    expect(r.vndReceived).toBe(2450000); expect(r.effectiveVndPerRub).toBe(245); expect(r.effectiveRubPerUsdt).toBe(100);
  });
  it('calculates the actual rate from observed card purchases', () => {
    expect(calculateObservedVndPerUsdt([{ amountVnd: 100000, usdtCharged: 3 }])).toBeCloseTo(33333.3333, 3);
    expect(calculateObservedVndPerUsdt([{ amountVnd: 100000, usdtCharged: 3 }, { amountVnd: 200000, usdtCharged: 6 }])).toBeCloseTo(33333.3333, 3);
    expect(calculateObservedVndPerUsdt([])).toBeNull();
  });
  it('rejects invalid values', () => { expect(() => calculateExchange({ rubSpent: 0, usdtReceived: 1 })).toThrow(); });
  it('rejects fee greater than proceeds', () => { expect(() => calculateExchange({ rubSpent: 100, usdtReceived: 1, vndPerUsdt: 100, vndFee: 101 })).toThrow(); });
  it('estimates a VND purchase in RUB using observed card and exchange rates', () => {
    const vndPerUsdt = calculateObservedVndPerUsdt([{ amountVnd: 100000, usdtCharged: 3 }]);
    expect(estimateRubFromVnd(100000, vndPerUsdt, 100)).toBeCloseTo(300, 8);
    expect(estimateRubFromVnd(200000, vndPerUsdt, 100)).toBeCloseTo(600, 8);
  });
  it('returns no RUB estimate when a conversion rate is missing or invalid', () => {
    expect(estimateRubFromVnd(100000, null, 100)).toBeNull();
    expect(estimateRubFromVnd(100000, 30000, null)).toBeNull();
    expect(estimateRubFromVnd(0, 30000, 100)).toBeNull();
  });

  it('calculates the unified RUB estimate from the real three-purchase example', () => {
    const purchases = [
      { amountVnd: 55536, usdtCharged: 2.19 },
      { amountVnd: 40000, usdtCharged: 1.57 },
      { amountVnd: 722728, usdtCharged: 28.39 },
    ];
    const observedVndPerUsdt = calculateObservedVndPerUsdt(purchases);
    const rubPerUsdt = 8300 / 93.7853;
    expect(observedVndPerUsdt).toBeCloseTo(25451.4463, 3);
    expect(estimateRubFromVnd(100000, observedVndPerUsdt, rubPerUsdt)).toBeCloseTo(347.7209, 2);
  });
});


describe('actual rates for the current exchange form', () => {
  it('calculates RUB/USDT, VND/USDT and VND/RUB from the same actual amounts', () => {
    const rates = calculateActualExchangeRates({ rubSpent: 8300, usdtReceived: 93.7853, vndReceived: 2383500 });
    expect(rates.effectiveRubPerUsdt).toBeCloseTo(88.5000101, 6);
    expect(rates.effectiveVndPerUsdt).toBeCloseTo(25414.4306, 3);
    expect(rates.effectiveVndPerRub).toBeCloseTo(287.1686747, 6);
  });

  it('keeps VND rates unknown until the actual VND outcome is entered', () => {
    expect(calculateActualExchangeRates({ rubSpent: 8300, usdtReceived: 93.7853 })).toEqual({
      effectiveRubPerUsdt: 8300 / 93.7853,
      effectiveVndPerUsdt: null,
      effectiveVndPerRub: null,
    });
  });

  it('rejects invalid amounts instead of producing misleading rates', () => {
    expect(() => calculateActualExchangeRates({ rubSpent: 0, usdtReceived: 93.7853 })).toThrow();
    expect(() => calculateActualExchangeRates({ rubSpent: 8300, usdtReceived: 0 })).toThrow();
    expect(() => calculateActualExchangeRates({ rubSpent: 8300, usdtReceived: 93.7853, vndReceived: 0 })).toThrow();
  });
});
