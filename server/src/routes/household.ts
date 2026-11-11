import { Router } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../services/prisma.js';
import { authAccount } from '../middleware/auth.js';
import type { AuthedRequest } from '../types.js';
import { newInvitationToken, hashInvitationToken } from '../services/households.js';

const router = Router();
router.use(authAccount);

function current(req: AuthedRequest) { return req.user!; }
function ownerOnly(req: AuthedRequest, res: import('express').Response) {
  if (current(req).role !== 'OWNER') {
    res.status(403).json({ message: 'Only the household owner can manage invitations and access.' });
    return false;
  }
  return true;
}

router.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const user = current(req);
    if (!user.householdId) return res.status(403).json({ message: 'Accept a household invitation to continue.' });
    const household = await prisma.household.findUnique({
      where: { id: user.householdId },
      include: {
        accesses: {
          where: { revokedAt: null },
          include: {
            user: { select: { id: true, telegramUsername: true, telegramFirstName: true } },
            member: { select: { id: true, name: true, color: true } },
          },
          orderBy: { joinedAt: 'asc' },
        },
      },
    });
    if (!household) return res.status(404).json({ message: 'Household not found.' });
    return res.json({
      id: household.id,
      name: household.name,
      ownerUserId: household.ownerUserId,
      role: user.role,
      currentUser: { id: user.accountId, memberId: user.memberId },
      members: household.accesses.map(access => ({
        userId: access.userId,
        role: access.role,
        joinedAt: access.joinedAt,
        member: access.member,
        identity: {
          telegramUsername: access.user.telegramUsername,
          telegramFirstName: access.user.telegramFirstName,
        },
      })),
    });
  } catch (error) { return next(error); }
});

