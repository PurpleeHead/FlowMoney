import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateExpenseRub,
  calculateObservedVndPerUsdt,
  calculateRubPerUsdt,
  estimateRubFromVnd,
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

  it('keeps VND rate unknown until a real outcome is recorded', () => {\n    assert.equal(calculateObservedVndPerUsdt([]), null);\n    assert.equal(calculateRubPerUsdt(exchange), 8300 / 93.7853);\n  });\n\n  it('returns null rather than inventing a RUB estimate when rates are missing', () => {
    assert.equal(estimateRubFromVnd(100000, null, 88.5), null);
    assert.equal(estimateRubFromVnd(100000, 25451, null), null);
  });
});
