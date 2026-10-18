import type { ReceiptItem } from './receiptParser';

/** Receipt line prices are already line totals; quantity must not be multiplied again. */
export function getReceiptSubtotal(items: readonly ReceiptItem[]): number {
  return items.reduce((sum, item) => {
    const price = item.price;
    return Number.isFinite(price) && price > 0 ? sum + price : sum;
  }, 0);
}

export function getReceiptReviewCount(items: readonly ReceiptItem[]): number {
  return items.filter((item) => item.needsReview === true).length;
}
