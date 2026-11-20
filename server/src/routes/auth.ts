import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../services/prisma.js';
import { auth } from '../middleware/auth.js';
import type { AuthedRequest } from '../types.js';
import { verifyTelegramInitData } from '../services/telegram.js';
import { sendPasswordResetEmail } from '../services/email.js';

const router = Router();
const credentials = z.object({
  email: z.string().email().max(254).transform(value => value.toLowerCase().trim()),
  password: z.string().min(8).max(128),
});

function token(id: string, email: string, displayName?: string | null, sessionVersion = 0, rememberMe = false) {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
  return jwt.sign(
    { id, email, sessionVersion, ...(displayName ? { displayName } : {}) },
    secret,
    { expiresIn: rememberMe ? '30d' : '7d' },
  );
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
    // bcrypt only uses the first 72 UTF-8 bytes. Reject longer new passwords so
    // users never believe bytes that are silently ignored are part of their secret.
    if (Buffer.byteLength(password, 'utf8') > 72) {
      return res.status(400).json({ message: 'Password must not exceed 72 UTF-8 bytes.' });
    }
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
    return res.status(201).json({ token: token(user.id, user.email, null, user.sessionVersion), user: { id: user.id, email: user.email, telegramLinked: false } });
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
    const parsed = credentials.extend({ rememberMe: z.boolean().optional().default(false) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Enter a valid email and password.' });
    const { email, password, rememberMe } = parsed.data;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ message: 'Email or password is incorrect.' });
    }
    return res.json({
      token: token(user.id, user.email, null, user.sessionVersion, rememberMe),
      user: { id: user.id, email: user.email, telegramLinked: Boolean(user.telegramId) },
    });
  } catch (error) {
    return next(error);
  }
});


const resetRequestSchema = z.object({
  email: z.string().email().max(254).transform(value => value.toLowerCase().trim()),
});
const resetConfirmSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/i),
  password: z.string().min(8).max(128),
});
const hashResetToken = (value: string) => createHash('sha256').update(value).digest('hex');

router.post('/password-reset/request', async (req, res, next) => {
  try {
    const parsed = resetRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Enter a valid email address.' });

    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.RESEND_FROM_EMAIL;
    const appBaseUrl = process.env.APP_BASE_URL || process.env.CLIENT_ORIGIN || 'http://localhost:5173';
    if (!apiKey || !from) {
      return res.status(503).json({ message: 'Password recovery email is not configured yet.' });
    }

    const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
    // Telegram-only accounts use a synthetic address and cannot receive password recovery email.
    if (user && !user.email.endsWith('@telegram.flowmoney.invalid')) {
      const rawToken = randomBytes(32).toString('hex');
      const tokenHash = hashResetToken(rawToken);
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
      await prisma.$transaction([
        prisma.passwordResetToken.updateMany({
          where: { userId: user.id, usedAt: null },
          data: { usedAt: new Date() },
        }),
        prisma.passwordResetToken.create({
          data: { userId: user.id, tokenHash, sessionVersion: user.sessionVersion, expiresAt },
        }),
      ]);

      const resetUrl = new URL('/reset-password', appBaseUrl);
      resetUrl.searchParams.set('token', rawToken);
      try {
        await sendPasswordResetEmail({ to: user.email, resetUrl: resetUrl.toString(), locale: user.locale === 'en' ? 'en' : 'ru' });
      } catch (error) {
        await prisma.passwordResetToken.updateMany({ where: { tokenHash, usedAt: null }, data: { usedAt: new Date() } });
        console.error('Password recovery email delivery failed:', error instanceof Error ? error.message : 'Unknown email provider error');
        // Keep the response indistinguishable from the unknown-account path to prevent enumeration.
      }
    }

    return res.json({ message: 'If an account exists for this email, a password recovery link will be sent shortly.' });
  } catch (error) {
    return next(error);
  }
});

