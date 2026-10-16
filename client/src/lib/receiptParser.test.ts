import { describe, expect, it } from 'vitest';
import { parseReceiptLines } from './receiptParser';

describe('Vietnamese receipt line parsing', () => {
  it('parses dot- and comma-separated VND thousands', () => {
    expect(parseReceiptLines('Coffee 40.000\nWater 12,000')).toEqual([
      { name: 'Coffee', price: 40000, quantity: 1 },
      { name: 'Water', price: 12000, quantity: 1 },
    ]);
  });

  it('parses prices with currency suffixes', () => {
    expect(parseReceiptLines('Banh mi 25.000 VND')).toEqual([
      { name: 'Banh mi', price: 25000, quantity: 1 },
    ]);
  });

  it('corrects likely OCR-appended zeroes and flags the result for manual review', () => {
    expect(parseReceiptLines('Cafe 40000000')).toEqual([
      { name: 'Cafe', price: 40000, quantity: 1, needsReview: true },
    ]);
  });

  it('ignores lines without a recognizable trailing price', () => {
    expect(parseReceiptLines('THANK YOU\nCOFFEE 40.000')).toEqual([
      { name: 'COFFEE', price: 40000, quantity: 1 },
    ]);
  });
});
