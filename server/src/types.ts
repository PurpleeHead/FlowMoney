import type { Request } from 'express';

export type AuthUser = {
  /** Canonical finance owner ID used by existing finance routes. */
  id: string;
  /** The authenticated account ID from the JWT. */
  accountId: string;
  email: string;
  displayName?: string;
  householdId: string;
  role: 'OWNER' | 'MEMBER';
  memberId: string | null;
};

export type AuthedRequest = Request & { user?: AuthUser };
