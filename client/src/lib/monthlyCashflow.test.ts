import { describe, expect, it } from 'vitest';
import { calculateMonthlyCashflow } from './monthlyCashflow';

describe('calculateMonthlyCashflow', () => {
  it('subtracts paid commitments and everyday expenses exactly once', () => {
    const result = calculateMonthlyCashflow({
      income: 80000,
      expenses: 31500,
      paidObligations: 20000,
      unpaidObligations: 10000,
    });

    expect(result).toEqual({
      income: 80000,
      totalOutflow: 31500,
      paidObligations: 20000,
      regularExpenses: 11500,
      availableBalance: 48500,
      unpaidObligations: 10000,
      afterPlannedPayments: 38500,
    });
  });

  it('keeps unpaid commitments separate until they are confirmed as paid', () => {
    const result = calculateMonthlyCashflow({
      income: 50000,
      expenses: 5000,
      paidObligations: 0,
      unpaidObligations: 12000,
    });

    expect(result.availableBalance).toBe(45000);
    expect(result.afterPlannedPayments).toBe(33000);
  });

  it('supports negative cashflow without hiding the deficit', () => {
    const result = calculateMonthlyCashflow({
      income: 10000,
      expenses: 14000,
      paidObligations: 4000,
      unpaidObligations: 2000,
    });

    expect(result.availableBalance).toBe(-4000);
    expect(result.afterPlannedPayments).toBe(-6000);
    expect(result.regularExpenses).toBe(10000);
  });

  it('normalizes missing or invalid numbers to zero', () => {
    const result = calculateMonthlyCashflow({
      income: Number.NaN,
      expenses: Number.POSITIVE_INFINITY,
      paidObligations: Number.NaN,
      unpaidObligations: -100,
    });

    expect(result.availableBalance).toBe(0);
    expect(result.regularExpenses).toBe(0);
    expect(result.afterPlannedPayments).toBe(0);
  });
});
