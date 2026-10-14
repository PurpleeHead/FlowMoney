import { Router } from 'express';
import { prisma } from '../services/prisma.js';
import { auth } from '../middleware/auth.js';
import type { AuthedRequest } from '../types.js';

const router = Router();
router.use(auth);

router.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const userId = req.user!.id;
    const [expenses, recentExchanges, allExchanges, wallets] = await Promise.all([
      prisma.expense.findMany({ where: { userId }, orderBy: { date: 'desc' }, take: 500 }),
      prisma.exchange.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.exchange.findMany({ where: { userId }, select: { rubSpent: true, usdtReceived: true, vndReceived: true } }),
      prisma.wallet.findMany({ where: { userId }, orderBy: { currency: 'asc' } }),
    ]);

    const totalVnd = expenses.reduce((sum, expense) => sum + Number(expense.amountVnd), 0);
    const monthVnd = expenses
      .filter(expense => expense.date >= start)
      .reduce((sum, expense) => sum + Number(expense.amountVnd), 0);

    // Weighted rates use all recorded conversions, not just the most recent page.
    // Each expense keeps its own saved amountVnd, so later rates never rewrite history.
    const totals = allExchanges.reduce((sum, exchange) => ({
      rubSpent: sum.rubSpent + Number(exchange.rubSpent),
      usdtReceived: sum.usdtReceived + Number(exchange.usdtReceived),
      vndReceived: sum.vndReceived + Number(exchange.vndReceived),
    }), { rubSpent: 0, usdtReceived: 0, vndReceived: 0 });

    const weightedRates = {
      vndPerRub: totals.rubSpent > 0 ? totals.vndReceived / totals.rubSpent : null,
      rubPerUsdt: totals.usdtReceived > 0 ? totals.rubSpent / totals.usdtReceived : null,
      vndPerUsdt: totals.usdtReceived > 0 ? totals.vndReceived / totals.usdtReceived : null,
      exchangeCount: allExchanges.length,
    };

    res.json({
      totalVnd,
      monthVnd,
      weightedRates,
      wallets: wallets.map(wallet => ({
        id: wallet.id,
        currency: wallet.currency,
        balance: Number(wallet.balance),
        label: wallet.label,
      })),
      expenses: expenses.map(expense => ({
        ...expense,
        amount: Number(expense.amount),
        amountVnd: Number(expense.amountVnd),
      })),
      exchanges: recentExchanges.map(exchange => ({
        ...exchange,
        rubSpent: Number(exchange.rubSpent),
        usdtReceived: Number(exchange.usdtReceived),
        vndReceived: Number(exchange.vndReceived),
        effectiveVndPerRub: Number(exchange.effectiveVndPerRub),
        effectiveRubPerUsdt: Number(exchange.effectiveRubPerUsdt),
      })),
    });
  } catch (error) {
    next(error);
  }
});

export default router;
