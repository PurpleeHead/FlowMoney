export function getHouseholdInviteToken(hash: string, telegramStartParam?: string | null): string | null {
  if (telegramStartParam) return telegramStartParam;
  return new URLSearchParams(hash.replace(/^#/, '')).get('invite');
}
