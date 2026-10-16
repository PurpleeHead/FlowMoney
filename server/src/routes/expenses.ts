import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../services/prisma.js';
import { auth } from '../middleware/auth.js';
import type { AuthedRequest } from '../types.js';
import { calculateExpenseRub, calculateObservedVndPerRub, calculateObservedVndPerUsdt, calculateRubPerUsdt } from '../lib/money.js';

const router = Router();
router.use(auth);

const schema = z.object({
  title: z.string().trim().min(1).max(140),
  category: z.string().trim().min(1).max(80),
  amount: z.number().positive().finite(),
  currency: z.string().trim().min(3).max(8),
  amountVnd: z.number().positive().finite(),
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
        select: { mode: true, rubSpent: true, usdtReceived: true, vndReceived: true },
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
    const vndExchanges = exchanges.filter(x => x.vndReceived != null);
    const exchangeVnd = vndExchanges.reduce((sum, x) => sum + Number(x.vndReceived), 0);
    const exchangeUsdt = vndExchanges.reduce((sum, x) => sum + Number(x.usdtReceived), 0);
    const historicalVndPerUsdt = observedVndPerUsdt ??
      (exchangeUsdt > 0 ? exchangeVnd / exchangeUsdt : null);

    const historicalVndPerRub = calculateObservedVndPerRub({
      directExchanges: exchanges
        .filter(x => x.mode === 'RUB_VND' && x.vndReceived != null)
        .map(x => ({ rubSpent: Number(x.rubSpent), vndReceived: Number(x.vndReceived) })),
      actualVndExchanges: exchanges
        .filter(x => x.mode !== 'RUB_VND' && x.vndReceived != null)
        .map(x => ({ rubSpent: Number(x.rubSpent), vndReceived: Number(x.vndReceived) })),
      cardPurchases: previousPurchases.map(x => ({
        amountVnd: Number(x.amountVnd),
        usdtCharged: Number(x.usdtCharged),
      })),
      rubPerUsdt: historicalRubPerUsdt,
    });

    // This is the same formula used by the client preview. Save the resulting RUB amount once.
    const amountRub = calculateExpenseRub({
      currency: input.currency,
      amount: input.amount,
      amountVnd: input.amountVnd,
      usdtCharged: input.usdtCharged,
    }, historicalRubPerUsdt, historicalVndPerUsdt, historicalVndPerRub);

    const record = await prisma.expense.create({
      data: {
        userId,
        title: input.title,
        category: input.category,
        amount: input.amount,
        currency: input.currency,
        amountVnd: input.amountVnd,
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
