import { describe, expect, it } from 'vitest';
import { parseReceiptLines, parseReceiptPrintedTotal } from './receiptParser';

describe('Vietnamese receipt line parsing', () => {
  it('parses dot- and comma-separated VND thousands', () => {
    expect(parseReceiptLines('Coffee 40.000\nWater 12,000')).toEqual([
      { name: 'Coffee', price: 40000, quantity: 1 },
      { name: 'Water', price: 12000, quantity: 1 },
    ]);
  });
  it('parses repeated thousands separators without changing the amount', () => {
    expect(parseReceiptLines('Rice 1.234.567')).toEqual([{ name: 'Rice', price: 1234567, quantity: 1 }]);
  });
  it('marks mixed thousands and decimal separators for manual review', () => {
    expect(parseReceiptLines('Banh mi 12.500,50')).toEqual([{ name: 'Banh mi', price: 12500.5, quantity: 1, needsReview: true }]);
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
  it('does not confuse product names containing metadata-like substrings with metadata', () => {
    expect(parseReceiptLines('Cashew nuts 25.000\nCash 50.000\nChange 10.000')).toEqual([
      { name: 'Cashew nuts', price: 25000, quantity: 1 },
    ]);
  });
  it('keeps Vietnamese product names containing the word “diêm”', () => {
    expect(parseReceiptLines('Diêm quẹt 5.000')).toEqual([{ name: 'Diêm quẹt', price: 5000, quantity: 1 }]);
  });
  it('flags implausibly small OCR fragments for review', () => {
    expect(parseReceiptLines('Dẻ sườn bò 900')).toEqual([{ name: 'Dẻ sườn bò', price: 900, quantity: 1, needsReview: true }]);
  });
  it('corrects likely OCR-appended zeroes and flags the result for manual review', () => {
    expect(parseReceiptLines('Cafe 40000000')).toEqual([{ name: 'Cafe', price: 40000, quantity: 1, needsReview: true }]);
  });
  it('does not parse discounts, tax, service fees, refunds, cash tendered, or change as purchased items', () => {
    expect(parseReceiptLines(`Coffee 40.000
Discount -5.000
VAT 8% 3.200
Service fee 2.000
Refund -10.000
Tiền khách đưa 50.000
Tiền thừa 20.000`)).toEqual([{ name: 'Coffee', price: 40000, quantity: 1 }]);
  });

  it('ignores lines without a recognizable product and trailing price', () => {
    expect(parseReceiptLines('THANK YOU\n0562 X 246,00), ~ZZ2 6,289')).toEqual([]);
  });
});


describe('printed receipt total detection', () => {
  it('extracts a clearly labelled Vietnamese amount due', () => {
    expect(parseReceiptPrintedTotal('Banh mi 25.000\nTổng thanh toán: 25.000 ₫')).toEqual({ amount: 25000, line: 'Tổng thanh toán: 25.000 ₫' });
  });

  it('extracts English grand total labels', () => {
    expect(parseReceiptPrintedTotal('Coffee 40,000\nGrand total 40,000 VND')).toEqual({ amount: 40000, line: 'Grand total 40,000 VND' });
  });

  it('prefers the final payable total over an earlier generic total', () => {
    expect(parseReceiptPrintedTotal('Tổng cộng 120.000\nGiảm giá 12.000\nTổng thanh toán 108.000 ₫')).toEqual({
      amount: 108000,
      line: 'Tổng thanh toán 108.000 ₫',
    });
  });

  it('does not mistake subtotal, cash tendered, or change for the payable total', () => {
    expect(parseReceiptPrintedTotal('Subtotal 40.000\nCash 50.000\nChange 10.000')).toBeNull();
  });

  it('does not infer a printed total when no labelled total exists', () => {
    expect(parseReceiptPrintedTotal('Coffee 40.000\nWater 12.000')).toBeNull();
  });

  it('flags ambiguous printed totals for manual review', () => {
    expect(parseReceiptPrintedTotal('Tổng cộng 12.500,50')).toEqual({ amount: 12500.5, line: 'Tổng cộng 12.500,50', needsReview: true });
  });
});