router.patch('/', async (req: AuthedRequest, res, next) => {
  try {
    if (!ownerOnly(req, res)) return;
    const parsed = z.object({ name: z.string().trim().min(1).max(80) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Enter a household name.' });
    const household = await prisma.household.update({
      where: { id: current(req).householdId },
      data: { name: parsed.data.name },
      select: { id: true, name: true },
    });
    return res.json(household);
  } catch (error) { return next(error); }
});

router.post('/invitations', async (req: AuthedRequest, res, next) => {
  try {
    if (!ownerOnly(req, res)) return;
    const parsed = z.object({ memberId: z.string().cuid() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Choose a household member profile for the invitation.' });
    const user = current(req);
    const member = await prisma.householdMember.findFirst({
      where: { id: parsed.data.memberId, userId: user.id, isArchived: false },
      select: { id: true, name: true },
    });
    if (!member) return res.status(404).json({ message: 'Household member profile not found.' });
    const occupied = await prisma.householdAccess.findFirst({
      where: { householdId: user.householdId, memberId: member.id, revokedAt: null },
      select: { id: true },
    });
    if (occupied) return res.status(409).json({ message: 'This profile is already linked to an active account.' });

    const rawToken = newInvitationToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const invite = await prisma.householdInvite.create({
      data: {
        householdId: user.householdId,
        createdByUserId: user.accountId,
        memberId: member.id,
        tokenHash: hashInvitationToken(rawToken),
        expiresAt,
      },
      select: { id: true, expiresAt: true },
    });
    const botUsername = (process.env.TELEGRAM_BOT_USERNAME || 'nummioX_bot').replace(/^@/, '');
    const inviteLink = `https://t.me/${botUsername}?startapp=${rawToken}`;
    return res.status(201).json({ ...invite, member, inviteLink });
  } catch (error) { return next(error); }
});

router.get('/invitations', async (req: AuthedRequest, res, next) => {
  try {
    if (!ownerOnly(req, res)) return;
    const invites = await prisma.householdInvite.findMany({
      where: { householdId: current(req).householdId },
      include: { member: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return res.json(invites.map(({ tokenHash: _secret, ...invite }) => invite));
  } catch (error) { return next(error); }
});

router.delete('/invitations/:id', async (req: AuthedRequest, res, next) => {
  try {
    if (!ownerOnly(req, res)) return;
    const result = await prisma.householdInvite.updateMany({
      where: {
        id: String(req.params.id),
        householdId: current(req).householdId,
        acceptedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
    if (!result.count) return res.status(404).json({ message: 'Pending invitation not found.' });
    return res.status(204).end();
  } catch (error) { return next(error); }
});

router.post('/invitations/accept', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({ token: z.string().min(32).max(128) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'The invitation link is invalid.' });
    const user = current(req);
    const inviteHash = hashInvitationToken(parsed.data.token);
    const now = new Date();

    const accepted = await prisma.$transaction(async tx => {
      const invite = await tx.householdInvite.findUnique({
        where: { tokenHash: inviteHash },
        include: { household: true, member: true },
      });
      if (!invite || invite.revokedAt || invite.acceptedAt || invite.expiresAt <= now || invite.member.isArchived) {
        return { error: 'invalid' as const };
      }
      if (invite.household.ownerUserId === user.accountId) return { error: 'self' as const };

      const activeAccess = await tx.householdAccess.findFirst({
        where: { userId: user.accountId, revokedAt: null },
        include: { household: { select: { ownerUserId: true } } },
      });
      if (activeAccess && (activeAccess.role !== 'OWNER' || activeAccess.household.ownerUserId !== user.accountId)) {
        return { error: 'already-member' as const };
      }

      const [wallets, exchanges, expenses, receipts, incomeSources, incomeEntries, ledgerExpenses, obligations, obligationOccurrences, adjustments, budgets, goals] = await Promise.all([
        tx.wallet.count({ where: { userId: user.accountId } }),
        tx.exchange.count({ where: { userId: user.accountId } }),
        tx.expense.count({ where: { userId: user.accountId } }),
        tx.receipt.count({ where: { userId: user.accountId } }),
        tx.incomeSource.count({ where: { userId: user.accountId } }),
        tx.incomeEntry.count({ where: { userId: user.accountId } }),
        tx.ledgerExpense.count({ where: { userId: user.accountId } }),
        tx.obligation.count({ where: { userId: user.accountId } }),
        tx.obligationOccurrence.count({ where: { userId: user.accountId } }),
        tx.balanceAdjustment.count({ where: { userId: user.accountId } }),
        tx.budget.count({ where: { userId: user.accountId } }),
        tx.savingsGoal.count({ where: { userId: user.accountId } }),
      ]);
      if ([wallets, exchanges, expenses, receipts, incomeSources, incomeEntries, ledgerExpenses, obligations, obligationOccurrences, adjustments, budgets, goals].some(count => count > 0)) {
        return { error: 'has-data' as const };
      }

      const claimed = await tx.householdInvite.updateMany({
        where: { id: invite.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
        data: { acceptedAt: now, acceptedByUserId: user.accountId },
      });
      if (!claimed.count) return { error: 'invalid' as const };

      if (activeAccess) {
        await tx.householdAccess.update({
          where: { id: activeAccess.id },
          data: { revokedAt: now },
        });
      }
      const access = await tx.householdAccess.create({
        data: {
          householdId: invite.householdId,
          userId: user.accountId,
          memberId: invite.memberId,
          role: 'MEMBER',
        },
        select: { id: true },
      });
      return { householdName: invite.household.name, memberName: invite.member.name, accessId: access.id };
    }, { isolationLevel: 'Serializable' });

    if ('error' in accepted) {
      const messages = {
        invalid: [400, 'This invitation is invalid, expired, revoked or already used.'],
        self: [400, 'The household owner cannot accept their own invitation.'],
        'already-member': [409, 'This account already belongs to another shared household.'],
        'has-data': [409, 'This account already contains financial records. Join is blocked to prevent accidental data merging.'],
      } as const;
      const [status, message] = messages[accepted.error];
      return res.status(status).json({ message });
    }
    return res.json({ success: true, householdName: accepted.householdName, memberName: accepted.memberName });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error.code === 'P2002' || error.code === 'P2034')) {
      return res.status(409).json({ message: 'This invitation was just used or the account already has active household access. Refresh and try again.' });
    }
    return next(error);
  }
});

router.delete('/access/:userId', async (req: AuthedRequest, res, next) => {
  try {
    if (!ownerOnly(req, res)) return;
    const user = current(req);
    const targetUserId = String(req.params.userId);
    if (targetUserId === user.accountId) return res.status(400).json({ message: 'The owner cannot revoke their own access.' });
    const result = await prisma.householdAccess.updateMany({
      where: {
        householdId: user.householdId,
        userId: targetUserId,
        role: 'MEMBER',
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
    if (!result.count) return res.status(404).json({ message: 'Active household member not found.' });
    return res.status(204).end();
  } catch (error) { return next(error); }
});

export default router;
