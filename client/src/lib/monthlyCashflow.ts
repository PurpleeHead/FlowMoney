export type MonthlyCashflowInput = {
  income: number;
  expenses: number;
  paidObligations: number;
  unpaidObligations: number;
};

export type MonthlyCashflow = {
  income: number;
  totalOutflow: number;
  paidObligations: number;
  regularExpenses: number;
  availableBalance: number;
  unpaidObligations: number;
  afterPlannedPayments: number;
};

export function calculateMonthlyCashflow(input: MonthlyCashflowInput): MonthlyCashflow {
  const income = Number.isFinite(input.income) ? input.income : 0;
  const totalOutflow = Number.isFinite(input.expenses) ? input.expenses : 0;
  const paidObligations = Math.max(0, Number.isFinite(input.paidObligations) ? input.paidObligations : 0);
  const unpaidObligations = Math.max(0, Number.isFinite(input.unpaidObligations) ? input.unpaidObligations : 0);
  // Obligation payments are already written to the ledger as expenses.
  // Split them out for display, but subtract the ledger total only once.
  const regularExpenses = Math.max(0, totalOutflow - paidObligations);
  const availableBalance = income - totalOutflow;

  return {
    income,
    totalOutflow,
    paidObligations,
    regularExpenses,
    availableBalance,
    unpaidObligations,
    afterPlannedPayments: availableBalance - unpaidObligations,
  };
}
