/** Conservative upper bound for user-entered and derived amounts persisted as Prisma Decimal values. */
export const MAX_STORED_AMOUNT = 999_999_999_999.99;

export function isSupportedStoredAmount(value: number | null | undefined): boolean {
  return value == null || (Number.isFinite(value) && Math.abs(value) <= MAX_STORED_AMOUNT);
}

export function areSupportedStoredAmounts(values: Array<number | null | undefined>): boolean {
  return values.every(isSupportedStoredAmount);
}

/** Ensure a value survives storage in Decimal(20, scale) without rounding a positive amount to zero. */
export function isRepresentableDecimal(
  value: number | null | undefined,
  scale: number,
  allowZero = false,
): boolean {
  if (value == null) return true;
  if (!Number.isInteger(scale) || scale < 0 || scale > 8 || !isSupportedStoredAmount(value)) return false;
  if (value === 0) return allowZero;
  return Math.abs(value) >= 10 ** -scale;
}

export function areRepresentableDecimals(
  values: Array<{ value: number | null | undefined; scale: number; allowZero?: boolean }>,
): boolean {
  return values.every(item => isRepresentableDecimal(item.value, item.scale, item.allowZero ?? false));
}

/** Check user-entered values have no fractional digits beyond the destination Decimal scale. */
export function hasDecimalScale(value: number, scale: number): boolean {
  if (!Number.isFinite(value) || !Number.isInteger(scale) || scale < 0 || scale > 8) return false;
  return Number(value.toFixed(scale)) === value;
}

export function haveDecimalScales(values: Array<{ value: number | null | undefined; scale: number }>): boolean {
  return values.every(item => item.value == null || hasDecimalScale(item.value, item.scale));
}
