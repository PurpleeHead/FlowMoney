export type PurchaseObservation = { amountVnd: number; usdtCharged: number };
export type ExchangeObservation = { rubSpent: number; usdtReceived: number };
export type DirectVndObservation = { rubSpent: number; vndReceived: number };
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

/** Weighted VND/RUB rate across direct RUB→VND exchanges, actual VND outcomes, and card purchases. */
export function calculateObservedVndPerRub(input: {
  directExchanges?: DirectVndObservation[];
  actualVndExchanges?: DirectVndObservation[];
  cardPurchases?: PurchaseObservation[];
  rubPerUsdt: number | null;
}): number | null {
  let rubTotal = 0;
  let vndTotal = 0;
  for (const x of [...(input.directExchanges ?? []), ...(input.actualVndExchanges ?? [])]) {
    if (Number.isFinite(x.rubSpent) && x.rubSpent > 0 && Number.isFinite(x.vndReceived) && x.vndReceived > 0) {
      rubTotal += x.rubSpent;
      vndTotal += x.vndReceived;
    }
  }
  if (input.rubPerUsdt != null && Number.isFinite(input.rubPerUsdt) && input.rubPerUsdt > 0) {
    for (const p of input.cardPurchases ?? []) {
      if (Number.isFinite(p.amountVnd) && p.amountVnd > 0 && Number.isFinite(p.usdtCharged) && p.usdtCharged > 0) {
        vndTotal += p.amountVnd;
        rubTotal += p.usdtCharged * input.rubPerUsdt;
      }
    }
  }
  return rubTotal > 0 && vndTotal > 0 ? vndTotal / rubTotal : null;
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
export function calculateExpenseRub(input: ExpenseRubInput, rubPerUsdt: number | null, vndPerUsdt: number | null, vndPerRub: number | null = null): number | null {
  if (input.currency === 'RUB') return Number.isFinite(input.amount) && input.amount > 0 ? input.amount : null;
  if (input.currency === 'USDT') {
    return rubPerUsdt != null && Number.isFinite(rubPerUsdt) && rubPerUsdt > 0 &&
      Number.isFinite(input.amount) && input.amount > 0 ? input.amount * rubPerUsdt : null;
  }
  if (input.currency === 'VND' && input.usdtCharged != null &&
      rubPerUsdt != null && Number.isFinite(rubPerUsdt) && rubPerUsdt > 0 &&
      Number.isFinite(input.usdtCharged) && input.usdtCharged > 0) {
    return input.usdtCharged * rubPerUsdt;
  }
  if (vndPerRub != null && Number.isFinite(vndPerRub) && vndPerRub > 0 && input.amountVnd > 0) return input.amountVnd / vndPerRub;
  if (input.currency === 'VND' && input.usdtCharged != null) return null;
  return estimateRubFromVnd(input.amountVnd, vndPerUsdt, rubPerUsdt);
}


/** Resolve the VND outcome from real amounts, without inventing a rate when VND is unknown. */
export function resolveExchangeVndOutcome(input: {
  usdtReceived: number;
  vndReceived?: number | null;
  vndPerUsdt?: number | null;
}): { vndReceived: number | null; vndPerUsdt: number | null } {
  if (!Number.isFinite(input.usdtReceived) || input.usdtReceived <= 0) {
    throw new Error('USDT received must be positive.');
  }
  const vndReceived = input.vndReceived ?? null;
  const vndPerUsdt = input.vndPerUsdt ?? null;
  if (vndReceived != null && (!Number.isFinite(vndReceived) || vndReceived <= 0)) {
    throw new Error('VND received must be positive.');
  }
  if (vndPerUsdt != null && (!Number.isFinite(vndPerUsdt) || vndPerUsdt <= 0)) {
    throw new Error('VND per USDT must be positive.');
  }
  if (vndReceived == null && vndPerUsdt != null) {
    throw new Error('Actual VND received is required when a VND rate is provided.');
  }
  return {
    vndReceived,
    vndPerUsdt: vndReceived == null ? null : (vndPerUsdt ?? vndReceived / input.usdtReceived),
  };
}

/** Convert an actual amount in a target currency to the VND base used by the shared budget. */
export function calculateTargetVndEquivalent(targetCurrency: string, targetReceived: number, targetToVndRate: number | null | undefined): number {
  if (!Number.isFinite(targetReceived) || targetReceived <= 0) {
    throw new Error('Target currency received amount must be positive.');
  }
  const rate = targetCurrency.toUpperCase() === 'VND' ? 1 : targetToVndRate;
  if (rate == null || !Number.isFinite(rate) || rate <= 0) {
    throw new Error('A positive VND-per-target-currency rate is required.');
  }
  const equivalent = targetReceived * rate;
  if (!Number.isFinite(equivalent) || equivalent <= 0) {
    throw new Error('Target currency VND equivalent must be positive.');
  }
  return equivalent;
}
