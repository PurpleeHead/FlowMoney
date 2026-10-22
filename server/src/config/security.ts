export function assertProductionSecurityConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.NODE_ENV !== 'production') return;

  const secret = env.JWT_SECRET;
  if (typeof secret !== 'string' || secret.trim().length < 32) {
    throw new Error(
      'Invalid production security configuration: JWT_SECRET must contain at least 32 non-whitespace characters.',
    );
  }

  const normalized = secret.trim().toLowerCase();
  const knownPlaceholders = new Set([
    'changeme',
    'change-me',
    'replace-me',
    'replace-with',
    'placeholder',
    'example-secret',
    'your-secret',
    'your-jwt-secret',
  ]);
  if ([...knownPlaceholders].some((placeholder) => normalized.includes(placeholder))) {
    throw new Error(
      'Invalid production security configuration: JWT_SECRET must not use a placeholder value.',
    );
  }
}
