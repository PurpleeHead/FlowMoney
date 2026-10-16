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
