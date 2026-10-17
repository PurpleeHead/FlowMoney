import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../services/prisma.js';
import { auth } from '../middleware/auth.js';
import type { AuthedRequest } from '../types.js';
import { calculateTargetVndEquivalent, isExchangeVndOutcomeConsistent, resolveExchangeVndOutcome } from '../lib/money.js';
import { areSupportedStoredAmounts, MAX_STORED_AMOUNT } from '../lib/amount-limits.js';
import { syncExchangeLedger, removeExchangeLedger } from '../lib/wallet-ledger.js';

const router = Router();
router.use(auth);

export const exchangeSchema = z.object({
  mode: z.enum(['RUB_USDT_VND', 'RUB_VND', 'RUB_TARGET']).default('RUB_USDT_VND'),
  rubSpent: z.number().positive().finite().max(MAX_STORED_AMOUNT),
  usdtReceived: z.number().positive().finite().max(MAX_STORED_AMOUNT).optional(),
  vndPerUsdt: z.number().positive().finite().max(MAX_STORED_AMOUNT).optional(),
  planningVndPerUsdt: z.number().positive().finite().max(MAX_STORED_AMOUNT).optional(),
  vndFee: z.number().min(0).finite().max(MAX_STORED_AMOUNT).default(0),
  vndReceived: z.number().positive().finite().max(MAX_STORED_AMOUNT).optional(),
  targetCurrency: z.string().trim().regex(/^[A-Za-z]{3,8}$/).transform(value => value.toUpperCase()).refine(value => value !== 'RUB', 'Target currency must differ from RUB.').default('VND'),
  targetReceived: z.number().positive().finite().max(MAX_STORED_AMOUNT).optional(),
  targetToVndRate: z.number().positive().finite().max(MAX_STORED_AMOUNT).optional(),
});

async function createExchangeWithLedger(data: Prisma.ExchangeUncheckedCreateInput) {
  return prisma.$transaction(async (tx) => {
    const created = await tx.exchange.create({ data });
    await syncExchangeLedger(tx, created);
    return created;
  });
}

function directTargetData(x: z.infer<typeof schema>) {
  if (x.targetReceived == null) throw new Error('Enter the amount received in the target currency.');
  const rate = x.targetCurrency === 'VND' ? 1 : x.targetToVndRate;
  if (rate == null || !Number.isFinite(rate) || rate <= 0) {
    throw new Error('Enter how many VND equal one unit of the target currency.');
  }
  const targetVndEquivalent = calculateTargetVndEquivalent(x.targetCurrency, x.targetReceived, rate);
  if (!Number.isFinite(targetVndEquivalent) || targetVndEquivalent <= 0) {
    throw new Error('The VND equivalent must be a positive amount.');
  }
  return {
    mode: 'RUB_TARGET', rubSpent: x.rubSpent, usdtReceived: null, vndPerUsdt: null,
    planningVndPerUsdt: null, vndFee: 0, vndReceived: null,
    effectiveVndPerRub: targetVndEquivalent / x.rubSpent, effectiveRubPerUsdt: null,
    targetCurrency: x.targetCurrency, targetReceived: x.targetReceived,
    targetToVndRate: rate, targetVndEquivalent,
  };
}

