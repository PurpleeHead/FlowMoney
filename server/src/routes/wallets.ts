import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { auth } from '../middleware/auth.js';
import type { AuthedRequest } from '../types.js';
import { prisma } from '../services/prisma.js';
import { calculateWalletBalances } from '../lib/wallet-balances.js';

const router = Router();
router.use(auth);

const currencySchema = z.enum(['RUB', 'USDT', 'VND']);
const movementSchema = z.object({
  kind: z.enum(['OPENING', 'ADJUSTMENT']),
  currency: currencySchema,
  amount: z.number().finite(),
  note: z.string().trim().max(240).optional(),
}).superRefine((value, ctx) => {
  if (value.kind === 'OPENING' && value.amount < 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['amount'], message: 'Opening balance cannot be negative.' });
  }
  if (value.kind === 'ADJUSTMENT' && value.amount === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['amount'], message: 'Adjustment must be non-zero.' });
  }
});

router.get('/balances', async (req: AuthedRequest, res, next) => {
  try {
    const userId = req.user!.id;
    const movements = await prisma.walletMovement.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { currency: true, amountDelta: true, kind: true, createdAt: true },
    });
    res.json({ balances: calculateWalletBalances(movements) });
  } catch (error) {
    next(error);
  }
});

router.post('/movements', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = movementSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Provide a supported currency and a valid opening balance or adjustment.' });
      return;
    }

    const input = parsed.data;
    const userId = req.user!.id;
    // A deterministic source key guarantees one opening balance per user and currency.
    // Manual adjustments use unique keys so multiple corrections remain separate journal entries.
    const sourceKey = input.kind === 'OPENING'
      ? `opening:${userId}:${input.currency}`
      : `adjustment:${userId}:${randomUUID()}`;

    try {
      const movement = await prisma.walletMovement.create({
        data: {
          userId,
          currency: input.currency,
          amountDelta: input.amount,
          kind: input.kind,
          sourceKey,
          note: input.note || null,
        },
      });
      res.status(201).json({
        ...movement,
        amountDelta: Number(movement.amountDelta),
      });
    } catch (error) {
      // Prisma unique constraint violation: an opening balance already exists.
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
        res.status(409).json({ message: 'An opening balance has already been recorded for this currency.' });
        return;
      }
      throw error;
    }
  } catch (error) {
    next(error);
  }
});

export default router;
