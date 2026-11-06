export type Recurrence = 'ONCE' | 'DAILY' | 'WEEKLY' | 'TWICE_MONTHLY' | 'MONTHLY' | 'YEARLY';

export type RecurrenceConfig = {
  weekdays?: number[];
  intervalWeeks?: number;
  firstDay?: number;
  secondDay?: number;
  day?: number;
  month?: number;
};

const pad = (value: number) => String(value).padStart(2, '0');
const dateKey = (date: Date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
const daysInMonth = (year: number, monthIndex: number) => new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
const clampedDate = (year: number, monthIndex: number, day: number) =>
  new Date(Date.UTC(year, monthIndex, Math.min(Math.max(1, day), daysInMonth(year, monthIndex))));

function dateOnly(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error('A valid date is required.');
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function validateDay(value: number, label: string, min = 1, max = 31) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer between ${min} and ${max}.`);
}

/** Generates calendar-date occurrences. start/end are inclusive bounds; anchorDate is the original schedule start. */
export function generateOccurrences(
  recurrence: Recurrence,
  config: RecurrenceConfig,
  start: Date,
  end: Date,
  anchorDate: Date = start,
): Date[] {
  const from = dateOnly(start);
  const to = dateOnly(end);
  const anchor = dateOnly(anchorDate);
  if (from > to || anchor > to) return [];

  const result: Date[] = [];
  const add = (date: Date) => {
    if (date >= from && date <= to && date >= anchor) result.push(date);
  };

  if (recurrence === 'ONCE') {
    add(anchor);
    return result;
  }

  if (recurrence === 'DAILY') {
    const cursor = new Date(from > anchor ? from : anchor);
    for (; cursor <= to; cursor.setUTCDate(cursor.getUTCDate() + 1)) add(new Date(cursor));
    return result;
  }

  if (recurrence === 'WEEKLY') {
    const weekdays = [...new Set(config.weekdays ?? [anchor.getUTCDay()])];
    if (!weekdays.length || weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6)) {
      throw new Error('Weekdays must contain values from 0 (Sunday) to 6 (Saturday).');
    }
    const interval = config.intervalWeeks ?? 1;
    if (!Number.isInteger(interval) || interval < 1 || interval > 52) throw new Error('Weekly interval must be between 1 and 52.');
    const anchorMonday = new Date(anchor);
    anchorMonday.setUTCDate(anchorMonday.getUTCDate() - ((anchorMonday.getUTCDay() + 6) % 7));
    const cursor = new Date(from > anchor ? from : anchor);
    for (; cursor <= to; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
      if (!weekdays.includes(cursor.getUTCDay())) continue;
      const monday = new Date(cursor);
      monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
      const weeks = Math.round((monday.getTime() - anchorMonday.getTime()) / 604800000);
      if (weeks >= 0 && weeks % interval === 0) add(new Date(cursor));
    }
    return result;
  }

  const monthCursor = new Date(Date.UTC(Math.max(from.getUTCFullYear(), anchor.getUTCFullYear()), from.getUTCFullYear() === anchor.getUTCFullYear() ? Math.max(from.getUTCMonth(), anchor.getUTCMonth()) : (from.getUTCFullYear() > anchor.getUTCFullYear() ? 0 : anchor.getUTCMonth()), 1));
  const lastMonth = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));

  if (recurrence === 'TWICE_MONTHLY') {
    const first = config.firstDay ?? 1;
    const second = config.secondDay ?? 15;
    validateDay(first, 'First day');
    validateDay(second, 'Second day');
    if (first === second) throw new Error('Twice-monthly dates must be different.');
  } else if (recurrence === 'MONTHLY') {
    validateDay(config.day ?? anchor.getUTCDate(), 'Monthly day');
  } else if (recurrence === 'YEARLY') {
    validateDay(config.month ?? anchor.getUTCMonth() + 1, 'Month', 1, 12);
    validateDay(config.day ?? anchor.getUTCDate(), 'Day');
  }

  while (monthCursor <= lastMonth) {
    const year = monthCursor.getUTCFullYear();
    const month = monthCursor.getUTCMonth();
    if (recurrence === 'TWICE_MONTHLY') {
      add(clampedDate(year, month, config.firstDay ?? 1));
      add(clampedDate(year, month, config.secondDay ?? 15));
    } else if (recurrence === 'MONTHLY') {
      add(clampedDate(year, month, config.day ?? anchor.getUTCDate()));
    } else if (recurrence === 'YEARLY' && month === (config.month ?? anchor.getUTCMonth() + 1) - 1) {
      add(clampedDate(year, month, config.day ?? anchor.getUTCDate()));
    }
    monthCursor.setUTCMonth(monthCursor.getUTCMonth() + 1);
  }

  return [...new Map(result.sort((a, b) => a.getTime() - b.getTime()).map(date => [dateKey(date), date])).values()];
}

export function calculateActualBalance(openingBalance: number, receivedIncome: number, actualExpenses: number): number {
  assertFinite(openingBalance, 'Opening balance');
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

export function sumMoney(values: Array<number | string | { toString(): string }>): number {
  return roundMoney(values.reduce((sum, value) => sum + Number(value), 0));
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
