import { describe, expect, it } from 'vitest';
import { getHouseholdInviteToken } from './lib/householdInvites';

describe('getHouseholdInviteToken', () => {
  it('reads a browser invitation token from the URL fragment', () => {
    expect(getHouseholdInviteToken('#invite=web-token-123')).toBe('web-token-123');
  });

  it('prefers Telegram start parameters when both sources exist', () => {
    expect(getHouseholdInviteToken('#invite=web-token', 'telegram-token')).toBe('telegram-token');
  });

  it('returns null when no invitation token is present', () => {
    expect(getHouseholdInviteToken('')).toBeNull();
    expect(getHouseholdInviteToken('#tab=expenses')).toBeNull();
  });
});
