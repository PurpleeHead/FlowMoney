import { describe, expect, it } from 'vitest';
import { parseReceiptLines } from './receiptParser';

describe('parseReceiptLines', () => {
  it('extracts item and price from Russian ruble receipt lines', () => {
    expect(parseReceiptLines('Молоко 89,90 ₽\nХлеб 54 руб.')).toEqual([
      { name: 'Молоко', price: 89.9, quantity: 1 },
      { name: 'Хлеб', price: 54, quantity: 1 },
    ]);
  });

  it('handles grouped thousands and decimal commas', () => {
    expect(parseReceiptLines('Кофе молотый 1 250,00 руб.\nСыр 1.250 ₽')).toEqual([
      { name: 'Кофе молотый', price: 1250, quantity: 1 },
      { name: 'Сыр', price: 1250, quantity: 1 },
    ]);
  });

  it('supports English receipt rows and decimal points', () => {
    expect(parseReceiptLines('Milk 2.49 RUB\nBread 120')).toEqual([
      { name: 'Milk', price: 2.49, quantity: 1 },
      { name: 'Bread', price: 120, quantity: 1 },
    ]);
  });

  it('keeps legacy VND receipt parsing compatible', () => {
    expect(parseReceiptLines('BANH MI 25,000 VND')).toEqual([
      { name: 'BANH MI', price: 25000, quantity: 1 },
    ]);
  });

  it('ignores totals, headings and non-item lines', () => {
    expect(parseReceiptLines('ИТОГО 1 500,00 ₽\nTHANK YOU\nSTORE #12\nСдача 500')).toEqual([]);
  });

  it('returns an empty list for empty input', () => {
    expect(parseReceiptLines('')).toEqual([]);
  });
});
