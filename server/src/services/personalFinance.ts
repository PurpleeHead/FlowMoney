export type Recurrence = 'ONCE' | 'DAILY' | 'WEEKLY' | 'TWICE_MONTHLY' | 'MONTHLY' | 'YEARLY';

export type RecurrenceConfig = {
  weekdays?: number[];
  firstDay?: number;
  secondDay?: number;
  day?: number;
  month?: number;
};

const pad = (value: number) => String(value).padStart(2, '0');
const key = (date: Date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
const daysInMonth = (year: number, monthIndex: number) => new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
const clampedDate = (year: number, monthIndex: number, day: number) =>
  new Date(Date.UTC(year, monthIndex, Math.min(Math.max(1, day), daysInMonth(year, monthIndex))));

/** Generates calendar-date occurrences in UTC date-only form, inclusive of both bounds. */
export function generateOccurrences(
  recurrence: Recurrence,
  config: RecurrenceConfig,
  start: Date,
  end: Date,
): Date[] {
  const from = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const to = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  if (from > to) return [];

  const result: Date[] = [];
  const add = (date: Date) => {
    if (date >= from && date <= to) result.push(date);
  };

  if (recurrence === 'ONCE') {
    add(from);
    return result;
  }

  if (recurrence === 'DAILY') {
    for (let cursor = new Date(from); cursor <= to; cursor.setUTCDate(cursor.getUTCDate() + 1)) add(new Date(cursor));
    return result;
  }

  if (recurrence === 'WEEKLY') {
    const weekdays = [...new Set(config.weekdays ?? [from.getUTCDay()])];
    for (let cursor = new Date(from); cursor <= to; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
      if (weekdays.includes(cursor.getUTCDay())) add(new Date(cursor));
    }
    return result;
  }

  const monthCursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const lastMonth = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
  while (monthCursor <= lastMonth) {
    const year = monthCursor.getUTCFullYear();
    const month = monthCursor.getUTCMonth();
    if (recurrence === 'TWICE_MONTHLY') {
      const first = config.firstDay ?? 1;
      const second = config.secondDay ?? 15;
      if (first === second) throw new Error('Twice-monthly dates must be different.');
      add(clampedDate(year, month, first));
      add(clampedDate(year, month, second));
    } else if (recurrence === 'MONTHLY') {
      add(clampedDate(year, month, config.day ?? 1));
    } else if (recurrence === 'YEARLY' && month === (config.month ?? from.getUTCMonth() + 1) - 1) {
      add(clampedDate(year, month, config.day ?? from.getUTCDate()));
    }
    monthCursor.setUTCMonth(monthCursor.getUTCMonth() + 1);
  }

  return [...new Map(result.sort((a, b) => a.getTime() - b.getTime()).map(date => [key(date), date])).values()];
}

export function calculateActualBalance(openingBalance: number, receivedIncome: number, actualExpenses: number): number {
  assertFiniteNonNegative(openingBalance, 'Opening balance');
  assertFiniteNonNegative(receivedIncome, 'Received income');
  assertFiniteNonNegative(actualExpenses, 'Actual expenses');
  return roundMoney(openingBalance + receivedIncome - actualExpenses);
}

export function calculateForecastBalance(
  actualBalance: number,
  plannedIncome: number,
  unpaidObligations: number,
  plannedVariableExpenses = 0,
): number {
  assertFinite(actualBalance, 'Actual balance');
  assertFiniteNonNegative(plannedIncome, 'Planned income');
  assertFiniteNonNegative(unpaidObligations, 'Unpaid obligations');
  assertFiniteNonNegative(plannedVariableExpenses, 'Planned expenses');
  return roundMoney(actualBalance + plannedIncome - unpaidObligations - plannedVariableExpenses);
}

export function calculateCoverage(income: number, obligations: number) {
  assertFiniteNonNegative(income, 'Income');
  assertFiniteNonNegative(obligations, 'Obligations');
  const difference = roundMoney(income - obligations);
  return { covered: difference >= 0, difference, shortfall: difference < 0 ? Math.abs(difference) : 0, surplus: difference > 0 ? difference : 0 };
}

function assertFinite(value: number, label: string) {
  if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
}
function assertFiniteNonNegative(value: number, label: string) {
  assertFinite(value, label);
  if (value < 0) throw new Error(`${label} cannot be negative.`);
}
function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
