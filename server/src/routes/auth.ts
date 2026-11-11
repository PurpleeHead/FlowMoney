import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../services/prisma.js';
import { auth } from '../middleware/auth.js';
import type { AuthedRequest } from '../types.js';
import { verifyTelegramInitData } from '../services/telegram.js';

const router = Router();
const credentials = z.object({
  email: z.string().email().max(254).transform(value => value.toLowerCase().trim()),
  password: z.string().min(8).max(128),
});

function token(id: string, email: string, displayName?: string | null) {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
  return jwt.sign({ id, email, ...(displayName ? { displayName } : {}) }, secret, { expiresIn: '7d' });
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

router.post('/register', async (req, res, next) => {
  try {
    const parsed = credentials.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: 'Enter a valid email and a password of at least 8 characters.' });
    }
    const { email, password } = parsed.data;
    if (await prisma.user.findUnique({ where: { email } })) {
      return res.status(409).json({ message: 'An account with this email already exists.' });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.$transaction(async tx => {
      const created = await tx.user.create({ data: { email, passwordHash } });
      const household = await tx.household.create({ data: { name: 'Моя семья', ownerUserId: created.id } });
      await tx.householdAccess.create({ data: { householdId: household.id, userId: created.id, role: 'OWNER' } });
      return created;
    });
    return res.status(201).json({ token: token(user.id, user.email), user: { id: user.id, email: user.email } });
  } catch (error) {
    // Two requests can pass the pre-check at once; the database unique constraint is authoritative.
    if (isUniqueConstraintError(error)) {
      return res.status(409).json({ message: 'An account with this email already exists.' });
    }
    return next(error);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const parsed = credentials.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Enter a valid email and password.' });
    const { email, password } = parsed.data;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ message: 'Email or password is incorrect.' });
    }
    return res.json({ token: token(user.id, user.email), user: { id: user.id, email: user.email } });
  } catch (error) {
    return next(error);
  }
});


router.post('/telegram', async (req, res, next) => {
  try {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) return res.status(503).json({ message: 'Telegram sign-in is not configured yet.' });
    const initData = typeof req.body?.initData === 'string' ? req.body.initData : '';
    if (!initData || initData.length > 8192) return res.status(400).json({ message: 'Missing or invalid Telegram sign-in data.' });
    const telegramUser = verifyTelegramInitData(initData, botToken);
    if (!telegramUser) return res.status(401).json({ message: 'Telegram sign-in data is invalid or expired. Reopen the app from Telegram.' });

    const user = await prisma.$transaction(async tx => {
      const existing = await tx.user.findUnique({ where: { telegramId: telegramUser.id } });
      if (existing) {
        return tx.user.update({
          where: { id: existing.id },
          data: {
            telegramUsername: telegramUser.username ?? null,
            telegramFirstName: telegramUser.firstName ?? 'Telegram user',
          },
        });
      }

      const created = await tx.user.create({
        data: {
          email: `telegram_${telegramUser.id}@telegram.flowmoney.invalid`,
          passwordHash: randomBytes(32).toString('hex'),
          telegramId: telegramUser.id,
          telegramUsername: telegramUser.username ?? null,
          telegramFirstName: telegramUser.firstName ?? 'Telegram user',
        },
      });
      const household = await tx.household.create({ data: { name: 'Моя семья', ownerUserId: created.id } });
      await tx.householdAccess.create({ data: { householdId: household.id, userId: created.id, role: 'OWNER' } });
      return created;
    });
    const displayName = user.telegramFirstName || user.telegramUsername || 'Telegram';
    return res.json({
      token: token(user.id, user.email, displayName),
      user: { id: user.id, email: user.email, displayName },
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/me', auth, async (req: AuthedRequest, res, next) => {
  try {
    return res.json({ ...req.user, id: req.user!.accountId });
  } catch (error) {
    return next(error);
  }
});

export default router;
