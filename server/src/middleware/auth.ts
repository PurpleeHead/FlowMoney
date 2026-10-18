import type { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import type { AuthedRequest, AuthUser } from '../types.js';
import { prisma } from '../services/prisma.js';

export async function auth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ message: 'Please sign in to continue.' });
    return;
  }

  try {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.length < 32) {
      throw new Error('JWT_SECRET must be configured with at least 32 characters');
    }
    const payload = jwt.verify(header.slice(7), secret);
    if (
      typeof payload !== 'object' ||
      payload === null ||
      typeof payload.id !== 'string' ||
      payload.id.trim().length === 0 ||
      typeof payload.email !== 'string' ||
      payload.email.trim().length === 0 ||
      (payload.tokenVersion !== undefined &&
        (typeof payload.tokenVersion !== 'number' ||
          !Number.isInteger(payload.tokenVersion) ||
          payload.tokenVersion < 0))
    ) {
      throw new Error('Invalid token');
    }

    // Tokens issued before this field existed are version 0. Incrementing the
    // database value after a password change invalidates all of those sessions.
    const tokenVersion = payload.tokenVersion ?? 0;
    const userRecord = await prisma.user.findUnique({
      where: { id: payload.id },
      select: { tokenVersion: true },
    });
    if (!userRecord || userRecord.tokenVersion !== tokenVersion) {
      res.status(401).json({ message: 'Session expired. Please sign in again.' });
      return;
    }

    const user: AuthUser = { id: payload.id, email: payload.email };
    req.user = user;
    next();
  } catch {
    res.status(401).json({ message: 'Session expired. Please sign in again.' });
  }
}
