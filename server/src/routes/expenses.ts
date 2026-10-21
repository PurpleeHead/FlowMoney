import { Router } from 'express';
import { parseListPageQuery, encodeListCursor, listAfterCursor } from '../lib/list-pagination.js';
import { z } from 'zod';
import { prisma } from '../services/prisma.js';
import { auth } from '../middleware/auth.js';
import type { AuthedRequest } from '../types.js';
import { calculateExpenseRub } from '../lib/money.js';
import { getDateAwareValuationAggregate } from '../lib/date-aware-valuation-aggregates.js';
import { calculateDateAwareValuationRates } from '../lib/date-aware-valuation-rates.js';
import { syncExpenseLedger, removeExpenseLedger } from '../lib/wallet-ledger.js';
import { areRepresentableDecimals, areSupportedStoredAmounts, hasDecimalScale, MAX_STORED_AMOUNT } from '../lib/amount-limits.js';

const router = Router();
router.use(auth);

export const expenseSchema = z.object({
  title: z.string().trim().min(1).max(140),
  category: z.string().trim().min(1).max(80),
  amount: z.number().positive().finite().min(0.000001).max(MAX_STORED_AMOUNT).refine(value => hasDecimalScale(value, 6), 'Amount supports at most 6 decimal places.'),
  currency: z.string().trim().min(3).max(8),
  amountVnd: z.number().positive().finite().min(0.0001).max(MAX_STORED_AMOUNT).refine(value => hasDecimalScale(value, 4), 'VND amount supports at most 4 decimal places.').nullable().optional(),
  targetToVndRate: z.number().positive().finite().min(0.00000001).max(MAX_STORED_AMOUNT).refine(value => hasDecimalScale(value, 8), 'Target rate supports at most 8 decimal places.').nullable().optional(),
  usdtCharged: z.number().positive().finite().min(0.00000001).max(MAX_STORED_AMOUNT).refine(value => hasDecimalScale(value, 8), 'USDT charge supports at most 8 decimal places.').nullable().optional(),
  date: z.string().datetime().optional(),
  receiptId: z.string().optional(),
}).superRefine((value, ctx) => {
  const currency = value.currency.trim().toUpperCase();
  // These source values are also copied directly into Decimal(20, 4) valuation columns.
  if (currency === 'RUB' && !hasDecimalScale(value.amount, 4)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['amount'], message: 'RUB expenses support at most 4 decimal places.' });
  }
  if (currency === 'VND' && !hasDecimalScale(value.amount, 4)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['amount'], message: 'VND expenses support at most 4 decimal places.' });
  }
  if (currency === 'VND' && value.amountVnd != null && value.amountVnd !== value.amount) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['amountVnd'], message: 'For VND expenses, amountVnd must match the source amount.' });
  }
  if (value.usdtCharged != null && currency !== 'VND') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['usdtCharged'], message: 'A USDT card debit can only be attached to a VND purchase.' });
  }
});

router.post('/', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = expenseSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        message: 'Check the expense name, amount, currency and category.',
      });
      return;
    }

    const input = parsed.data;
    const userId = req.user!.id;

    if (input.receiptId) {
      const receipt = await prisma.receipt.findFirst({
        where: { id: input.receiptId, userId },
      });
      if (!receipt) {
        res.status(400).json({ message: 'Receipt not found.' });
        return;
      }
    }

    // Aggregate only evidence available on the expense date in PostgreSQL.
    // The shared rate calculator preserves the legacy validity and weighting rules.
    const expenseDate = input.date ? new Date(input.date) : new Date();
    const aggregate = await getDateAwareValuationAggregate(userId, expenseDate);
    const { rubPerUsdt: historicalRubPerUsdt, vndPerUsdt: historicalVndPerUsdt, vndPerRub: historicalVndPerRub } =
      calculateDateAwareValuationRates(aggregate);

    // Keep the source amount even when no trustworthy VND conversion is available.
    const normalizedCurrency = input.currency.trim().toUpperCase();
    const amountVnd = input.amountVnd ?? (
      normalizedCurrency === 'VND' ? input.amount :
      normalizedCurrency === 'USDT' && historicalVndPerUsdt != null ? input.amount * historicalVndPerUsdt :
      normalizedCurrency === 'RUB' && historicalVndPerRub != null ? input.amount * historicalVndPerRub :
      !['RUB', 'USDT', 'VND'].includes(normalizedCurrency) && input.targetToVndRate != null
        ? input.amount * input.targetToVndRate
        : null
    );
    const amountRub = calculateExpenseRub({
      currency: input.currency,
      amount: input.amount,
      amountVnd,
      targetToVndRate: input.targetToVndRate,
      usdtCharged: input.usdtCharged,
    }, historicalRubPerUsdt, historicalVndPerUsdt, historicalVndPerRub);
    if (!areSupportedStoredAmounts([amountVnd, amountRub]) || !areRepresentableDecimals([
      { value: amountVnd, scale: 4 }, { value: amountRub, scale: 4 },
    ])) {
      res.status(400).json({ message: 'Calculated expense values exceed the supported storage range.' });
      return;
    }

    const record = await prisma.$transaction(async (tx) => {
      const created = await tx.expense.create({
        data: {
          userId,
          title: input.title,
          category: input.category,
          amount: input.amount,
          currency: input.currency,
          amountVnd,
          amountRub,
          usdtCharged: input.usdtCharged,
          date: expenseDate,
          receiptId: input.receiptId,
        },
      });
      await syncExpenseLedger(tx, created);
      return created;
    });

    res.status(201).json(record);
  } catch (e) {
    next(e);
  }
});

