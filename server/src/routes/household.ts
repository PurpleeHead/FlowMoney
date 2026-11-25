import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../services/prisma.js';
import { authAccount } from '../middleware/auth.js';
import type { AuthedRequest } from '../types.js';
import { newInvitationToken, hashInvitationToken } from '../services/households.js';

const router = Router();
router.use(authAccount);
const invitationCreateLimit = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false });
const invitationAcceptLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });

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

router.patch('/profile', async (req: AuthedRequest, res, next) => {
  try {
    const user = current(req);
    if (!ownerOnly(req, res)) return;
    const parsed = z.object({ memberId: z.string().cuid().nullable() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Choose a valid household profile.' });
    if (parsed.data.memberId) {
      const member = await prisma.householdMember.findFirst({
        where: { id: parsed.data.memberId, userId: user.id, isArchived: false },
        select: { id: true },
      });
      if (!member) return res.status(404).json({ message: 'Household member profile not found.' });
      const occupied = await prisma.householdAccess.findFirst({
        where: { householdId: user.householdId, memberId: parsed.data.memberId, revokedAt: null, userId: { not: user.accountId } },
        select: { id: true },
      });
      if (occupied) return res.status(409).json({ message: 'This profile is already linked to another account.' });
    }
    await prisma.householdAccess.updateMany({
      where: { householdId: user.householdId, userId: user.accountId, revokedAt: null, role: 'OWNER' },
      data: { memberId: parsed.data.memberId },
    });
    return res.json({ memberId: parsed.data.memberId });
  } catch (error) {
    // The partial unique index is the final guard against two requests assigning
    // the same active household profile at once. Return a conflict, not a 500.
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
      return res.status(409).json({ message: 'This profile is already linked to another active account.' });
    }
    return next(error);
  }
});

router.post('/invitations', invitationCreateLimit, async (req: AuthedRequest, res, next) => {
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
    const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
    const webInviteUrl = new URL('/', clientOrigin);
    webInviteUrl.hash = new URLSearchParams({ invite: rawToken }).toString();
    const botUsername = (process.env.TELEGRAM_BOT_USERNAME || 'nummioX_bot').replace(/^@/, '');
    const telegramInviteLink = process.env.TELEGRAM_BOT_TOKEN
      ? `https://t.me/${botUsername}?startapp=${rawToken}`
      : undefined;
    return res.status(201).json({
      ...invite,
      member,
      inviteLink: webInviteUrl.toString(),
      ...(telegramInviteLink ? { telegramInviteLink } : {}),
    });
  } catch (error) { return next(error); }
});

router.post('/invitations/preview', invitationAcceptLimit, async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({ token: z.string().min(32).max(128) }).safeParse({ token: req.body?.token });
    if (!parsed.success) return res.status(400).json({ message: 'The invitation link is invalid.' });
    const user = current(req);
    const invite = await prisma.householdInvite.findUnique({
      where: { tokenHash: hashInvitationToken(parsed.data.token) },
      include: {
        household: { include: { owner: { select: { telegramUsername: true, telegramFirstName: true } } } },
        member: { select: { name: true, isArchived: true } },
      },
    });
    if (invite?.acceptedAt && invite.acceptedByUserId === user.accountId) {
      const activeAccess = await prisma.householdAccess.findFirst({
        where: { userId: user.accountId, householdId: invite.householdId, revokedAt: null },
        select: { id: true },
      });
      if (activeAccess) {
        return res.json({
          alreadyAccepted: true,
          householdName: invite.household.name,
          memberName: invite.member.name,
          ownerName: invite.household.owner.telegramFirstName || invite.household.owner.telegramUsername || 'nummioX',
        });
      }
    }
    if (!invite || invite.revokedAt || invite.acceptedAt || invite.expiresAt <= new Date() || invite.member.isArchived) {
      return res.status(404).json({ message: 'This invitation is invalid, expired, revoked or already used.' });
    }
    return res.json({
      alreadyAccepted: false,
      householdName: invite.household.name,
      memberName: invite.member.name,
      ownerName: invite.household.owner.telegramFirstName || invite.household.owner.telegramUsername || 'nummioX',
      expiresAt: invite.expiresAt,
    });
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

router.post('/invitations/accept', invitationAcceptLimit, async (req: AuthedRequest, res, next) => {
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

      const activeAccesses = await tx.householdAccess.findMany({
        where: { userId: user.accountId, revokedAt: null },
        select: { id: true, role: true, householdId: true, household: { select: { ownerUserId: true } } },
      });
      // A personal OWNER access is deliberately retained. It keeps the account's
      // existing records in its own space while the new MEMBER access opens the
      // invited household. Only one shared membership is supported at a time.
      if (activeAccesses.some(access => access.role === 'MEMBER')) {
        return { error: 'already-member' as const };
      }
      const assignedProfile = await tx.householdAccess.findFirst({
        where: {
          householdId: invite.householdId,
          memberId: invite.memberId,
          revokedAt: null,
        },
        select: { userId: true },
      });
      if (assignedProfile && assignedProfile.userId !== user.accountId) {
        return { error: 'profile-occupied' as const };
      }

      const claimed = await tx.householdInvite.updateMany({
        where: { id: invite.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
        data: { acceptedAt: now, acceptedByUserId: user.accountId },
      });
      if (!claimed.count) return { error: 'invalid' as const };

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
        'profile-occupied': [409, 'This household profile is already linked to an active account. Ask the owner to revoke that access before reusing the profile.'],
      } as const;
      const [status, message] = messages[accepted.error as keyof typeof messages];
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
