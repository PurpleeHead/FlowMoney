export type WalletBalanceMovement = {
  currency: string;
  amountDelta: number | { toString(): string };
  kind: string;
  createdAt: Date;
};

export type WalletBalance = {
  currency: string;
  netMovement: number;
  hasOpeningBalance: boolean;
  balance: number | null;
};

export function calculateWalletBalances(movements: WalletBalanceMovement[]): WalletBalance[] {
  const currencies = [...new Set(movements.map(item => item.currency))].sort();
  return currencies.map(currency => {
    const currencyMovements = movements
      .filter(item => item.currency === currency)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const opening = currencyMovements.find(item => item.kind === 'OPENING');
    const netMovement = currencyMovements.reduce((sum, item) => sum + Number(item.amountDelta), 0);
    const balance = opening
      ? Number(opening.amountDelta) + currencyMovements
          .filter(item => item.kind !== 'OPENING' && item.createdAt >= opening.createdAt)
          .reduce((sum, item) => sum + Number(item.amountDelta), 0)
      : null;
    return { currency, netMovement, hasOpeningBalance: Boolean(opening), balance };
  });
}
