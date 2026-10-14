import { describe, it, expect } from 'vitest';
import { calculateExchange, calculateObservedVndPerUsdt } from './money';
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
});
