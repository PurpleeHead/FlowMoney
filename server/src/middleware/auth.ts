import type { NextFunction, Response } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../services/prisma.js';
import type { AuthedRequest } from '../types.js';

export type SessionClaims = { id: string; email: string; displayName?: string; sessionVersion: number };

export function readSessionClaims(token: string, secret: string): SessionClaims | null {
  try {
    const payload = jwt.verify(token, secret, { algorithms: ['HS256'] });
    if (
      typeof payload !== 'object' || payload === null ||
      typeof payload.id !== 'string' || payload.id.length === 0 ||
      typeof payload.email !== 'string' || payload.email.length === 0
    ) return null;
    return {
      id: payload.id,
      email: payload.email,
      sessionVersion: typeof payload.sessionVersion === 'number' && Number.isInteger(payload.sessionVersion) ? payload.sessionVersion : 0,
      ...(typeof payload.displayName === 'string' ? { displayName: payload.displayName } : {}),
    };
  } catch {
    return null;
  }
}

async function authenticate(req: AuthedRequest, res: Response, next: NextFunction, requireHousehold: boolean) {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ message: 'Please sign in to continue.' });
    return;
  }

  try {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.length < 32) throw new Error('JWT_SECRET is not configured or is too short');
    const claims = readSessionClaims(header.slice(7), secret);
    if (!claims) {
      res.status(401).json({ message: 'Session expired. Please sign in again.' });
      return;
    }

    const account = await prisma.user.findUnique({ where: { id: claims.id }, select: { sessionVersion: true } });
    if (!account || account.sessionVersion !== claims.sessionVersion) {
      res.status(401).json({ message: 'Session expired. Please sign in again.' });
      return;
    }

    // A user may keep a personal household while also joining one shared household.
    // The client selects the active space with this header; an invalid/stale selection
    // falls back to the user's own personal space instead of granting foreign access.
    const accesses = await prisma.householdAccess.findMany({
      where: { userId: claims.id, revokedAt: null },
      include: { household: { select: { id: true, ownerUserId: true } } },
      orderBy: { joinedAt: 'asc' },
    });
    const requestedHouseholdId = req.header('x-nummiox-household-id');
    const access = (requestedHouseholdId
      ? accesses.find(item => item.householdId === requestedHouseholdId)
      : undefined)
      ?? accesses.find(item => item.role === 'OWNER' && item.household.ownerUserId === claims.id)
      ?? accesses[0];

    if (!access && requireHousehold) {
      res.status(403).json({ message: 'Your household access is no longer active. Ask the household owner for a new invitation.' });
      return;
    }

    req.user = {
      id: access?.household.ownerUserId ?? claims.id,
      accountId: claims.id,
      email: claims.email,
      householdId: access?.householdId ?? '',
      role: access ? (access.role === 'OWNER' ? 'OWNER' : 'MEMBER') : 'NONE',
      memberId: access?.memberId ?? null,
      ...(claims.displayName ? { displayName: claims.displayName } : {}),
    };
    next();
  } catch (error) {
    next(error);
  }
}

/** Authenticated finance routes require a current active household membership. */
export function auth(req: AuthedRequest, res: Response, next: NextFunction) {
  void authenticate(req, res, next, true);
}

/** Account-level auth is used by invitation acceptance and space discovery. */
export function authAccount(req: AuthedRequest, res: Response, next: NextFunction) {
  void authenticate(req, res, next, false);
}
