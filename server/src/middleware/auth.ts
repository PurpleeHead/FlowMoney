import type { NextFunction, Response } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../services/prisma.js';
import type { AuthedRequest } from '../types.js';

export async function auth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ message: 'Please sign in to continue.' });
    return;
  }

  try {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.length < 32) throw new Error('JWT_SECRET is not configured or is too short');

    const payload = jwt.verify(header.slice(7), secret, { algorithms: ['HS256'] });
    if (
      typeof payload !== 'object' ||
      payload === null ||
      typeof payload.id !== 'string' ||
      payload.id.length === 0 ||
      typeof payload.email !== 'string' ||
      payload.email.length === 0
    ) {
      throw new Error('Invalid token claims');
    }

    // Resolve membership on every request so revocation takes effect immediately,
    // even while a previously issued JWT is still valid.
    const access = await prisma.householdAccess.findFirst({
      where: { userId: payload.id, revokedAt: null },
      include: { household: { select: { id: true, ownerUserId: true } } },
    });
    if (!access) {
      res.status(403).json({ message: 'Your household access is no longer active. Ask the household owner for a new invitation.' });
      return;
    }

    req.user = {
      id: access.household.ownerUserId,
      accountId: payload.id,
      email: payload.email,
      householdId: access.householdId,
      role: access.role === 'OWNER' ? 'OWNER' : 'MEMBER',
      memberId: access.memberId,
      ...(typeof payload.displayName === 'string' ? { displayName: payload.displayName } : {}),
    };
    next();
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'JsonWebTokenError') {
      res.status(401).json({ message: 'Session expired. Please sign in again.' });
      return;
    }
    if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'TokenExpiredError') {
      res.status(401).json({ message: 'Session expired. Please sign in again.' });
      return;
    }
    next(error);
  }
}
