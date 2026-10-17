/** Conservative bound for user-entered and derived amounts persisted as Prisma Decimal values.
 * Keeping all financial inputs below 1e12 also avoids unsafe intermediate JS-number arithmetic.
 */
export const MAX_STORED_AMOUNT = 999_999_999_999.99;

export function isSupportedStoredAmount(value: number | null | undefined): boolean {
  return value == null || (Number.isFinite(value) && Math.abs(value) <= MAX_STORED_AMOUNT);
}

export function areSupportedStoredAmounts(values: Array<number | null | undefined>): boolean {
  return values.every(isSupportedStoredAmount);
}
