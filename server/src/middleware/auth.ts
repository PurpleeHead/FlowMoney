import type { NextFunction, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { AuthedRequest } from '../types.js';

export function auth(req: AuthedRequest, res: Response, next: NextFunction) {
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

    req.user = { id: payload.id, email: payload.email, ...(typeof payload.displayName === 'string' ? { displayName: payload.displayName } : {}) };
    next();
  } catch {
    res.status(401).json({ message: 'Session expired. Please sign in again.' });
  }
}