router.post('/', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = exchangeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Enter valid RUB and received amounts.' });
      return;
    }
    const x = parsed.data;

    if (x.mode === 'RUB_TARGET') {
      let data;
      try { data = directTargetData(x); }
      catch (error) {
        res.status(400).json({ message: error instanceof Error ? error.message : 'Enter valid target currency amounts.' });
        return;
      }
      if (!areSupportedStoredAmounts([data.rubSpent, data.usdtReceived, data.vndPerUsdt, data.planningVndPerUsdt, data.vndFee, data.vndReceived, data.effectiveVndPerRub, data.effectiveRubPerUsdt, data.targetReceived, data.targetToVndRate, data.targetVndEquivalent])) {
        res.status(400).json({ message: 'Exchange values exceed the supported storage range.' });
        return;
      }
      const record = await createExchangeWithLedger({ userId: req.user!.id, ...data });
      res.status(201).json(record);
      return;
    }

    if (x.mode === 'RUB_VND') {
      if (x.vndReceived == null) {
        res.status(400).json({ message: 'Enter the actual VND received for a direct RUB → VND exchange.' });
        return;
      }
      if (x.vndFee >= x.vndReceived) {
        res.status(400).json({ message: 'The VND fee must be lower than the gross amount received.' });
        return;
      }
      const vndReceived = x.vndReceived - x.vndFee;
      if (!areSupportedStoredAmounts([x.rubSpent, x.vndFee, vndReceived, vndReceived / x.rubSpent])) {
        res.status(400).json({ message: 'Exchange values exceed the supported storage range.' });
        return;
      }
      const record = await createExchangeWithLedger({
        userId: req.user!.id, mode: 'RUB_VND', rubSpent: x.rubSpent,
        usdtReceived: null, vndPerUsdt: null, planningVndPerUsdt: null,
        vndFee: x.vndFee, vndReceived, effectiveVndPerRub: vndReceived / x.rubSpent,
        effectiveRubPerUsdt: null, targetCurrency: 'VND', targetReceived: vndReceived,
        targetToVndRate: 1, targetVndEquivalent: null,
      });
      res.status(201).json(record);
      return;
    }

    if (x.usdtReceived == null) {
      res.status(400).json({ message: 'Enter the actual USDT received.' });
      return;
    }
    if (!isExchangeVndOutcomeConsistent({
      usdtReceived: x.usdtReceived,
      vndReceived: x.vndReceived,
      vndPerUsdt: x.vndPerUsdt,
      vndFee: x.vndFee,
    })) {
      res.status(400).json({ message: 'VND result or fee is inconsistent with the entered rate.' });
      return;
    }
    if (x.vndReceived == null && x.vndPerUsdt != null) {
      res.status(400).json({ message: 'Enter the actual VND received amount when providing a VND/USDT rate.' });
      return;
    }
    let outcome: { vndReceived: number | null; vndPerUsdt: number | null };
    try {
      const netVndReceived = x.vndReceived == null ? null : x.vndReceived - x.vndFee;
      if (netVndReceived != null && netVndReceived <= 0) {
        throw new Error('VND fee must be lower than the gross VND amount.');
      }
      outcome = resolveExchangeVndOutcome({ usdtReceived: x.usdtReceived, vndReceived: netVndReceived });
    } catch {
      res.status(400).json({ message: 'Enter the actual VND amount received, or leave VND unknown.' });
      return;
    }
    const derivedValues = [x.rubSpent, x.usdtReceived, outcome.vndPerUsdt, x.planningVndPerUsdt ?? null, x.vndFee, outcome.vndReceived, outcome.vndReceived == null ? null : outcome.vndReceived / x.rubSpent, x.rubSpent / x.usdtReceived, null, null, null];
    if (!areSupportedStoredAmounts(derivedValues)) {
      res.status(400).json({ message: 'Exchange values exceed the supported storage range.' });
      return;
    }
    const record = await createExchangeWithLedger({
      userId: req.user!.id, mode: 'RUB_USDT_VND', rubSpent: x.rubSpent,
      usdtReceived: x.usdtReceived, vndPerUsdt: outcome.vndPerUsdt,
      planningVndPerUsdt: outcome.vndReceived == null ? (x.planningVndPerUsdt ?? null) : null,
      vndFee: x.vndFee, vndReceived: outcome.vndReceived,
      effectiveVndPerRub: outcome.vndReceived == null ? null : outcome.vndReceived / x.rubSpent,
      effectiveRubPerUsdt: x.rubSpent / x.usdtReceived,
      targetCurrency: 'VND', targetReceived: null, targetToVndRate: null, targetVndEquivalent: null,
    });
    res.status(201).json(record);
  } catch (e) { next(e); }
});

router.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const records = await prisma.exchange.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: 'desc' }, take: 100 });
    res.json(records);
  } catch (e) { next(e); }
});

