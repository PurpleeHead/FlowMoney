import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../services/prisma.js';
import { auth } from '../middleware/auth.js';
import type { AuthedRequest } from '../types.js';
import { calculateExpenseRub, calculateObservedVndPerRub, calculateObservedVndPerUsdt, calculateRubPerUsdt, mapDirectVndExchanges } from '../lib/money.js';

const router = Router();
router.use(auth);

const schema = z.object({
  title: z.string().trim().min(1).max(140),
  category: z.string().trim().min(1).max(80),
  amount: z.number().positive().finite(),
  currency: z.string().trim().min(3).max(8),
  amountVnd: z.number().positive().finite().nullable().optional(),
  targetToVndRate: z.number().positive().finite().nullable().optional(),
  usdtCharged: z.number().positive().finite().optional(),
  date: z.string().datetime().optional(),
  receiptId: z.string().optional(),
});

router.post('/', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = schema.safeParse(req.body);

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

    // Use only exchange and purchase data available on the expense date.
    // The resulting RUB amount is saved once and never recalculated on dashboard reads.
    const expenseDate = input.date ? new Date(input.date) : new Date();
    const [exchanges, previousPurchases] = await Promise.all([
      prisma.exchange.findMany({
        where: { userId, createdAt: { lte: expenseDate } },
        select: { mode: true, rubSpent: true, usdtReceived: true, vndReceived: true, planningVndPerUsdt: true, targetVndEquivalent: true },
      }),
      prisma.expense.findMany({
        where: {
          userId,
          date: { lte: expenseDate },
          usdtCharged: { not: null },
        },
        select: { amountVnd: true, usdtCharged: true },
      }),
    ]);

    const historicalRubPerUsdt = calculateRubPerUsdt(
      exchanges.map(x => ({ rubSpent: Number(x.rubSpent), usdtReceived: Number(x.usdtReceived) }))
    );

    // Prefer actual card purchases. If none exist yet, use only exchanges with an actual recorded VND outcome.
    const observedVndPerUsdt = calculateObservedVndPerUsdt(
      previousPurchases.map(x => ({ amountVnd: Number(x.amountVnd), usdtCharged: Number(x.usdtCharged) }))
    );
    const vndExchanges = exchanges.filter(x => x.mode === 'RUB_USDT_VND' && x.usdtReceived != null && x.vndReceived != null);
    const exchangeVnd = vndExchanges.reduce((sum, x) => sum + Number(x.vndReceived), 0);
    const exchangeUsdt = vndExchanges.reduce((sum, x) => sum + Number(x.usdtReceived), 0);
    const plannedExchanges = exchanges.filter(x => x.mode === 'RUB_USDT_VND' && x.vndReceived == null && x.usdtReceived != null && x.planningVndPerUsdt != null);
    const plannedUsdt = plannedExchanges.reduce((sum, x) => sum + Number(x.usdtReceived), 0);
    const planningVndPerUsdt = plannedUsdt > 0
      ? plannedExchanges.reduce((sum, x) => sum + Number(x.usdtReceived) * Number(x.planningVndPerUsdt), 0) / plannedUsdt
      : null;
    const historicalVndPerUsdt = observedVndPerUsdt ??
      (exchangeUsdt > 0 ? exchangeVnd / exchangeUsdt : planningVndPerUsdt);

    const historicalVndPerRub = calculateObservedVndPerRub({
      directExchanges: mapDirectVndExchanges(exchanges.map(x => ({
        mode: x.mode,
        rubSpent: Number(x.rubSpent),
        vndReceived: x.vndReceived == null ? null : Number(x.vndReceived),
        targetVndEquivalent: x.targetVndEquivalent == null ? null : Number(x.targetVndEquivalent),
      }))),
      actualVndExchanges: exchanges
        .filter(x => x.mode !== 'RUB_VND' && x.vndReceived != null)
        .map(x => ({ rubSpent: Number(x.rubSpent), vndReceived: Number(x.vndReceived) })),
      cardPurchases: previousPurchases.map(x => ({
        amountVnd: Number(x.amountVnd),
        usdtCharged: Number(x.usdtCharged),
      })),
      rubPerUsdt: historicalRubPerUsdt,
    });

    // Keep the source amount even when no trustworthy VND conversion is available.
    const normalizedCurrency = input.currency.trim().toUpperCase();
    const amountVnd = input.amountVnd ?? (
      normalizedCurrency === 'VND' ? input.amount :
      normalizedCurrency === 'USDT' && historicalVndPerUsdt != null ? input.amount * historicalVndPerUsdt :
      normalizedCurrency === 'RUB' && historicalVndPerRub != null ? input.amount * historicalVndPerRub :
      input.targetToVndRate != null ? input.amount * input.targetToVndRate : null
    );
    const amountRub = calculateExpenseRub({
      currency: input.currency,
      amount: input.amount,
      amountVnd,
      targetToVndRate: input.targetToVndRate,
      usdtCharged: input.usdtCharged,
    }, historicalRubPerUsdt, historicalVndPerUsdt, historicalVndPerRub);

    const record = await prisma.expense.create({
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

    res.status(201).json(record);
  } catch (e) {
    next(e);
  }
});