router.post('/password-reset/confirm', async (req, res, next) => {
  try {
    const parsed = resetConfirmSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'The recovery link is invalid or expired.' });
    const { token: rawToken, password } = parsed.data;
    if (Buffer.byteLength(password, 'utf8') > 72) {
      return res.status(400).json({ message: 'Password must not exceed 72 UTF-8 bytes.' });
    }

    const tokenHash = hashResetToken(rawToken);
    const now = new Date();
    const record = await prisma.passwordResetToken.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true, sessionVersion: true, expiresAt: true, usedAt: true },
    });
    if (!record || record.usedAt || record.expiresAt <= now) {
      return res.status(400).json({ message: 'The recovery link is invalid or expired.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    let consumed = false;
    try {
      consumed = await prisma.$transaction(async tx => {
        const result = await tx.passwordResetToken.updateMany({
          where: { id: record.id, usedAt: null, expiresAt: { gt: now }, sessionVersion: record.sessionVersion },
          data: { usedAt: now },
        });
        if (result.count !== 1) return false;
        // Only the first reset transaction can advance the account session version.
        const accountUpdate = await tx.user.updateMany({
          where: { id: record.userId, sessionVersion: record.sessionVersion },
          data: { passwordHash, sessionVersion: { increment: 1 } },
        });
        if (accountUpdate.count !== 1) throw new Error('RESET_SESSION_VERSION_CONFLICT');
        await tx.passwordResetToken.updateMany({
          where: { userId: record.userId, usedAt: null },
          data: { usedAt: now },
        });
        return true;
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'RESET_SESSION_VERSION_CONFLICT') throw error;
    }
    if (!consumed) return res.status(400).json({ message: 'The recovery link is invalid or expired.' });
    return res.json({ message: 'Password updated. Please sign in with your new password.' });
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
    }).catch(async error => {
      // Two Telegram WebViews can authenticate the same new account at nearly the same time.
      // The unique Telegram ID constraint elects one creator; the other request reuses that account.
      if (!isUniqueConstraintError(error)) throw error;
      const existing = await prisma.user.findUnique({ where: { telegramId: telegramUser.id } });
      if (!existing) throw error;
      return prisma.user.update({
        where: { id: existing.id },
        data: {
          telegramUsername: telegramUser.username ?? null,
          telegramFirstName: telegramUser.firstName ?? 'Telegram user',
        },
      });
    });
    const displayName = user.telegramFirstName || user.telegramUsername || 'Telegram';
    return res.json({
      token: token(user.id, user.email, displayName, user.sessionVersion),
      user: { id: user.id, email: user.email, displayName, telegramLinked: true },
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/telegram/link', auth, async (req: AuthedRequest, res, next) => {
  try {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) return res.status(503).json({ message: 'Telegram sign-in is not configured yet.' });
    const initData = typeof req.body?.initData === 'string' ? req.body.initData : '';
    if (!initData || initData.length > 8192) {
      return res.status(400).json({ message: 'Missing or invalid Telegram sign-in data.' });
    }
    const telegramUser = verifyTelegramInitData(initData, botToken);
    if (!telegramUser) {
      return res.status(401).json({ message: 'Telegram sign-in data is invalid or expired. Reopen the app from Telegram.' });
    }

    const accountId = req.user!.accountId;
    const [account, existingIdentity] = await Promise.all([
      prisma.user.findUnique({ where: { id: accountId }, select: { id: true, telegramId: true } }),
      prisma.user.findUnique({ where: { telegramId: telegramUser.id }, select: { id: true } }),
    ]);
    if (!account) return res.status(404).json({ message: 'Account not found.' });
    if (account.telegramId && account.telegramId !== telegramUser.id) {
      return res.status(409).json({ message: 'This account is already linked to a different Telegram identity.' });
    }
    if (existingIdentity && existingIdentity.id !== accountId) {
      return res.status(409).json({ message: 'This Telegram identity is already linked to another FlowMoney account. Sign in to that account instead.' });
    }

    try {
      const updated = await prisma.user.update({
        where: { id: accountId },
        data: {
          telegramId: telegramUser.id,
          telegramUsername: telegramUser.username ?? null,
          telegramFirstName: telegramUser.firstName ?? 'Telegram user',
        },
        select: { id: true, email: true, telegramFirstName: true, telegramUsername: true },
      });
      const displayName = updated.telegramFirstName || updated.telegramUsername || 'Telegram';
      return res.json({ success: true, user: { id: updated.id, email: updated.email, displayName } });
    } catch (error) {
      // The unique Telegram ID constraint is authoritative when two accounts
      // attempt to claim the same signed identity at the same time.
      if (isUniqueConstraintError(error)) {
        return res.status(409).json({ message: 'This Telegram identity is already linked to another FlowMoney account.' });
      }
      throw error;
    }
  } catch (error) {
    return next(error);
  }
});

router.get('/me', auth, async (req: AuthedRequest, res, next) => {
  try {
    const account = await prisma.user.findUnique({ where: { id: req.user!.accountId }, select: { telegramId: true } });
    return res.json({ ...req.user, id: req.user!.accountId, telegramLinked: Boolean(account?.telegramId) });
  } catch (error) {
    return next(error);
  }
});

export default router;
