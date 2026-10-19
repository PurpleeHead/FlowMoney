export type ReceiptItem = { name: string; price: number; quantity: number; needsReview?: boolean };
export type ReceiptPrintedTotal = { amount: number; line: string; needsReview?: boolean };

/** Extract only clearly labelled receipt totals; never infer a total from item prices. */
export function parseReceiptPrintedTotal(text: string): ReceiptPrintedTotal | null {
  const totalLabel = /(?:tong\s*(?:thanh\s*toan|cong)|tien\s*can\s*thanh\s*toan|can\s*thanh\s*toan|phai\s*tra|grand\s*total|total\s*(?:due|payable)|amount\s*due|payment\s*due)/i;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+/g, ' ').trim();
    if (!line || !totalLabel.test(fold(line)) || /subtotal|tien\s*khach\s*dua|tien\s*thua/i.test(fold(line))) continue;
    const match = line.match(/([\d][\d.,'’]*(?:\s+\d{3})*)\s*(?:₫|đ|VND|VNĐ)?\s*$/i);
    if (!match) continue;
    const parsed = normalizeVndPrice(match[1]);
    if (parsed) return { amount: parsed.price, line, ...(parsed.needsReview ? { needsReview: true } : {}) };
  }
  return null;
}

function normalizeVndPrice(value: string): { price: number; needsReview: boolean } | null {
  const raw = value.replace(/[\s'’]/g, '');
  if (!raw || !/^[\d.,]+$/.test(raw)) return null;
  let normalized: string;
  const hasDot = raw.includes('.');
  const hasComma = raw.includes(',');
  let ambiguousMixedSeparator = false;
  if (hasDot && hasComma) {
    const lastSeparator = Math.max(raw.lastIndexOf('.'), raw.lastIndexOf(','));
    const fractionalDigits = raw.length - lastSeparator - 1;
    if (fractionalDigits === 1 || fractionalDigits === 2) {
      const integerPart = raw.slice(0, lastSeparator).replace(/[.,]/g, '');
      const fractionalPart = raw.slice(lastSeparator + 1);
      normalized = integerPart + '.' + fractionalPart;
      ambiguousMixedSeparator = true;
    } else {
      normalized = raw.replace(/[.,]/g, '');
    }
  }
  else if (hasDot || hasComma) {
    const separator = hasDot ? '.' : ',';
    const parts = raw.split(separator);
    const last = parts[parts.length - 1] ?? '';
    normalized = parts.length > 1 && last.length === 3
      ? raw.replace(/[.,]/g, '')
      : parts.length > 1 && last.length <= 2
        ? parts.slice(0, -1).join('') + '.' + last
        : raw.replace(/[.,]/g, '');
  } else normalized = raw;
  let price = Number(normalized);
  if (!Number.isFinite(price) || price <= 0) return null;
  let needsReview = price < 1000 || ambiguousMixedSeparator;
  if (!hasDot && !hasComma && price >= 10_000_000 && price <= 100_000_000 && price % 1000 === 0) {
    price /= 1000;
    needsReview = true;
  }
  return { price, needsReview };
}

function fold(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function isMetadataLine(text: string): boolean {
  // Monetary adjustments affect the printed payable total but are not purchased items.
  // Excluding them prevents discounts, VAT, service fees, refunds, tendered cash, and change
  // from being misread as positive product prices by the trailing-price parser.
  return /(?:tien can thanh toan|tong cong|thanh toan|phieu tinh tien|hoa don|xuat hoa don|ma so|khach hang|khach mua|hotline|truy cap|cqt|\bsubtotal\b|\btotal\b|\bthank\s+you\b|\bcash\b|\bchange\b|diem|\bdiscount\b|\bvoucher\b|\bcoupon\b|\bservice\s+charge\b|\bservice\s+fee\b|\btax\b|\bvat\b|\brefund\b|\breturn\b|giam gia|khuyen mai|chiet khau|phi dich vu|phi phuc vu|thue\\s*(?:vat|gtgt|tong)|thue\\s+\\d|thue\\s*[:%]|hoan tien|tra hang|tien khach dua|tien thua)/i.test(fold(text));
}

function parseQuantity(value: string): number {
  const match = value.match(/(?:^|\s)[xх×]\s*(\d+(?:[.,]\d+)?)\s*(?=$|\s)/i);
  if (!match) return 1;
  const quantity = Number(match[1].replace(',', '.'));
  return Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
}

function cleanItemName(value: string): string {
  return value
    .replace(/\b[xх×]\s*\d+\b/gi, ' ')
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:g|kg|ml|l)\b/gi, ' ')
    .replace(/[|*]+/g, ' ')
    .replace(/[^\p{L}\s&'’-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeItemName(value: string): boolean {
  const cleaned = cleanItemName(value);
  const letters = (cleaned.match(/\p{L}/gu) ?? []).length;
  const compact = value.replace(/\s/g, '');
  if (letters < 4 || compact.length < 4 || isMetadataLine(cleaned)) return false;
  return letters / compact.length >= 0.4;
}

function parsePriceOnly(line: string): { price: number; needsReview: boolean } | null {
  const match = line.match(/^(?:₫|đ|VND|VNĐ)?\s*([\d][\d.,'’]*(?:\s+\d{3})*)\s*(?:₫|đ|VND|VNĐ)?$/i);
  return match ? normalizeVndPrice(match[1]) : null;
}

function parsePricedItem(line: string): ReceiptItem | null {
  if (isMetadataLine(line)) return null;
  const match = line.match(/^(.*?)\s+([\d][\d.,'’]*(?:\s+\d{3})*)\s*(?:₫|đ|VND|VNĐ)?$/i);
  if (!match) return null;
  const rawName = match[1];
  // A trailing x/× count is a quantity marker, not a unit price on its own.
  if (/(?:^|\s)[xх×]\s*$/i.test(rawName)) return null;
  const name = cleanItemName(rawName);
  const parsed = normalizeVndPrice(match[2]);
  if (!parsed || !looksLikeItemName(name)) return null;
  return { name, price: parsed.price, quantity: parseQuantity(rawName), ...(parsed.needsReview ? { needsReview: true } : {}) };
}

export function parseReceiptLines(text: string): ReceiptItem[] {
  const items: ReceiptItem[] = [];
  let pendingName = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (isMetadataLine(line)) { pendingName = ''; continue; }
    const priced = parsePricedItem(line);
    if (priced) { items.push(priced); pendingName = ''; continue; }
    const priceOnly = parsePriceOnly(line);
    if (priceOnly && pendingName) {
      items.push({ name: cleanItemName(pendingName), price: priceOnly.price, quantity: parseQuantity(pendingName), ...(priceOnly.needsReview ? { needsReview: true } : {}) });
      pendingName = '';
      continue;
    }
    if (looksLikeItemName(line)) pendingName = line;
  }
  return items;
}
