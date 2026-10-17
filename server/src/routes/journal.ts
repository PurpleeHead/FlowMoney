import { Router } from 'express';
import { z } from 'zod';
import { auth } from '../middleware/auth.js';
import type { AuthedRequest } from '../types.js';
import { prisma } from '../services/prisma.js';
import { buildJournal } from '../lib/journal.js';

const router = Router();
router.use(auth);

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
});

router.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ message: 'Limit must be an integer between 1 and 500.' });
      return;
    }

    const userId = req.user!.id;
    const [expenses, exchanges, movements] = await Promise.all([
      prisma.expense.findMany({
        where: { userId },
        orderBy: { date: 'desc' },
        take: 500,
        select: {
          id: true, title: true, category: true, amount: true, currency: true,
          amountVnd: true, amountRub: true, usdtCharged: true, date: true, createdAt: true,
        },
      }),
      prisma.exchange.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 500,
        select: {
          id: true, mode: true, rubSpent: true, usdtReceived: true, vndReceived: true,
          targetCurrency: true, targetReceived: true, targetVndEquivalent: true, createdAt: true,
        },
      }),
    ]);

    res.json({
      entries: buildJournal(expenses, exchanges, parsed.data.limit),
      limit: parsed.data.limit,
      hasMore: expenses.length + exchanges.length > parsed.data.limit,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
