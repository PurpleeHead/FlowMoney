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
  if (!Number.isFinite(rub) || !Number.isFinite(usdt) || usdt <= 0) return null;
  const rate = rub / usdt;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/** Effective VND/USDT from card purchases, weighted by USDT actually charged. */
export function calculateObservedVndPerUsdt(purchases: PurchaseObservation[]): number | null {
  const valid = purchases.filter(x =>
    Number.isFinite(x.amountVnd) && x.amountVnd > 0 &&
    Number.isFinite(x.usdtCharged) && x.usdtCharged > 0
  );
  const vnd = valid.reduce((sum, x) => sum + x.amountVnd, 0);
  const usdt = valid.reduce((sum, x) => sum + x.usdtCharged, 0);
  if (!Number.isFinite(vnd) || !Number.isFinite(usdt) || usdt <= 0) return null;
  const rate = vnd / usdt;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
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
  if (!Number.isFinite(rubTotal) || !Number.isFinite(vndTotal) || rubTotal <= 0 || vndTotal <= 0) return null;
  const rate = vndTotal / rubTotal;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
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
    // Only the indirect exchange mode or an explicitly direct USDT target represents
    // an acquisition of USDT. Ignore stale legacy fields on RUB→VND/other-target rows.
    if (!isDirectUsdt && exchange.mode !== 'RUB_USDT_VND') return [];
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
  targetReceived?: number | null;
  targetVndEquivalent?: number | null;
  targetCurrency?: string | null;
}>): DirectVndObservation[] {
  return exchanges.flatMap((exchange) => {
    if (exchange.mode === 'RUB_VND' && exchange.vndReceived != null) {
      return [{ rubSpent: exchange.rubSpent, vndReceived: exchange.vndReceived }];
    }
    if (exchange.mode === 'RUB_TARGET' && exchange.targetCurrency?.trim().toUpperCase() === 'VND') {
      // Older direct-target records may have the real VND amount in targetReceived
      // or vndReceived even when targetVndEquivalent was not populated.
      const vndReceived = exchange.targetVndEquivalent ?? exchange.targetReceived ?? exchange.vndReceived;
      if (vndReceived != null) return [{ rubSpent: exchange.rubSpent, vndReceived }];
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
  const rub = amountVnd / vndPerUsdt * rubPerUsdt;
  return Number.isFinite(rub) && rub > 0 ? rub : null;
}

/** Calculate and persist the RUB cost once, using actual debit when available, otherwise the unified estimate. */
export function calculateExpenseRub(input: ExpenseRubInput, rubPerUsdt: number | null, vndPerUsdt: number | null, vndPerRub: number | null = null): number | null {
  const currency = input.currency.trim().toUpperCase();

  // Validate the source amount before considering alternate equivalents or card debits.
  if (!Number.isFinite(input.amount) || input.amount <= 0) return null;

  if (currency === 'RUB') return input.amount;
  if (currency === 'USDT') {
    if (rubPerUsdt == null || !Number.isFinite(rubPerUsdt) || rubPerUsdt <= 0) return null;
    const rub = input.amount * rubPerUsdt;
    return Number.isFinite(rub) && rub > 0 ? rub : null;
  }

  // A recorded card debit is authoritative: never replace its unknown RUB cost with a VND/RUB forecast.
  if (currency === 'VND' && input.usdtCharged != null) {
    if (!Number.isFinite(input.usdtCharged) || input.usdtCharged <= 0 ||
        rubPerUsdt == null || !Number.isFinite(rubPerUsdt) || rubPerUsdt <= 0) {
      return null;
    }
    const rub = input.usdtCharged * rubPerUsdt;
    return Number.isFinite(rub) && rub > 0 ? rub : null;
  }

  // This helper only has conversion inputs for VND. Do not silently interpret GEL,
  // TRY, or another target currency as VND; a target-specific conversion path is required.
  if (currency !== 'VND') {
    // Other currencies may be normalized only when the caller supplied an explicit
    // target-currency → VND rate. Never reinterpret an unknown currency as VND.
    if (input.targetToVndRate == null || !Number.isFinite(input.targetToVndRate) || input.targetToVndRate <= 0 ||
        input.amountVnd == null || !Number.isFinite(input.amountVnd) || input.amountVnd <= 0) return null;
    if (vndPerRub == null || !Number.isFinite(vndPerRub) || vndPerRub <= 0) return null;
    const rub = input.amountVnd / vndPerRub;
    return Number.isFinite(rub) && rub > 0 ? rub : null;
  }

  if (input.amountVnd == null || !Number.isFinite(input.amountVnd) || input.amountVnd <= 0) return null;
  if (vndPerRub != null && Number.isFinite(vndPerRub) && vndPerRub > 0) {
    const rub = input.amountVnd / vndPerRub;
    return Number.isFinite(rub) && rub > 0 ? rub : null;
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
  // When actual VND is known, derive the observed rate from the actual net amount.
  // A user-entered rate is only a consistency guard; it must not override recorded facts.
  const observedRate = vndReceived == null ? null : vndReceived / input.usdtReceived;
  if (observedRate != null && (!Number.isFinite(observedRate) || observedRate <= 0)) {
    throw new Error('Observed VND per USDT rate must be finite and positive.');
  }
  return { vndReceived, vndPerUsdt: observedRate };
}

/** Convert an actual amount in a target currency to the VND base used by the shared budget. */
export function calculateTargetVndEquivalent(targetCurrency: string, targetReceived: number, targetToVndRate: number | null | undefined): number {
  if (!Number.isFinite(targetReceived) || targetReceived <= 0) {
    throw new Error('Target currency received amount must be positive.');
  }
  const rate = targetCurrency.trim().toUpperCase() === 'VND' ? 1 : targetToVndRate;
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


/** Map indirect exchange records with an actual VND outcome; direct target-currency
 * records are valued separately and must not be counted a second time. */
export function mapActualVndExchanges(exchanges: Array<{
  mode: string;
  rubSpent: number;
  vndReceived?: number | null;
  targetCurrency?: string | null;
}>): DirectVndObservation[] {
  return exchanges.flatMap((exchange) => {
    // Only the documented indirect mode is evidence for an indirect VND/RUB
    // outcome. Direct-target rows and unknown legacy modes may contain stale
    // vndReceived fields, which must never influence historical rates.
    if (exchange.mode !== 'RUB_USDT_VND' || exchange.vndReceived == null) return [];
    return [{ rubSpent: exchange.rubSpent, vndReceived: exchange.vndReceived }];
  });
}


/** Only completed RUB→USDT→VND exchanges are observations of the VND/USDT rate. */
export function mapActualVndUsdtExchanges(exchanges: Array<{
  mode: string;
  usdtReceived?: number | null;
  vndReceived?: number | null;
}>): Array<{ usdtReceived: number; vndReceived: number }> {
  return exchanges.flatMap((exchange) => {
    if (exchange.mode !== 'RUB_USDT_VND' ||
        exchange.usdtReceived == null || exchange.vndReceived == null ||
        !Number.isFinite(exchange.usdtReceived) || exchange.usdtReceived <= 0 ||
        !Number.isFinite(exchange.vndReceived) || exchange.vndReceived <= 0) return [];
    return [{ usdtReceived: exchange.usdtReceived, vndReceived: exchange.vndReceived }];
  });
}