router.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const page = parseListPageQuery(req.query as Record<string, unknown>);
    if (page.error) {
      res.status(400).json({ message: 'Invalid pagination parameters.' });
      return;
    }
    const where = { userId: req.user!.id, ...listAfterCursor('date', page.cursor) };
    const records = await prisma.expense.findMany({
      where: page.requested ? where : { userId: req.user!.id },
      orderBy: [{ date: 'desc' }, { id: 'asc' }],
      take: page.requested ? page.limit + 1 : 500,
      select: { id: true, title: true, category: true, amount: true, currency: true, amountVnd: true, amountRub: true, usdtCharged: true, date: true, createdAt: true, updatedAt: true, receiptId: true },
    });
    if (!page.requested) {
      res.json(records);
      return;
    }
    const hasMore = records.length > page.limit;
    const items = hasMore ? records.slice(0, page.limit) : records;
    const last = items.at(-1);
    res.json({
      items,
      limit: page.limit,
      hasMore,
      nextCursor: hasMore && last ? encodeListCursor(last.date, last.id) : null,
    });
  } catch (e) {
    next(e);
  }
});


router.patch('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = expenseSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Check the expense name, amount, currency and category.' });
      return;
    }
    const input = parsed.data;
    const userId = req.user!.id;
    const id = String(req.params.id);
    const existing = await prisma.expense.findFirst({ where: { id, userId } });
    if (!existing) {
      res.status(404).json({ message: 'Expense not found.' });
      return;
    }
    if (input.receiptId) {
      const receipt = await prisma.receipt.findFirst({ where: { id: input.receiptId, userId } });
      if (!receipt) {
        res.status(400).json({ message: 'Receipt not found.' });
        return;
      }
    }

    const expenseDate = input.date ? new Date(input.date) : existing.date;
    // Exclude the current row so edits do not feed their previous valuation
    // back into the historical rate used to calculate replacement values.
    const aggregate = await getDateAwareValuationAggregate(userId, expenseDate, id);
    const { rubPerUsdt, vndPerUsdt, vndPerRub } = calculateDateAwareValuationRates(aggregate);
    const normalizedCurrency = input.currency.trim().toUpperCase();
    const effectiveUsdtCharged = input.usdtCharged === undefined && normalizedCurrency === 'VND'
      ? (existing.usdtCharged == null ? null : Number(existing.usdtCharged))
      : input.usdtCharged ?? null;
    const amountVnd = input.amountVnd ?? (
      normalizedCurrency === 'VND' ? input.amount :
      normalizedCurrency === 'USDT' && vndPerUsdt != null ? input.amount * vndPerUsdt :
      normalizedCurrency === 'RUB' && vndPerRub != null ? input.amount * vndPerRub :
      !['RUB', 'USDT', 'VND'].includes(normalizedCurrency) && input.targetToVndRate != null
        ? input.amount * input.targetToVndRate
        : null
    );
    const amountRub = calculateExpenseRub({
      currency: input.currency,
      amount: input.amount,
      amountVnd,
      targetToVndRate: input.targetToVndRate,
      usdtCharged: effectiveUsdtCharged,
    }, rubPerUsdt, vndPerUsdt, vndPerRub);
    if (!areSupportedStoredAmounts([amountVnd, amountRub]) || !areRepresentableDecimals([
      { value: amountVnd, scale: 4 }, { value: amountRub, scale: 4 },
    ])) {
      res.status(400).json({ message: 'Calculated expense values exceed the supported storage range.' });
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.expense.updateMany({
        where: { id, userId },
        data: {
          title: input.title,
          category: input.category,
          amount: input.amount,
          currency: input.currency,
          amountVnd,
          amountRub,
          usdtCharged: effectiveUsdtCharged,
          date: expenseDate,
          receiptId: input.receiptId ?? existing.receiptId,
        },
      });
      if (!result.count) return null;
      const current = await tx.expense.findFirst({ where: { id, userId } });
      if (current) await syncExpenseLedger(tx, current);
      return current;
    });
    if (!updated) {
      res.status(404).json({ message: 'Expense not found.' });
      return;
    }
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

router.delete('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const userId = req.user!.id;
    const deleted = await prisma.$transaction(async (tx) => {
      const result = await tx.expense.deleteMany({ where: { id, userId } });
      if (result.count) await removeExpenseLedger(tx, userId, id);
      return result.count;
    });
    if (!deleted) {
      res.status(404).json({ message: 'Expense not found.' });
      return;
    }
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

export default router;
