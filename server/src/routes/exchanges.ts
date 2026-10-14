import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../services/prisma.js';
import { auth } from '../middleware/auth.js';
import type { AuthedRequest } from '../types.js';

const router = Router();

router.use(auth);

const schema = z.object({
  rubSpent: z.number().positive().finite(),
  usdtReceived: z.number().positive().finite(),
  vndPerUsdt: z.number().positive().finite().optional(),
  vndFee: z.number().min(0).finite().default(0),
  vndReceived: z.number().positive().finite().optional(),
});

router.post('/', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = schema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        message: 'Enter valid RUB spent and USDT received amounts.',
      });
      return;
    }

    const x = parsed.data;

    if ((x.vndPerUsdt == null) !== (x.vndReceived == null)) {
      res.status(400).json({
        message: 'VND rate and received amount must be provided together.',
      });
      return;
    }

    if (x.vndPerUsdt != null && x.vndReceived != null) {
      const grossVnd = x.usdtReceived * x.vndPerUsdt;

      if (x.vndReceived > grossVnd + 0.01 || x.vndFee > grossVnd) {
        res.status(400).json({
          message: 'VND result or fee is inconsistent with the entered rate.',
        });
        return;
      }
    }

    const record = await prisma.exchange.create({
      data: {
        userId: req.user!.id,
        rubSpent: x.rubSpent,
        usdtReceived: x.usdtReceived,
        vndPerUsdt: x.vndPerUsdt,
        vndFee: x.vndFee,
        vndReceived: x.vndReceived,
        effectiveVndPerRub:
          x.vndReceived == null ? null : x.vndReceived / x.rubSpent,
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

export default router;
