export type WalletCurrency = 'RUB' | 'USDT' | 'VND';

export function openingBalanceSourceKey(userId: string, currency: WalletCurrency): string {
  return `opening:${userId}:${currency}`;
}

export function adjustmentSourceKey(userId: string, id: string): string {
  return `adjustment:${userId}:${id}`;
}
