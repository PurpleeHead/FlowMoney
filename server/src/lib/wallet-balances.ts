export type WalletBalanceMovement = {
  currency: string;
  amountDelta: number | { toString(): string };
  kind: string;
  createdAt: Date;
  occurredAt: Date;
};

export type WalletBalance = {
  currency: string;
  netMovement: number;
  hasOpeningBalance: boolean;
  balance: number | null;
};

function roundAmount(value: number): number {
  return Math.round((value + Number.EPSILON) * 100_000_000) / 100_000_000;
}

export function calculateWalletBalances(movements: WalletBalanceMovement[]): WalletBalance[] {
  // Show all supported wallets even before any movement or opening snapshot exists.
  const currencies = ['RUB', 'USDT', 'VND'];
  return currencies.map(currency => {
    const currencyMovements = movements
      .filter(item => item.currency === currency)
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime());
    const opening = currencyMovements.find(item => item.kind === 'OPENING');
    const netMovement = roundAmount(currencyMovements.reduce((sum, item) => sum + Number(item.amountDelta), 0));
    const balance = opening
      ? roundAmount(Number(opening.amountDelta) + currencyMovements
          .filter(item => item.kind !== 'OPENING' && (
            item.occurredAt > opening.occurredAt ||
            (item.occurredAt.getTime() === opening.occurredAt.getTime() && item.createdAt >= opening.createdAt)
          ))
          .reduce((sum, item) => sum + Number(item.amountDelta), 0))
      : null;
    return { currency, netMovement, hasOpeningBalance: Boolean(opening), balance };
  });
}
