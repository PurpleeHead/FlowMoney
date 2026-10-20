import { Router } from 'express';
import { parseListPageQuery, encodeListCursor, listAfterCursor } from '../lib/list-pagination.js';
import { z } from 'zod';
import { prisma } from '../services/prisma.js';
import { auth } from '../middleware/auth.js';
import type { AuthedRequest } from '../types.js';
import {
  calculateExpenseRub,
  calculateObservedVndPerRub,
  calculateObservedVndPerUsdt,
  calculateRubPerUsdt,
  mapRubUsdtExchanges,
} from '../lib/money.js';
import { syncExpenseLedger } from '../lib/wallet-ledger.js';
import { areRepresentableDecimals, areSupportedStoredAmounts, hasDecimalScale, MAX_STORED_AMOUNT } from '../lib/amount-limits.js';

const router = Router();
router.use(auth);

export const itemSchema = z.object({
  name: z.string().trim().min(1).max(300),
  price: z.number().positive().finite().min(0.000001).max(MAX_STORED_AMOUNT).refine(value => hasDecimalScale(value, 6), 'Item price supports at most 6 decimal places.'),
  quantity: z.number().positive().finite().max(MAX_STORED_AMOUNT).default(1),
  currency: z.literal('VND').default('VND'),
  amountVnd: z.number().positive().finite().min(0.0001).max(MAX_STORED_AMOUNT).refine(value => hasDecimalScale(value, 4), 'VND amount supports at most 4 decimal places.'),
}).superRefine((value, ctx) => {
  if (value.amountVnd !== value.price) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['amountVnd'], message: 'For VND receipt items, amountVnd must match the source price.' });
  }
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
        select: { mode: true, rubSpent: true, usdtReceived: true, vndReceived: true, planningVndPerUsdt: true, targetCurrency: true, targetReceived: true, targetVndEquivalent: true },
      }),
      prisma.expense.findMany({
        where: { userId, date: { lte: now }, usdtCharged: { not: null } },
        select: { amountVnd: true, usdtCharged: true },
      }),
    ]);

    const rubPerUsdt = calculateRubPerUsdt(
      mapRubUsdtExchanges(exchanges.map(x => ({
        mode: x.mode,
        rubSpent: Number(x.rubSpent),
        usdtReceived: x.usdtReceived == null ? null : Number(x.usdtReceived),
        targetCurrency: x.targetCurrency,
        targetReceived: x.targetReceived == null ? null : Number(x.targetReceived),
      })))
    );
    const observedVndPerUsdt = calculateObservedVndPerUsdt(
      previousPurchases.map(x => ({ amountVnd: Number(x.amountVnd), usdtCharged: Number(x.usdtCharged) }))
    );
    const actualExchanges = exchanges.filter(x => x.mode === 'RUB_USDT_VND' && x.usdtReceived != null && x.vndReceived != null);
    const actualVnd = actualExchanges.reduce((sum, x) => sum + Number(x.vndReceived), 0);
    const actualUsdt = actualExchanges.reduce((sum, x) => sum + Number(x.usdtReceived), 0);
    // Planning rates are for previews only. Receipt expenses must not persist
    // estimated VND→RUB valuations as if they were based on actual exchange outcomes.
    const vndPerUsdt = observedVndPerUsdt ?? (actualUsdt > 0 ? actualVnd / actualUsdt : null);
    const vndPerRub = calculateObservedVndPerRub({
      directExchanges: [
        ...exchanges.filter(x => x.mode === 'RUB_VND' && x.vndReceived != null).map(x => ({ rubSpent: Number(x.rubSpent), vndReceived: Number(x.vndReceived) })),
        ...exchanges.filter(x => x.mode === 'RUB_TARGET' && x.targetCurrency === 'VND' && x.targetVndEquivalent != null).map(x => ({ rubSpent: Number(x.rubSpent), vndReceived: Number(x.targetVndEquivalent) })),
      ],
      actualVndExchanges: exchanges.filter(x => x.mode !== 'RUB_VND' && x.vndReceived != null)
        .map(x => ({ rubSpent: Number(x.rubSpent), vndReceived: Number(x.vndReceived) })),
      cardPurchases: previousPurchases.map(x => ({ amountVnd: Number(x.amountVnd), usdtCharged: Number(x.usdtCharged) })),
      rubPerUsdt,
    });

    const preparedItems = items.map(item => ({
      ...item,
      amountRub: calculateExpenseRub({
        currency: 'VND',
        amount: item.price,
        amountVnd: item.amountVnd,
      }, rubPerUsdt, vndPerUsdt, vndPerRub),
    }));
    if (preparedItems.some(item => !areSupportedStoredAmounts([item.price, item.amountVnd, item.amountRub]) || !areRepresentableDecimals([
      { value: item.price, scale: 6 }, { value: item.amountVnd, scale: 4 }, { value: item.amountRub, scale: 4 },
    ]))) {
      res.status(400).json({ message: 'Calculated receipt values exceed the supported storage range.' });
      return;
    }

    // Receipt and its expenses and wallet movements are written atomically.
    const result = await prisma.$transaction(async tx => {
      const receipt = await tx.receipt.create({
        data: { userId, rawText, items },
      });
      for (const item of preparedItems) {
        const expense = await tx.expense.create({
          data: {
            userId,
            title: item.name,
            category: 'Food & groceries',
            amount: item.price,
            currency: 'VND',
            amountVnd: item.amountVnd,
            amountRub: item.amountRub,
            date: now,
            receiptId: receipt.id,
          },
        });
        await syncExpenseLedger(tx, expense);
      }
      return receipt;
    });

    res.status(201).json({ id: result.id, expensesCreated: items.length });
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
    const where = { userId: req.user!.id, ...listAfterCursor('createdAt', page.cursor) };
    const records = await prisma.receipt.findMany({
      where: page.requested ? where : { userId: req.user!.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: page.requested ? page.limit + 1 : 100,
      select: { id: true, rawText: true, items: true, createdAt: true },
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
      nextCursor: hasMore && last ? encodeListCursor(last.createdAt, last.id) : null,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
