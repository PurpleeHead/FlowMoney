import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { movementSchema } from './wallets.js';

describe('wallet movement request validation', () => {
  it('accepts a supported opening balance and a signed adjustment', () => {
    assert.equal(movementSchema.safeParse({ kind: 'OPENING', currency: 'USDT', amount: 93.7853 }).success, true);
    assert.equal(movementSchema.safeParse({ kind: 'ADJUSTMENT', currency: 'VND', amount: -40000 }).success, true);
  });

  it('rejects negative opening balances and zero adjustments', () => {
    assert.equal(movementSchema.safeParse({ kind: 'OPENING', currency: 'RUB', amount: -1 }).success, false);
    assert.equal(movementSchema.safeParse({ kind: 'ADJUSTMENT', currency: 'RUB', amount: 0 }).success, false);
  });

  it('rejects amounts that would be rounded by Decimal(20, 8)', () => {\n    assert.equal(movementSchema.safeParse({ kind: 'OPENING', currency: 'USDT', amount: 1.123456789 }).success, false);\n    assert.equal(movementSchema.safeParse({ kind: 'ADJUSTMENT', currency: 'USDT', amount: 0.000000001 }).success, false);\n    assert.equal(movementSchema.safeParse({ kind: 'ADJUSTMENT', currency: 'USDT', amount: 0.00000001 }).success, true);\n  });\n\n  it('rejects unsupported currencies and amounts outside the wallet precision range', () => {
    assert.equal(movementSchema.safeParse({ kind: 'OPENING', currency: 'USD', amount: 100 }).success, false);
    assert.equal(movementSchema.safeParse({ kind: 'OPENING', currency: 'VND', amount: 1_000_000_000_000 }).success, false);
    assert.equal(movementSchema.safeParse({ kind: 'ADJUSTMENT', currency: 'VND', amount: -1_000_000_000_000 }).success, false);
  });
});
