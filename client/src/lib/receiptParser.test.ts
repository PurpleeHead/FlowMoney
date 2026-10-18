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
    expect(parseReceiptLines('Banh mi 25.000 VND')).toEqual([{ name: 'Banh mi', price: 25000, quantity: 1 }]);
  });
  it('attaches a standalone price to the preceding product line', () => {
    expect(parseReceiptLines('WMCOOK. Bánh donut 85G\n18.000')).toEqual([{ name: 'WMCOOK Bánh donut', price: 18000, quantity: 1 }]);
  });
  it('preserves the detected quantity and trailing line total', () => {
    expect(parseReceiptLines('O Bánh quy kem socola x 2 10,100. 20,200')).toEqual([{ name: 'O Bánh quy kem socola', price: 20200, quantity: 2 }]);
  });
  it('preserves quantity when the price appears on the next line', () => {
    expect(parseReceiptLines('Bánh mì × 3\n75.000')).toEqual([{ name: 'Bánh mì', price: 75000, quantity: 3 }]);
  });
  it('ignores receipt totals and metadata instead of treating them as products', () => {
    expect(parseReceiptLines('WinMart 40.000\nTiền cần thanh toán 275.000\nHotline 02471066888')).toEqual([{ name: 'WinMart', price: 40000, quantity: 1 }]);
  });
  it('flags implausibly small OCR fragments for review', () => {
    expect(parseReceiptLines('Dẻ sườn bò 900')).toEqual([{ name: 'Dẻ sườn bò', price: 900, quantity: 1, needsReview: true }]);
  });
  it('corrects likely OCR-appended zeroes and flags the result for manual review', () => {
    expect(parseReceiptLines('Cafe 40000000')).toEqual([{ name: 'Cafe', price: 40000, quantity: 1, needsReview: true }]);
  });
  it('ignores lines without a recognizable product and trailing price', () => {
    expect(parseReceiptLines('THANK YOU\n0562 X 246,00), ~ZZ2 6,289')).toEqual([]);
  });
});