router.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const records = await prisma.expense.findMany({
      where: { userId: req.user!.id },
      orderBy: { date: 'desc' },
      take: 500,
    });
    res.json(records);
  } catch (e) {
    next(e);
  }
});


router.patch('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = schema.safeParse(req.body);
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
    const [exchanges, otherPurchases] = await Promise.all([
      prisma.exchange.findMany({
        where: { userId, createdAt: { lte: expenseDate } },
        select: { mode: true, rubSpent: true, usdtReceived: true, vndReceived: true, planningVndPerUsdt: true, targetVndEquivalent: true },
      }),
      prisma.expense.findMany({
        where: { userId, id: { not: id }, date: { lte: expenseDate }, usdtCharged: { not: null } },
        select: { amountVnd: true, usdtCharged: true },
      }),
    ]);
    const rubPerUsdt = calculateRubPerUsdt(
      exchanges.map(x => ({ rubSpent: Number(x.rubSpent), usdtReceived: Number(x.usdtReceived) }))
    );
    const observedVndPerUsdt = calculateObservedVndPerUsdt(
      otherPurchases.map(x => ({ amountVnd: Number(x.amountVnd), usdtCharged: Number(x.usdtCharged) }))
    );
    const actualExchanges = exchanges.filter(x => x.mode !== 'RUB_VND' && x.usdtReceived != null && x.vndReceived != null);
    const actualVnd = actualExchanges.reduce((sum, x) => sum + Number(x.vndReceived), 0);
    const actualUsdt = actualExchanges.reduce((sum, x) => sum + Number(x.usdtReceived), 0);
    const planned = exchanges.filter(x => x.mode !== 'RUB_VND' && x.usdtReceived != null && x.vndReceived == null && x.planningVndPerUsdt != null);
    const plannedUsdt = planned.reduce((sum, x) => sum + Number(x.usdtReceived), 0);
    const plannedRate = plannedUsdt > 0
      ? planned.reduce((sum, x) => sum + Number(x.usdtReceived) * Number(x.planningVndPerUsdt), 0) / plannedUsdt
      : null;
    const vndPerUsdt = observedVndPerUsdt ?? (actualUsdt > 0 ? actualVnd / actualUsdt : plannedRate);
    const vndPerRub = calculateObservedVndPerRub({
      directExchanges: mapDirectVndExchanges(exchanges.map(x => ({
        mode: x.mode,
        rubSpent: Number(x.rubSpent),
        vndReceived: x.vndReceived == null ? null : Number(x.vndReceived),
        targetVndEquivalent: x.targetVndEquivalent == null ? null : Number(x.targetVndEquivalent),
      }))),
      actualVndExchanges: exchanges.filter(x => x.mode !== 'RUB_VND' && x.vndReceived != null)
        .map(x => ({ rubSpent: Number(x.rubSpent), vndReceived: Number(x.vndReceived) })),
      cardPurchases: otherPurchases.map(x => ({ amountVnd: Number(x.amountVnd), usdtCharged: Number(x.usdtCharged) })),
      rubPerUsdt,
    });
    const normalizedCurrency = input.currency.trim().toUpperCase();
    const amountVnd = input.amountVnd ?? (
      normalizedCurrency === 'VND' ? input.amount :
      normalizedCurrency === 'USDT' && vndPerUsdt != null ? input.amount * vndPerUsdt :
      normalizedCurrency === 'RUB' && vndPerRub != null ? input.amount * vndPerRub :
      input.targetToVndRate != null ? input.amount * input.targetToVndRate : null
    );
    const amountRub = calculateExpenseRub({
      currency: input.currency,
      amount: input.amount,
      amountVnd,
      targetToVndRate: input.targetToVndRate,
      usdtCharged: input.usdtCharged,
    }, rubPerUsdt, vndPerUsdt, vndPerRub);

    const result = await prisma.expense.updateMany({
      where: { id, userId },
      data: {
        title: input.title,
        category: input.category,
        amount: input.amount,
        currency: input.currency,
        amountVnd,
        amountRub,
        usdtCharged: input.usdtCharged ?? null,
        date: expenseDate,
        receiptId: input.receiptId ?? existing.receiptId,
      },
    });
    if (!result.count) {
      res.status(404).json({ message: 'Expense not found.' });
      return;
    }
    const updated = await prisma.expense.findFirst({ where: { id, userId } });
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

router.delete('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const result = await prisma.expense.deleteMany({
      where: { id: String(req.params.id), userId: req.user!.id },
    });
    if (!result.count) {
      res.status(404).json({ message: 'Expense not found.' });
      return;
    }
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

export default router;
