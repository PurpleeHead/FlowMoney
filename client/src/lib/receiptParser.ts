export type ReceiptItem = { name: string; price: number; quantity: number };

const NON_ITEM_LINE = /^(?:итого|к оплате|сумма|total|subtotal|наличными|наличные|карта|сдача|скидка|discount|кассир|касса|дата|время|адрес|инн|тел\.?|чек|receipt)\b/i;
const CURRENCY_SUFFIX = /(?:₽|руб(?:\.|ля|лей)?|RUB|₫|đ|VND)$/i;

function parseAmount(raw: string): number {
  const compact = raw.replace(/\s/g, '');
  const separators = [...compact.matchAll(/[.,]/g)].map(match => match.index ?? -1);
  if (!separators.length) return Number(compact);

  const lastIndex = separators[separators.length - 1];
  const fractionLength = compact.length - lastIndex - 1;
  const hasBothSeparators = compact.includes('.') && compact.includes(',');
  const isDecimal = fractionLength > 0 && fractionLength <= 2;
  if (hasBothSeparators) {
    const decimalSeparator = compact.lastIndexOf('.') > compact.lastIndexOf(',') ? '.' : ',';
    const integer = compact.slice(0, compact.lastIndexOf(decimalSeparator)).replace(/[.,]/g, '');
    const fraction = compact.slice(compact.lastIndexOf(decimalSeparator) + 1);
    return Number(integer + '.' + fraction);
  }
  if (isDecimal) {
    const integer = compact.slice(0, lastIndex).replace(/[.,]/g, '');
    const fraction = compact.slice(lastIndex + 1);
    return Number(integer + '.' + fraction);
  }
  return Number(compact.replace(/[.,]/g, ''));
}

// Supports common Russian/English receipt rows with RUB symbols, decimal commas,
// grouped thousands and legacy VND receipts. Always ask the user to review OCR.
export function parseReceiptLines(text: string): ReceiptItem[] {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !NON_ITEM_LINE.test(line))
    .map(line => {
      const normalizedLine = line.replace(CURRENCY_SUFFIX, '').trim();
      const match = normalizedLine.match(/^(.*\S)\s+(\d[\d\s.,]*)$/);
      if (!match) return null;

      const name = match[1].replace(/[|*]+/g, ' ').replace(/\s+/g, ' ').trim();
      const price = parseAmount(match[2]);
      if (!name || !Number.isFinite(price) || price <= 0) return null;
      return { name, price, quantity: 1 };
    })
    .filter((item): item is ReceiptItem => item !== null);
}
