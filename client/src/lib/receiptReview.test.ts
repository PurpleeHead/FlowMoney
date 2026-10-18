import { describe, expect, it } from 'vitest';
import { getReceiptReviewCount, getReceiptSubtotal } from './receiptReview';
import type { ReceiptItem } from './receiptParser';

const item = (name: string, price: number, quantity = 1, needsReview = false): ReceiptItem => ({
  name, price, quantity, ...(needsReview ? { needsReview: true } : {}),
});

describe('receipt review helpers', () => {
  it('sums line totals without multiplying quantity again', () => {
    expect(getReceiptSubtotal([item('Coffee', 20000, 2), item('Water', 10000, 3)])).toBe(30000);
  });

  it('ignores invalid or non-positive prices in the displayed subtotal', () => {
    expect(getReceiptSubtotal([item('Coffee', 20000), item('Unknown', Number.NaN), item('Invalid', -500), item('Free', 0)])).toBe(20000);
  });

  it('counts only items explicitly marked for review', () => {
    expect(getReceiptReviewCount([item('Coffee', 20000), item('Water', 10000, 1, true), item('Rice', 50000, 2, true)])).toBe(2);
    expect(getReceiptReviewCount([])).toBe(0);
  });
});
