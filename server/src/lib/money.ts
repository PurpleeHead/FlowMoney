export type PurchaseObservation = { amountVnd: number; usdtCharged: number };
export type ExchangeObservation = { rubSpent: number; usdtReceived: number };
export type ExpenseRubInput = {
  currency: string;
  amount: number;
  amountVnd: number;
  usdtCharged?: number | null;
};

/** Effective RUB/USDT from all recorded RUB -> USDT conversions, weighted by USDT received. */
export function calculateRubPerUsdt(exchanges: ExchangeObservation[]): number | null {
  const valid = exchanges.filter(x =>
    Number.isFinite(x.rubSpent) && x.rubSpent > 0 &&
    Number.isFinite(x.usdtReceived) && x.usdtReceived > 0
  );
  const rub = valid.reduce((sum, x) => sum + x.rubSpent, 0);
  const usdt = valid.reduce((sum, x) => sum + x.usdtReceived, 0);
  return usdt > 0 ? rub / usdt : null;
}

/** Effective VND/USDT from card purchases, weighted by USDT actually charged. */
export function calculateObservedVndPerUsdt(purchases: PurchaseObservation[]): number | null {
  const valid = purchases.filter(x =>
    Number.isFinite(x.amountVnd) && x.amountVnd > 0 &&
    Number.isFinite(x.usdtCharged) && x.usdtCharged > 0
  );
  const vnd = valid.reduce((sum, x) => sum + x.amountVnd, 0);
  const usdt = valid.reduce((sum, x) => sum + x.usdtCharged, 0);
  return usdt > 0 ? vnd / usdt : null;
}

/**
 * Unified budget formula:
 * RUB = VND purchase / observed VND-per-USDT * effective RUB-per-USDT.
 * If the card's actual USDT debit is known, use that exact debit instead.
 */
export function estimateRubFromVnd(
  amountVnd: number,
  vndPerUsdt: number | null | undefined,
  rubPerUsdt: number | null | undefined,
): number | null {
  if (!Number.isFinite(amountVnd) || amountVnd <= 0 ||
      !Number.isFinite(vndPerUsdt) || !vndPerUsdt || vndPerUsdt <= 0 ||
      !Number.isFinite(rubPerUsdt) || !rubPerUsdt || rubPerUsdt <= 0) return null;
  return amountVnd / vndPerUsdt * rubPerUsdt;
}

/** Calculate and persist the RUB cost once, using actual debit when available, otherwise the unified estimate. */
export function calculateExpenseRub(input: ExpenseRubInput, rubPerUsdt: number | null, vndPerUsdt: number | null): number | null {
  if (input.currency === 'RUB') return Number.isFinite(input.amount) && input.amount > 0 ? input.amount : null;
  if (input.currency === 'USDT') {
    return rubPerUsdt != null && Number.isFinite(rubPerUsdt) && rubPerUsdt > 0 &&
      Number.isFinite(input.amount) && input.amount > 0 ? input.amount * rubPerUsdt : null;
  }
  if (input.currency === 'VND' && input.usdtCharged != null) {
    return rubPerUsdt != null && Number.isFinite(rubPerUsdt) && rubPerUsdt > 0 &&
      Number.isFinite(input.usdtCharged) && input.usdtCharged > 0
      ? input.usdtCharged * rubPerUsdt : null;
  }
  return estimateRubFromVnd(input.amountVnd, vndPerUsdt, rubPerUsdt);
}
