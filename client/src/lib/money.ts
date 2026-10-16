/** Planning fallback only; never presented as a live market quote. */
export const DEFAULT_PLANNING_VND_PER_USDT = 25450;

export function calculateBalanceEquivalents(
  balanceVnd: number | null | undefined,
  vndPerUsdt: number | null | undefined,
  vndPerRub: number | null | undefined,
): { vnd: number | null; usdt: number | null; rub: number | null } {
  if (balanceVnd == null || !Number.isFinite(balanceVnd)) return { vnd: null, usdt: null, rub: null };
  return {
    vnd: balanceVnd,
    usdt: Number.isFinite(vndPerUsdt) && Number(vndPerUsdt) > 0 ? balanceVnd / Number(vndPerUsdt) : null,
    rub: Number.isFinite(vndPerRub) && Number(vndPerRub) > 0 ? balanceVnd / Number(vndPerRub) : null,
  };
}

export type ExchangeInput = { rubSpent: number; usdtReceived: number; vndPerUsdt?: number; vndFee?: number };
export type ExchangeResult = { vndReceived?: number; effectiveVndPerRub?: number; effectiveRubPerUsdt: number; effectiveVndPerUsdt?: number };

/** Record the first conversion immediately; VND values stay unknown until an actual card purchase is observed. */
export function calculateExchange(input: ExchangeInput): ExchangeResult {
  const { rubSpent, usdtReceived, vndPerUsdt, vndFee = 0 } = input;
  if (![rubSpent, usdtReceived, vndFee].every(Number.isFinite) || rubSpent <= 0 || usdtReceived <= 0 || vndFee < 0) {
    throw new Error('Enter positive RUB/USDT amounts; fee cannot be negative.');
  }
  const effectiveRubPerUsdt = rubSpent / usdtReceived;
  if (vndPerUsdt == null || vndPerUsdt === 0) return { effectiveRubPerUsdt };
  if (!Number.isFinite(vndPerUsdt) || vndPerUsdt < 0) throw new Error('VND/USDT rate must be positive.');
  const vndReceived = usdtReceived * vndPerUsdt - vndFee;
  if (vndReceived < 0) throw new Error('Fee cannot exceed the VND amount received.');
  return { vndReceived, effectiveVndPerRub: vndReceived / rubSpent, effectiveRubPerUsdt, effectiveVndPerUsdt: vndReceived / usdtReceived };
}
export const formatMoney = (value: number, currency = 'VND', locale = 'en-US') => new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: currency === 'VND' ? 0 : 2 }).format(value);

/** Actual effective rate from purchases with a recorded card debit; weighted by USDT spent. */
export function calculateObservedVndPerUsdt(purchases: Array<{ amountVnd: number; usdtCharged: number }>): number | null {
  const valid = purchases.filter(p => Number.isFinite(p.amountVnd) && p.amountVnd > 0 && Number.isFinite(p.usdtCharged) && p.usdtCharged > 0);
  const vnd = valid.reduce((sum, p) => sum + p.amountVnd, 0);
  const usdt = valid.reduce((sum, p) => sum + p.usdtCharged, 0);
  return usdt > 0 ? vnd / usdt : null;
}

/** Estimate RUB cost from VND using the observed VND/USDT rate and the recorded RUB/USDT exchange rate. */
export function estimateRubFromVnd(amountVnd: number, vndPerUsdt: number | null | undefined, rubPerUsdt: number | null | undefined): number | null {
  if (!Number.isFinite(amountVnd) || amountVnd <= 0 || !Number.isFinite(vndPerUsdt) || !vndPerUsdt || vndPerUsdt <= 0 || !Number.isFinite(rubPerUsdt) || !rubPerUsdt || rubPerUsdt <= 0) return null;
  return amountVnd / vndPerUsdt * rubPerUsdt;
}


/** Calculate all rates for the same in-progress exchange, using only its entered amounts. */
export function calculateActualExchangeRates(input: {
  rubSpent: number;
  usdtReceived: number;
  vndReceived?: number | null;
}): { effectiveRubPerUsdt: number; effectiveVndPerUsdt: number | null; effectiveVndPerRub: number | null } {
  const { rubSpent, usdtReceived, vndReceived = null } = input;
  if (!Number.isFinite(rubSpent) || rubSpent <= 0 || !Number.isFinite(usdtReceived) || usdtReceived <= 0) {
    throw new Error('RUB spent and USDT received must be positive finite amounts.');
  }
  if (vndReceived != null && (!Number.isFinite(vndReceived) || vndReceived <= 0)) {
    throw new Error('VND received must be a positive finite amount.');
  }
  return {
    effectiveRubPerUsdt: rubSpent / usdtReceived,
    effectiveVndPerUsdt: vndReceived == null ? null : vndReceived / usdtReceived,
    effectiveVndPerRub: vndReceived == null ? null : vndReceived / rubSpent,
  };
}
