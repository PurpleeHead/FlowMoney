import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { expenseSchema } from './expenses.js';
import { MAX_STORED_AMOUNT } from '../lib/amount-limits.js';

const validExpense = {
  title: 'Groceries',
  category: 'Food',
  amount: 100,
  currency: 'VND',
};

describe('expense request validation', () => {
  it('accepts ordinary expenses within the persisted amount limit', () => {
    assert.equal(expenseSchema.safeParse(validExpense).success, true);
    assert.equal(expenseSchema.safeParse({ ...validExpense, amount: MAX_STORED_AMOUNT }).success, true);
  });

  it('rejects positive inputs below their persisted decimal precision', () => {
    assert.equal(expenseSchema.safeParse({ ...validExpense, amount: 0.0000001 }).success, false);
    assert.equal(expenseSchema.safeParse({ ...validExpense, amountVnd: 0.00001 }).success, false);
    assert.equal(expenseSchema.safeParse({ ...validExpense, targetToVndRate: 0.000000001 }).success, false);
    assert.equal(expenseSchema.safeParse({ ...validExpense, usdtCharged: 0.000000001 }).success, false);
  });

  it('rejects source amounts and optional conversions outside the supported range', () => {
    assert.equal(expenseSchema.safeParse({ ...validExpense, amount: MAX_STORED_AMOUNT + 1 }).success, false);
    assert.equal(expenseSchema.safeParse({ ...validExpense, amountVnd: MAX_STORED_AMOUNT + 1 }).success, false);
    assert.equal(expenseSchema.safeParse({ ...validExpense, targetToVndRate: MAX_STORED_AMOUNT + 1 }).success, false);
    assert.equal(expenseSchema.safeParse({ ...validExpense, usdtCharged: MAX_STORED_AMOUNT + 1 }).success, false);
  });
});
