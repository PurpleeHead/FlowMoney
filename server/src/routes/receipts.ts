import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../services/prisma.js';
import { auth } from '../middleware/auth.js';
import type { AuthedRequest } from '../types.js';
import {
  calculateExpenseRub,
  calculateObservedVndPerRub,
  calculateObservedVndPerUsdt,
  calculateRubPerUsdt,
} from '../lib/money.js';

const router = Router();
router.use(auth);

const itemSchema = z.object({
  name: z.string().trim().min(1).max(300),
  price: z.number().positive().finite(),
  quantity: z.number().positive().finite().default(1),
  currency: z.string().default('VND'),
  amountVnd: z.number().positive().finite(),
});

router.post('/', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({
      rawText: z.string().max(30000),
      items: z.array(itemSchema).min(1).max(200),
    }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Receipt text or items are invalid.' });
      return;
    }

    const { rawText, items } = parsed.data;
    const userId = req.user!.id;
    const now = new Date();
    const [exchanges, previousPurchases] = await Promise.all([
      prisma.exchange.findMany({
        where: { userId, createdAt: { lte: now } },
        select: { mode: true, rubSpent: true, usdtReceived: true, vndReceived: true, planningVndPerUsdt: true },
      }),
      prisma.expense.findMany({
        where: { userId, date: { lte: now }, usdtCharged: { not: null } },
        select: { amountVnd: true, usdtCharged: true },
      }),
    ]);

    const rubPerUsdt = calculateRubPerUsdt(
      exchanges.map(x => ({ rubSpent: Number(x.rubSpent), usdtReceived: Number(x.usdtReceived) }))
    );
    const observedVndPerUsdt = calculateObservedVndPerUsdt(
      previousPurchases.map(x => ({ amountVnd: Number(x.amountVnd), usdtCharged: Number(x.usdtCharged) }))
    );
    const actualExchanges = exchanges.filter(x => x.mode !== 'RUB_VND' && x.usdtReceived != null && x.vndReceived != null);
    const actualVnd = actualExchanges.reduce((sum, x) => sum + Number(x.vndReceived), 0);
    const actualUsdt = actualExchanges.reduce((sum, x) => sum + Number(x.usdtReceived), 0);
    const plannedExchanges = exchanges.filter(x => x.mode !== 'RUB_VND' && x.usdtReceived != null && x.vndReceived == null && x.planningVndPerUsdt != null);
    const plannedUsdt = plannedExchanges.reduce((sum, x) => sum + Number(x.usdtReceived), 0);
    const planningVndPerUsdt = plannedUsdt > 0
      ? plannedExchanges.reduce((sum, x) => sum + Number(x.usdtReceived) * Number(x.planningVndPerUsdt), 0) / plannedUsdt
      : null;
    const vndPerUsdt = observedVndPerUsdt ?? (actualUsdt > 0 ? actualVnd / actualUsdt : planningVndPerUsdt);
    const vndPerRub = calculateObservedVndPerRub({
      directExchanges: exchanges.filter(x => x.mode === 'RUB_VND' && x.vndReceived != null)
        .map(x => ({ rubSpent: Number(x.rubSpent), vndReceived: Number(x.vndReceived) })),
      actualVndExchanges: exchanges.filter(x => x.mode !== 'RUB_VND' && x.vndReceived != null)
        .map(x => ({ rubSpent: Number(x.rubSpent), vndReceived: Number(x.vndReceived) })),
      cardPurchases: previousPurchases.map(x => ({ amountVnd: Number(x.amountVnd), usdtCharged: Number(x.usdtCharged) })),
      rubPerUsdt,
    });

    // Receipt and all its expenses are written in one transaction to avoid partial saves.
    const result = await prisma.$transaction(async tx => {
      const receipt = await tx.receipt.create({
        data: { userId, rawText, items },
      });
      await tx.expense.createMany({
        data: items.map(item => ({
          userId,
          title: item.name,
          category: 'Food & groceries',
          amount: item.price,
          currency: 'VND',
          amountVnd: item.amountVnd,
          amountRub: calculateExpenseRub({
            currency: 'VND',
            amount: item.price,
            amountVnd: item.amountVnd,
          }, rubPerUsdt, vndPerUsdt, vndPerRub),
          date: now,
          receiptId: receipt.id,
        })),
      });
      return receipt;
    });

    res.status(201).json({ id: result.id, expensesCreated: items.length });
  } catch (e) {
    next(e);
  }
});

router.get('/', async (req: AuthedRequest, res, next) => {
  try {
    res.json(await prisma.receipt.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }));
  } catch (e) {
    next(e);
  }
});

export default router;
