export type PurchaseObservation = { amountVnd: number; usdtCharged: number };
export type ExchangeObservation = { rubSpent: number; usdtReceived: number };
export type DirectVndObservation = { rubSpent: number; vndReceived: number };
export type ExpenseRubInput = {
  currency: string;
  amount: number;
  amountVnd: number | null;
  usdtCharged?: number | null;
  targetToVndRate?: number | null;
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


/** Normalize every recorded RUB→USDT acquisition, including direct target-currency exchanges. */
export function mapRubUsdtExchanges(exchanges: Array<{
  mode: string;
  rubSpent: number;
  usdtReceived?: number | null;
  targetCurrency?: string | null;
  targetReceived?: number | null;
}>): ExchangeObservation[] {
  return exchanges.flatMap((exchange) => {
    const isDirectUsdt = exchange.mode === 'RUB_TARGET' &&
      exchange.targetCurrency?.trim().toUpperCase() === 'USDT';
    const usdtReceived = isDirectUsdt ? exchange.targetReceived : exchange.usdtReceived;
    if (usdtReceived == null || !Number.isFinite(exchange.rubSpent) || exchange.rubSpent <= 0 ||
        !Number.isFinite(usdtReceived) || usdtReceived <= 0) return [];
    return [{ rubSpent: exchange.rubSpent, usdtReceived }];
  });
}

/** Convert exchange records into direct RUB-to-VND observations for historical-rate calculations. */
export function mapDirectVndExchanges(exchanges: Array<{
  mode: string;
  rubSpent: number;
  vndReceived?: number | null;
  targetVndEquivalent?: number | null;
  targetCurrency?: string | null;
}>): DirectVndObservation[] {
  return exchanges.flatMap((exchange) => {
    if (exchange.mode === 'RUB_VND' && exchange.vndReceived != null) {
      return [{ rubSpent: exchange.rubSpent, vndReceived: exchange.vndReceived }];
    }
    if (exchange.mode === 'RUB_TARGET' && exchange.targetCurrency?.trim().toUpperCase() === 'VND' && exchange.targetVndEquivalent != null) {
      return [{ rubSpent: exchange.rubSpent, vndReceived: exchange.targetVndEquivalent }];
    }
    return [];
  });
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
  const currency = input.currency.trim().toUpperCase();

  // Validate the source amount before considering alternate equivalents or card debits.
  if (!Number.isFinite(input.amount) || input.amount <= 0) return null;

  if (currency === 'RUB') return input.amount;
  if (currency === 'USDT') {
    return rubPerUsdt != null && Number.isFinite(rubPerUsdt) && rubPerUsdt > 0 &&
      Number.isFinite(input.amount) && input.amount > 0 ? input.amount * rubPerUsdt : null;
  }

  // A recorded card debit is authoritative: never replace its unknown RUB cost with a VND/RUB forecast.
  if (currency === 'VND' && input.usdtCharged != null) {
    if (!Number.isFinite(input.usdtCharged) || input.usdtCharged <= 0 ||
        rubPerUsdt == null || !Number.isFinite(rubPerUsdt) || rubPerUsdt <= 0) {
      return null;
    }
    return input.usdtCharged * rubPerUsdt;
  }

  // This helper only has conversion inputs for VND. Do not silently interpret GEL,
  // TRY, or another target currency as VND; a target-specific conversion path is required.
  if (currency !== 'VND') {
    // Other currencies may be normalized only when the caller supplied an explicit
    // target-currency → VND rate. Never reinterpret an unknown currency as VND.
    if (input.targetToVndRate == null || !Number.isFinite(input.targetToVndRate) || input.targetToVndRate <= 0 ||
        input.amountVnd == null || !Number.isFinite(input.amountVnd) || input.amountVnd <= 0) return null;
    return vndPerRub != null && Number.isFinite(vndPerRub) && vndPerRub > 0
      ? input.amountVnd / vndPerRub
      : null;
  }

  if (input.amountVnd == null || !Number.isFinite(input.amountVnd) || input.amountVnd <= 0) return null;
  if (vndPerRub != null && Number.isFinite(vndPerRub) && vndPerRub > 0) {
    return input.amountVnd / vndPerRub;
  }
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
    // When actual VND is known, derive the observed rate from the actual net amount.
    // A user-entered rate is only a consistency guard; it must not override recorded facts.
    vndPerUsdt: vndReceived == null ? null : vndReceived / input.usdtReceived,
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

/** Reject impossible actual VND outcomes when a manual rate was also supplied. */
export function isExchangeVndOutcomeConsistent(input: {
  usdtReceived: number;
  vndReceived?: number | null;
  vndPerUsdt?: number | null;
  vndFee: number;
}): boolean {
  if (input.vndReceived == null) return input.vndFee === 0;
  if (!Number.isFinite(input.vndReceived) || input.vndReceived <= 0 ||
      !Number.isFinite(input.vndFee) || input.vndFee < 0 || input.vndFee >= input.vndReceived) return false;
  if (input.vndPerUsdt == null) return true;
  const grossVnd = input.usdtReceived * input.vndPerUsdt;
  return Number.isFinite(grossVnd) && grossVnd > 0 &&
    input.vndReceived <= grossVnd + 0.01;
}
