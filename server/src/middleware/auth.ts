import type { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import type { AuthedRequest, AuthUser } from '../types.js';

export function auth(req: AuthedRequest, res: Response, next: NextFunction) {
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
      payload.email.trim().length === 0
    ) {
      throw new Error('Invalid token');
    }
    const user: AuthUser = { id: payload.id, email: payload.email };
    req.user = user;
    next();
  } catch {
    res.status(401).json({ message: 'Session expired. Please sign in again.' });
  }
}
