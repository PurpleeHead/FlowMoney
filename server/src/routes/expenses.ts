import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../services/prisma.js';
import { auth } from '../middleware/auth.js';
import type { AuthedRequest } from '../types.js';

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
        select: { rubSpent: true, usdtReceived: true, vndReceived: true },
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

    const rubSpent = exchanges.reduce((sum, x) => sum + Number(x.rubSpent), 0);
    const usdtReceived = exchanges.reduce((sum, x) => sum + Number(x.usdtReceived), 0);
    const historicalRubPerUsdt = usdtReceived > 0 ? rubSpent / usdtReceived : null;

    const vndExchanges = exchanges.filter(x => x.vndReceived != null);
    const vndExchangeRub = vndExchanges.reduce((sum, x) => sum + Number(x.rubSpent), 0);
    const vndExchangeReceived = vndExchanges.reduce((sum, x) => sum + Number(x.vndReceived), 0);
    let historicalVndPerRub = vndExchangeRub > 0
      ? vndExchangeReceived / vndExchangeRub
      : null;

    if (historicalVndPerRub == null && historicalRubPerUsdt != null) {
      const observedVnd = previousPurchases.reduce((sum, x) => sum + Number(x.amountVnd), 0);
      const observedUsdt = previousPurchases.reduce((sum, x) => sum + Number(x.usdtCharged), 0);
      if (observedUsdt > 0) {
        historicalVndPerRub = (observedVnd / observedUsdt) / historicalRubPerUsdt;
      }
    }

    let amountRub: number | null = null;
    if (input.currency === 'RUB') {
      amountRub = input.amount;
    } else if (input.currency === 'USDT' && historicalRubPerUsdt != null) {
      amountRub = input.amount * historicalRubPerUsdt;
    } else if (input.currency === 'VND' && input.usdtCharged != null && historicalRubPerUsdt != null) {
      amountRub = input.usdtCharged * historicalRubPerUsdt;
    } else if (historicalVndPerRub != null && historicalVndPerRub > 0) {
      amountRub = input.amountVnd / historicalVndPerRub;
    }

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
