import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { itemSchema } from './receipts.js';

describe('receipt item request validation', () => {
  const validItem = { name: 'Cà phê', price: 25000, quantity: 1, currency: 'VND', amountVnd: 25000 };

  it('accepts ordinary receipt items within persisted precision', () => {
    assert.equal(itemSchema.safeParse(validItem).success, true);
    assert.equal(itemSchema.safeParse({ ...validItem, price: 0.000001 }).success, true);
  });

  it('rejects item values that exceed their Decimal column scale', () => {
    assert.equal(itemSchema.safeParse({ ...validItem, price: 1.1234567 }).success, false);
    assert.equal(itemSchema.safeParse({ ...validItem, amountVnd: 25000.00001 }).success, false);
  });

  it('rejects item values too small for the persisted precision', () => {
    assert.equal(itemSchema.safeParse({ ...validItem, price: 0.0000001 }).success, false);
    assert.equal(itemSchema.safeParse({ ...validItem, amountVnd: 0.00001 }).success, false);
  });
});
