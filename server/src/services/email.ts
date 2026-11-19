type PasswordResetEmail = { to: string; resetUrl: string; locale: 'ru' | 'en' };

export async function sendPasswordResetEmail({ to, resetUrl, locale }: PasswordResetEmail): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) throw new Error('RESEND_API_KEY and RESEND_FROM_EMAIL must be configured');

  const subject = locale === 'en' ? 'Reset your nummioX password' : 'Восстановление пароля nummioX';
  const html = locale === 'en'
    ? `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#202124"><h1>Reset your password</h1><p>We received a request to reset the password for your nummioX account.</p><p><a href="${resetUrl}" style="display:inline-block;padding:12px 20px;background:#6d4aff;color:#fff;text-decoration:none;border-radius:8px">Choose a new password</a></p><p>This link expires in 30 minutes and can only be used once.</p><p>If you did not request this, you can safely ignore this email.</p><p>— nummioX</p></div>`
    : `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#202124"><h1>Восстановление пароля</h1><p>Мы получили запрос на смену пароля вашего аккаунта nummioX.</p><p><a href="${resetUrl}" style="display:inline-block;padding:12px 20px;background:#6d4aff;color:#fff;text-decoration:none;border-radius:8px">Создать новый пароль</a></p><p>Ссылка действует 30 минут и может быть использована только один раз.</p><p>Если вы не запрашивали восстановление, просто проигнорируйте это письмо.</p><p>— nummioX</p></div>`;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, html }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Resend API returned status ${response.status}`);
  }
}
