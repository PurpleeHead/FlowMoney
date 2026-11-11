import { randomBytes, createHash } from 'node:crypto';
import { prisma } from './prisma.js';

export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function ensurePersonalHousehold(userId: string): Promise<void> {
  const active = await prisma.householdAccess.findFirst({ where: { userId, revokedAt: null }, select: { id: true } });
  if (active) return;

  try {
    await prisma.$transaction(async tx => {
      const existing = await tx.household.findUnique({ where: { ownerUserId: userId }, select: { id: true } });
      const household = existing ?? await tx.household.create({ data: { name: 'Моя семья', ownerUserId: userId } });
      await tx.householdAccess.create({
        data: { householdId: household.id, userId, role: 'OWNER' },
      });
    });
  } catch (error) {
    // Concurrent first launches may race to create the initial household/access row.
    const raced = await prisma.householdAccess.findFirst({ where: { userId, revokedAt: null }, select: { id: true } });
    if (!raced) throw error;
  }
}

export function newInvitationToken(): string {
  return randomBytes(32).toString('base64url');
}
