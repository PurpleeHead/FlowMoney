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
    // Fetch one extra row per source so hasMore remains accurate even when
    // a single source alone exceeds the requested page size.
    const take = parsed.data.limit + 1;
    const [expenses, exchanges, movements] = await Promise.all([
      prisma.expense.findMany({
        where: { userId },
        orderBy: [{ date: 'desc' }, { id: 'asc' }],
        take,
        select: {
          id: true, title: true, category: true, amount: true, currency: true,
          amountVnd: true, amountRub: true, usdtCharged: true, date: true, createdAt: true,
        },
      }),
      prisma.exchange.findMany({
        where: { userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take,
        select: {
          id: true, mode: true, rubSpent: true, usdtReceived: true, vndReceived: true,
          targetCurrency: true, targetReceived: true, targetVndEquivalent: true, createdAt: true,
        },
      }),
      prisma.walletMovement.findMany({
        where: { userId },
        orderBy: [{ occurredAt: 'desc' }, { id: 'asc' }],
        take,
        select: { id: true, currency: true, amountDelta: true, kind: true, note: true, occurredAt: true },
      }),
    ]);

    const fetchedCount = expenses.length + exchanges.length + movements.length;
    res.json({
      entries: buildJournal(expenses, exchanges, parsed.data.limit, movements),
      limit: parsed.data.limit,
      hasMore: fetchedCount > parsed.data.limit,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
