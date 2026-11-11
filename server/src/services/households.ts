import { randomBytes, createHash } from 'node:crypto';

export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newInvitationToken(): string {
  return randomBytes(32).toString('base64url');
}
