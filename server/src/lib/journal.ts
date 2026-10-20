export type JournalExpense = {
  id: string;
  title: string;
  category: string;
  amount: number | { toString(): string };
  currency: string;
  amountVnd: number | { toString(): string } | null;
  amountRub: number | { toString(): string } | null;
  usdtCharged: number | { toString(): string } | null;
  date: Date | string;
  createdAt: Date | string;
};

export type JournalExchange = {
  id: string;
  mode: string;
  rubSpent: number | { toString(): string };
  usdtReceived: number | { toString(): string } | null;
  vndReceived: number | { toString(): string } | null;
  targetCurrency: string;
  targetReceived: number | { toString(): string } | null;
  targetVndEquivalent: number | { toString(): string } | null;
  createdAt: Date | string;
};

export type JournalWalletMovement = {
  id: string;
  currency: string;
  amountDelta: number | { toString(): string };
  kind: string;
  note: string | null;
  occurredAt: Date | string;
};

export type JournalEntry =
  | {
      id: string; type: 'expense'; occurredAt: string; title: string; category: string;
      amount: number; currency: string; amountVnd: number | null; amountRub: number | null;
      usdtCharged: number | null;
    }
  | {
      id: string; type: 'exchange'; occurredAt: string; title: string; mode: string;
      rubSpent: number; usdtReceived: number | null; vndReceived: number | null;
      targetCurrency: string; targetReceived: number | null; targetVndEquivalent: number | null;
    }
  | {
      id: string; type: 'wallet_movement'; occurredAt: string; title: string;
      currency: string; amountDelta: number; kind: string; note: string | null;
    };

function numeric(value: number | { toString(): string } | null): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

export function buildJournal(
  expenses: JournalExpense[],
  exchanges: JournalExchange[],
  limit = 100,
  movements: JournalWalletMovement[] = [],
): JournalEntry[] {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(501, Math.floor(limit))) : 100;
  const expenseEntries: JournalEntry[] = expenses.map((expense) => ({
    id: `expense:${expense.id}`,
    type: 'expense',
    occurredAt: iso(expense.date),
    title: expense.title,
    category: expense.category,
    amount: numeric(expense.amount) ?? 0,
    currency: expense.currency,
    amountVnd: numeric(expense.amountVnd),
    amountRub: numeric(expense.amountRub),
    usdtCharged: numeric(expense.usdtCharged),
  }));
  const exchangeEntries: JournalEntry[] = exchanges.map((exchange) => ({
    id: `exchange:${exchange.id}`,
    type: 'exchange',
    occurredAt: iso(exchange.createdAt),
    title: exchange.mode === 'RUB_VND'
      ? 'RUB → VND exchange'
      : exchange.mode === 'RUB_TARGET'
        ? `RUB → ${exchange.targetCurrency} exchange`
        : 'RUB → USDT exchange',
    mode: exchange.mode,
    rubSpent: numeric(exchange.rubSpent) ?? 0,
    usdtReceived: numeric(exchange.usdtReceived),
    vndReceived: numeric(exchange.vndReceived),
    targetCurrency: exchange.targetCurrency,
    targetReceived: numeric(exchange.targetReceived),
    targetVndEquivalent: numeric(exchange.targetVndEquivalent),
  }));
  const movementEntries: JournalEntry[] = movements.map((movement) => ({
    id: `movement:${movement.id}`,
    type: 'wallet_movement',
    occurredAt: iso(movement.occurredAt),
    title: movement.kind === 'OPENING' ? 'Opening balance' : 'Balance adjustment',
    currency: movement.currency,
    amountDelta: numeric(movement.amountDelta) ?? 0,
    kind: movement.kind,
    note: movement.note,
  }));
  return [...expenseEntries, ...exchangeEntries, ...movementEntries]
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, safeLimit);
}