router.patch('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = exchangeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Enter valid RUB and received amounts.' });
      return;
    }
    const x = parsed.data;
    let data: {
      mode: string; rubSpent: number; usdtReceived: number | null; vndPerUsdt: number | null;
      planningVndPerUsdt: number | null; vndFee: number; vndReceived: number | null;
      effectiveVndPerRub: number | null; effectiveRubPerUsdt: number | null;
      targetCurrency: string; targetReceived: number | null; targetToVndRate: number | null; targetVndEquivalent: number | null;
    };

    if (x.mode === 'RUB_TARGET') {
      try { data = directTargetData(x); }
      catch (error) {
        res.status(400).json({ message: error instanceof Error ? error.message : 'Enter valid target currency amounts.' });
        return;
      }
    } else if (x.mode === 'RUB_VND') {
      if (x.vndReceived == null || x.vndFee >= x.vndReceived) {
        res.status(400).json({ message: 'Enter the actual gross VND amount; the fee must be lower than it.' });
        return;
      }
      const vndReceived = x.vndReceived - x.vndFee;
      data = {
        mode: 'RUB_VND', rubSpent: x.rubSpent, usdtReceived: null, vndPerUsdt: null,
        planningVndPerUsdt: null, vndFee: x.vndFee, vndReceived,
        effectiveVndPerRub: vndReceived / x.rubSpent, effectiveRubPerUsdt: null,
        targetCurrency: 'VND', targetReceived: vndReceived, targetToVndRate: 1, targetVndEquivalent: null,
      };
    } else {
      if (x.usdtReceived == null) {
        res.status(400).json({ message: 'Enter the actual USDT received.' });
        return;
      }
      if (!isExchangeVndOutcomeConsistent({
        usdtReceived: x.usdtReceived,
        vndReceived: x.vndReceived,
        vndPerUsdt: x.vndPerUsdt,
        vndFee: x.vndFee,
      })) {
        res.status(400).json({ message: 'VND result or fee is inconsistent with the entered rate.' });
        return;
      }
      if (x.vndReceived == null && x.vndPerUsdt != null) {
        res.status(400).json({ message: 'Enter actual VND received or leave the VND amount blank.' });
        return;
      }
      const netVndReceived = x.vndReceived == null ? null : x.vndReceived - x.vndFee;
      if (netVndReceived != null && netVndReceived <= 0) {
        res.status(400).json({ message: 'The VND fee must be lower than the gross VND amount.' });
        return;
      }
      const outcome = resolveExchangeVndOutcome({ usdtReceived: x.usdtReceived, vndReceived: netVndReceived });
      data = {
        mode: 'RUB_USDT_VND', rubSpent: x.rubSpent, usdtReceived: x.usdtReceived,
        vndPerUsdt: outcome.vndPerUsdt,
        planningVndPerUsdt: outcome.vndReceived != null ? null : (x.planningVndPerUsdt ?? null),
        vndFee: x.vndFee, vndReceived: outcome.vndReceived,
        effectiveVndPerRub: outcome.vndReceived == null ? null : outcome.vndReceived / x.rubSpent,
        effectiveRubPerUsdt: x.rubSpent / x.usdtReceived,
        targetCurrency: 'VND', targetReceived: null, targetToVndRate: null, targetVndEquivalent: null,
      };
    }
    if (!areSupportedStoredAmounts([data.rubSpent, data.usdtReceived, data.vndPerUsdt, data.planningVndPerUsdt, data.vndFee, data.vndReceived, data.effectiveVndPerRub, data.effectiveRubPerUsdt, data.targetReceived, data.targetToVndRate, data.targetVndEquivalent])) {
      res.status(400).json({ message: 'Exchange values exceed the supported storage range.' });
      return;
    }
    const id = String(req.params.id);
    const userId = req.user!.id;
    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.exchange.updateMany({ where: { id, userId }, data });
      if (!result.count) return null;
      const current = await tx.exchange.findFirst({ where: { id, userId } });
      if (current) await syncExchangeLedger(tx, current);
      return current;
    });
    if (!updated) {
      res.status(404).json({ message: 'Exchange not found.' });
      return;
    }
    res.json(updated);
  } catch (e) { next(e); }
});

router.delete('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const userId = req.user!.id;
    const deleted = await prisma.$transaction(async (tx) => {
      const result = await tx.exchange.deleteMany({ where: { id, userId } });
      if (result.count) await removeExchangeLedger(tx, userId, id);
      return result.count;
    });
    if (!deleted) {
      res.status(404).json({ message: 'Exchange not found.' });
      return;
    }
    res.status(204).end();
  } catch (e) { next(e); }
});

export default router;
