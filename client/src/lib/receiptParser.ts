export type ReceiptItem = { name: string; price: number; quantity: number; needsReview?: boolean };

function normalizeVndPrice(value: string): { price: number; needsReview: boolean } | null {
  const raw = value.replace(/[\s'’]/g, '');
  if (!raw || !/^[\d.,]+$/.test(raw)) return null;

  let normalized: string;
  const hasDot = raw.includes('.');
  const hasComma = raw.includes(',');

  // Vietnamese receipt prices normally use separators for thousands, not decimals.
  if (hasDot && hasComma) {
    normalized = raw.replace(/[.,]/g, '');
  } else if (hasDot || hasComma) {
    const separator = hasDot ? '.' : ',';
    const parts = raw.split(separator);
    const last = parts[parts.length - 1] ?? '';
    normalized = parts.length > 1 && last.length === 3
      ? raw.replace(/[.,]/g, '')
      : parts.length > 1 && last.length <= 2
        ? parts.slice(0, -1).join('') + '.' + last
        : raw.replace(/[.,]/g, '');
  } else {
    normalized = raw;
  }

  let price = Number(normalized);
  if (!Number.isFinite(price) || price <= 0) return null;

  // OCR sometimes appends three extra zeroes to a VND amount (e.g. 40,000 -> 40000000).
  // Use a conservative heuristic and flag the value so the user must verify it before saving.
  let needsReview = false;
  if (!hasDot && !hasComma && price >= 10_000_000 && price <= 100_000_000 && price % 1000 === 0) {
    price /= 1000;
    needsReview = true;
  }

  return { price, needsReview };
}

export function parseReceiptLines(text: string): ReceiptItem[] {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      // Prefer a price at the end of the line, with optional VND currency markers.
      const match = line.match(/^(.*?)(?:\s+|\s*[xх×]\s*)([\d][\d.,'’ ]*)\s*(?:₫|đ|VND|VNĐ)?$/i);
      if (!match) return null;

      const name = match[1].replace(/[|*]+/g, ' ').replace(/\s+/g, ' ').trim();
      const parsed = normalizeVndPrice(match[2]);
      if (!name || !parsed) return null;

      return { name, price: parsed.price, quantity: 1, ...(parsed.needsReview ? { needsReview: true } : {}) };
    })
    .filter((item): item is ReceiptItem => item !== null);
}
