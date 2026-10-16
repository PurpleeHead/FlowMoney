import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../services/prisma.js';
import { auth } from '../middleware/auth.js';
import type { AuthedRequest } from '../types.js';
import { resolveExchangeVndOutcome } from '../lib/money.js';

const router = Router();
router.use(auth);

const schema = z.object({
  mode: z.enum(['RUB_USDT_VND', 'RUB_VND']).default('RUB_USDT_VND'),
  rubSpent: z.number().positive().finite(),
  usdtReceived: z.number().positive().finite().optional(),
  vndPerUsdt: z.number().positive().finite().optional(),
  planningVndPerUsdt: z.number().positive().finite().optional(),
  vndFee: z.number().min(0).finite().default(0),
  vndReceived: z.number().positive().finite().optional(),
});

router.post('/', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Enter valid RUB and received amounts.' });
      return;
    }

    const x = parsed.data;
    if (x.mode === 'RUB_VND') {
      if (x.vndReceived == null) {
        res.status(400).json({ message: 'Enter the actual VND received for a direct RUB → VND exchange.' });
        return;
      }
      if (x.vndFee > x.vndReceived) {
        res.status(400).json({ message: 'The VND fee cannot exceed the amount received.' });
        return;
      }
      const vndReceived = x.vndReceived - x.vndFee;
      const record = await prisma.exchange.create({
        data: {
          userId: req.user!.id,
          mode: 'RUB_VND',
          rubSpent: x.rubSpent,
          usdtReceived: null,
          vndPerUsdt: null,
          planningVndPerUsdt: null,
          vndFee: x.vndFee,
          vndReceived,
          effectiveVndPerRub: vndReceived / x.rubSpent,
          effectiveRubPerUsdt: null,
        },
      });
      res.status(201).json(record);
      return;
    }

    if (x.usdtReceived == null) {
      res.status(400).json({ message: 'Enter the actual USDT received.' });
      return;
    }
    if (x.vndPerUsdt != null && x.vndReceived != null) {
      const grossVnd = x.usdtReceived * x.vndPerUsdt;
      if (x.vndReceived > grossVnd + 0.01 || x.vndFee > grossVnd) {
        res.status(400).json({ message: 'VND result or fee is inconsistent with the entered rate.' });
        return;
      }
    }
    if (x.vndReceived == null && x.vndPerUsdt != null) {
      res.status(400).json({ message: 'Enter the actual VND received amount when providing a VND/USDT rate.' });
      return;
    }

    let vndOutcome: { vndReceived: number | null; vndPerUsdt: number | null };
    try {
      vndOutcome = resolveExchangeVndOutcome({
        usdtReceived: x.usdtReceived,
        vndReceived: x.vndReceived,
        vndPerUsdt: x.vndPerUsdt,
      });
    } catch {
      res.status(400).json({ message: 'Enter the actual VND amount received, or leave VND unknown.' });
      return;
    }

    const effectiveVndReceived = vndOutcome.vndReceived;
    const effectiveVndPerUsdt = vndOutcome.vndPerUsdt;
    const record = await prisma.exchange.create({
      data: {
        userId: req.user!.id,
        mode: 'RUB_USDT_VND',
        rubSpent: x.rubSpent,
        usdtReceived: x.usdtReceived,
        vndPerUsdt: effectiveVndPerUsdt,
        planningVndPerUsdt: effectiveVndReceived == null ? (x.planningVndPerUsdt ?? null) : null,
        vndFee: x.vndFee,
        vndReceived: effectiveVndReceived,
        effectiveVndPerRub: effectiveVndReceived == null ? null : effectiveVndReceived / x.rubSpent,
        effectiveRubPerUsdt: x.rubSpent / x.usdtReceived,
      },
    });
    res.status(201).json(record);
  } catch (e) {
    next(e);
  }
});

router.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const records = await prisma.exchange.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
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
      res.status(400).json({ message: 'Enter valid RUB and received amounts.' });
      return;
    }
    const x = parsed.data;
    let data: {
      mode: string;
      rubSpent: number;
      usdtReceived: number | null;
      vndPerUsdt: number | null;
      planningVndPerUsdt?: number | null;
      vndFee: number;
      vndReceived: number | null;
      effectiveVndPerRub: number | null;
      effectiveRubPerUsdt: number | null;
    };
    if (x.mode === 'RUB_VND') {
      if (x.vndReceived == null || x.vndFee > x.vndReceived) {
        res.status(400).json({ message: 'Enter the actual VND received; the fee cannot exceed it.' });
        return;
      }
      const vndReceived = x.vndReceived - x.vndFee;
      data = {
        mode: 'RUB_VND', rubSpent: x.rubSpent, usdtReceived: null, vndPerUsdt: null,
        planningVndPerUsdt: null,
        vndFee: x.vndFee, vndReceived, effectiveVndPerRub: vndReceived / x.rubSpent,
        effectiveRubPerUsdt: null,
      };
    } else {
      if (x.usdtReceived == null) {
        res.status(400).json({ message: 'Enter the actual USDT received.' });
        return;
      }
      if (x.vndReceived == null && x.vndPerUsdt != null) {
        res.status(400).json({ message: 'Enter actual VND received or leave the VND amount blank.' });
        return;
      }
      const outcome = resolveExchangeVndOutcome({
        usdtReceived: x.usdtReceived,
        vndReceived: x.vndReceived,
        vndPerUsdt: x.vndPerUsdt,
      });
      data = {
        mode: 'RUB_USDT_VND', rubSpent: x.rubSpent, usdtReceived: x.usdtReceived,
        vndPerUsdt: outcome.vndPerUsdt, ...(outcome.vndReceived != null ? { planningVndPerUsdt: null } : x.planningVndPerUsdt != null ? { planningVndPerUsdt: x.planningVndPerUsdt } : {}), vndFee: x.vndFee, vndReceived: outcome.vndReceived,
        effectiveVndPerRub: outcome.vndReceived == null ? null : outcome.vndReceived / x.rubSpent,
        effectiveRubPerUsdt: x.rubSpent / x.usdtReceived,
      };
    }
    const result = await prisma.exchange.updateMany({
      where: { id: String(req.params.id), userId: req.user!.id },
      data,
    });
    if (!result.count) {
      res.status(404).json({ message: 'Exchange not found.' });
      return;
    }
    const updated = await prisma.exchange.findFirst({ where: { id: String(req.params.id), userId: req.user!.id } });
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

router.delete('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const result = await prisma.exchange.deleteMany({
      where: { id: String(req.params.id), userId: req.user!.id },
    });
    if (!result.count) {
      res.status(404).json({ message: 'Exchange not found.' });
      return;
    }
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

export default router;
