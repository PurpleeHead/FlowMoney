export type WalletBalanceMovement = {
  currency: string;
  amountDelta: number | string | { toString(): string };
  kind: string;
  createdAt: Date;
  occurredAt: Date;
};

export type WalletBalance = {
  currency: string;
  /** Exact decimal string at up to 8 fractional places; avoids JSON number precision loss. */
  netMovement: string;
  hasOpeningBalance: boolean;
  /** Exact decimal string, or null until an opening snapshot exists. */
  balance: string | null;
};

const SCALE = 8;
const UNIT = 10n ** BigInt(SCALE);

function decimalUnits(value: number | string | { toString(): string }): bigint {
  const raw = String(value);
  const match = raw.match(/^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
  if (!match) throw new Error('Invalid wallet movement amount.');
  const sign = match[1] === '-' ? -1n : 1n;
  const fraction = match[3] ?? '';
  const exponent = Number(match[4] ?? 0);
  const digits = BigInt((match[2] + fraction).replace(/^0+(?=\d)/, ''));
  const shift = SCALE + exponent - fraction.length;
  if (shift >= 0) return sign * digits * (10n ** BigInt(shift));
  const divisor = 10n ** BigInt(-shift);
  if (digits % divisor !== 0n) throw new Error('Wallet movement exceeds 8 decimal places.');
  return sign * (digits / divisor);
}

function formatUnits(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / UNIT;
  const fraction = (absolute % UNIT).toString().padStart(SCALE, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toString()}${fraction ? `.${fraction}` : ''}`;
}

export function calculateWalletBalances(movements: WalletBalanceMovement[]): WalletBalance[] {
  // Show all supported wallets even before any movement or opening snapshot exists.
  const currencies = ['RUB', 'USDT', 'VND'];
  return currencies.map(currency => {
    const currencyMovements = movements
      .filter(item => item.currency === currency)
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime());
    const opening = currencyMovements.find(item => item.kind === 'OPENING');
    const netMovement = currencyMovements.reduce((sum, item) => sum + decimalUnits(item.amountDelta), 0n);
    const balance = opening
      ? decimalUnits(opening.amountDelta) + currencyMovements
          .filter(item => item.kind !== 'OPENING' && (
            item.occurredAt > opening.occurredAt ||
            (item.occurredAt.getTime() === opening.occurredAt.getTime() && item.createdAt >= opening.createdAt)
          ))
          .reduce((sum, item) => sum + decimalUnits(item.amountDelta), 0n)
      : null;
    return {
      currency,
      netMovement: formatUnits(netMovement),
      hasOpeningBalance: Boolean(opening),
      balance: balance == null ? null : formatUnits(balance),
    };
  });
}
