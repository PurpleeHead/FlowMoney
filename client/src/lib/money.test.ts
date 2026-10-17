import { describe, it, expect } from 'vitest';
import { calculateActualExchangeRates, calculateBalanceEquivalents, calculateExchange, calculateObservedVndPerUsdt, estimateRubFromVnd, parseAmountInput } from './money';
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


describe('balance currency equivalents', () => {
  it('converts one remaining budget into RUB, USDT and VND equivalents', () => {
    expect(calculateBalanceEquivalents(2800000, 28000, 280)).toEqual({ vnd: 2800000, usdt: 100, rub: 10000 });
  });
  it('does not invent a balance before an exchange is recorded', () => {
    expect(calculateBalanceEquivalents(null, 25450, 287)).toEqual({ vnd: null, usdt: null, rub: null });
  });
  it('keeps equivalents unavailable when their rates are missing', () => {
    expect(calculateBalanceEquivalents(100000, null, null)).toEqual({ vnd: 100000, usdt: null, rub: null });
  });
});

describe('parseAmountInput', () => {
  it('accepts decimal points and decimal commas', () => {
    expect(parseAmountInput('2.19')).toBe('2.19');
    expect(parseAmountInput('2,19')).toBe('2.19');
    expect(parseAmountInput('93.7853')).toBe('93.7853');
  });
  it('preserves large amounts formatted with spaces while typing', () => {\n    expect(parseAmountInput('10 000 000')).toBe('10000000');\n    expect(parseAmountInput('1 000 000')).toBe('1000000');\n    expect(parseAmountInput('10 000 000,25')).toBe('10000000.25');\n  });\n  it('preserves large RUB amounts when grouped with dots', () => {
    expect(parseAmountInput('1.000')).toBe('1000');
    expect(parseAmountInput('10.000')).toBe('10000');
    expect(parseAmountInput('100.000')).toBe('100000');
    expect(parseAmountInput('1.000.000')).toBe('1000000');
  });
  it('accepts thousands separators without shrinking the amount', () => {
    expect(parseAmountInput('25,450')).toBe('25450');
    expect(parseAmountInput('2,500,000')).toBe('2500000');
    expect(parseAmountInput('2.500.000')).toBe('2500000');
    expect(parseAmountInput('1.234,56')).toBe('1234.56');
    expect(parseAmountInput('1,234.56')).toBe('1234.56');
  });
});
