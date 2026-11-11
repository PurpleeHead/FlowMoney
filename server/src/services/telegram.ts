import { createHmac, timingSafeEqual } from 'node:crypto';

export type VerifiedTelegramUser = { id: string; username?: string; firstName?: string };

export function verifyTelegramInitData(initData: string, botToken: string, nowMs = Date.now()): VerifiedTelegramUser | null {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');
  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) return null;
  const authDate = Number(params.get('auth_date'));
  const nowSeconds = Math.floor(nowMs / 1000);
  if (!Number.isInteger(authDate) || authDate > nowSeconds + 300 || nowSeconds - authDate > 86400) return null;
  const entries = [...params.entries()].filter(([key]) => key !== 'hash').sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = entries.map(([key, value]) => key + '=' + value).join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calculatedHash = createHmac('sha256', secretKey).update(dataCheckString).digest();
  const suppliedHash = Buffer.from(receivedHash, 'hex');
  if (suppliedHash.length !== calculatedHash.length || !timingSafeEqual(suppliedHash, calculatedHash)) return null;
  try {
    const rawUser = params.get('user');
    if (!rawUser) return null;
    const user = JSON.parse(rawUser) as { id?: unknown; username?: unknown; first_name?: unknown };
    if (typeof user.id !== 'number' || !Number.isSafeInteger(user.id) || user.id <= 0) return null;
    return {
      id: String(user.id),
      ...(typeof user.username === 'string' ? { username: user.username.slice(0, 64) } : {}),
      ...(typeof user.first_name === 'string' ? { firstName: user.first_name.slice(0, 128) } : {}),
    };
  } catch { return null; }
}
