import type { Prisma } from '@prisma/client';

type AmountLike = number | { toString(): string } | null | undefined;

type ExpenseLedgerSource = {
  id: string;
  userId: string;
  amount: AmountLike;
  currency: string;
  usdtCharged: AmountLike;
  date: Date;
};

type ExchangeLedgerSource = {
  id: string;
  userId: string;
  mode: string;
  rubSpent: AmountLike;
  usdtReceived: AmountLike;
  vndReceived: AmountLike;
  targetCurrency: string;
  targetReceived: AmountLike;
  createdAt: Date;
};

export type LedgerMovementDraft = {
  userId: string;
  currency: string;
  amountDelta: number;
  kind: 'EXPENSE' | 'EXCHANGE';
  sourceKey: string;
  occurredAt: Date;
  note: string;
};

function amount(value: AmountLike): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function expenseLedgerDrafts(expense: ExpenseLedgerSource): LedgerMovementDraft[] {
  const sourceAmount = amount(expense.amount);
  const currency = expense.currency.trim().toUpperCase();
  // A USDT card debit is valid only for VND-denominated expenses. Ignore
  // stale/malformed usdtCharged values on RUB or USDT expenses.
  const cardDebit = currency === 'VND' ? amount(expense.usdtCharged) : null;
  const debitCurrency = cardDebit != null ? 'USDT' : currency;
  const debitAmount = cardDebit ?? sourceAmount;

  if (debitAmount == null || !['RUB', 'USDT', 'VND'].includes(debitCurrency)) return [];

  return [{
    userId: expense.userId,
    currency: debitCurrency,
    amountDelta: -debitAmount,
    kind: 'EXPENSE',
    sourceKey: `expense:${expense.id}:${debitCurrency}`,
    occurredAt: expense.date,
    note: `Expense ${expense.id}`,
  }];
}

export function exchangeLedgerDrafts(exchange: ExchangeLedgerSource): LedgerMovementDraft[] {
  const movements: LedgerMovementDraft[] = [];
  const rubSpent = amount(exchange.rubSpent);
  if (rubSpent != null) {
    movements.push({
      userId: exchange.userId, currency: 'RUB', amountDelta: -rubSpent, kind: 'EXCHANGE',
      sourceKey: `exchange:${exchange.id}:RUB`, occurredAt: exchange.createdAt,
      note: `Exchange ${exchange.id}`,
    });
  }

  if (exchange.mode === 'RUB_VND') {
    // Prefer the net VND outcome. Legacy targetReceived may contain the gross amount before fees.
    const vnd = exchange.vndReceived != null
      ? amount(exchange.vndReceived)
      : amount(exchange.targetReceived);
    if (vnd != null) movements.push({
      userId: exchange.userId, currency: 'VND', amountDelta: vnd, kind: 'EXCHANGE',
      sourceKey: `exchange:${exchange.id}:VND`, occurredAt: exchange.createdAt,
      note: `Exchange ${exchange.id}`,
    });
    return movements;
  }

  if (exchange.mode === 'RUB_TARGET') {
    const targetCurrency = exchange.targetCurrency.trim().toUpperCase();
    const targetAmount = amount(exchange.targetReceived);
    if (targetAmount != null && ['USDT', 'VND'].includes(targetCurrency)) {
      movements.push({
        userId: exchange.userId, currency: targetCurrency, amountDelta: targetAmount, kind: 'EXCHANGE',
        sourceKey: `exchange:${exchange.id}:${targetCurrency}`, occurredAt: exchange.createdAt,
        note: `Exchange ${exchange.id}`,
      });
    }
    return movements;
  }

  // Only the documented indirect exchange mode has USDT/VND receipt legs.
  // Unknown legacy modes must not be interpreted as RUB_USDT_VND.
  if (exchange.mode !== 'RUB_USDT_VND') return movements;

  const usdt = amount(exchange.usdtReceived);
  if (usdt != null) movements.push({
    userId: exchange.userId, currency: 'USDT', amountDelta: usdt, kind: 'EXCHANGE',
    sourceKey: `exchange:${exchange.id}:USDT`, occurredAt: exchange.createdAt,
    note: `Exchange ${exchange.id}`,
  });

  const vnd = amount(exchange.vndReceived);
  if (vnd != null) movements.push({
    userId: exchange.userId, currency: 'VND', amountDelta: vnd, kind: 'EXCHANGE',
    sourceKey: `exchange:${exchange.id}:VND`, occurredAt: exchange.createdAt,
    note: `Exchange ${exchange.id}`,
  });
  return movements;
}

export async function syncExpenseLedger(
  tx: Prisma.TransactionClient,
  expense: ExpenseLedgerSource,
): Promise<void> {
  await tx.walletMovement.deleteMany({
    where: { userId: expense.userId, sourceKey: { startsWith: `expense:${expense.id}:` } },
  });
  const drafts = expenseLedgerDrafts(expense);
  if (drafts.length) await tx.walletMovement.createMany({ data: drafts });
}

export async function syncExchangeLedger(
  tx: Prisma.TransactionClient,
  exchange: ExchangeLedgerSource,
): Promise<void> {
  await tx.walletMovement.deleteMany({
    where: { userId: exchange.userId, sourceKey: { startsWith: `exchange:${exchange.id}:` } },
  });
  const drafts = exchangeLedgerDrafts(exchange);
  if (drafts.length) await tx.walletMovement.createMany({ data: drafts });
}

export async function removeExpenseLedger(
  tx: Prisma.TransactionClient,
  userId: string,
  expenseId: string,
): Promise<void> {
  await tx.walletMovement.deleteMany({
    where: { userId, sourceKey: { startsWith: `expense:${expenseId}:` } },
  });
}

export async function removeExchangeLedger(
  tx: Prisma.TransactionClient,
  userId: string,
  exchangeId: string,
): Promise<void> {
  await tx.walletMovement.deleteMany({
    where: { userId, sourceKey: { startsWith: `exchange:${exchangeId}:` } },
  });
}
