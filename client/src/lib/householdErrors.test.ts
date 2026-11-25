import { describe, expect, it } from 'vitest';
import { householdErrorMessage } from './householdErrors';

describe('householdErrorMessage', () => {
  it('translates known household conflicts into Russian', () => {
    expect(householdErrorMessage(
      new Error('This profile is already linked to another active account.'),
      'ru',
      'Не удалось выполнить действие.',
    )).toBe('Этот профиль уже привязан к другой активной учётной записи.');
  });

  it('translates conflicts when an account already belongs to another shared household', () => {
    expect(householdErrorMessage(
      new Error('This account already belongs to another shared household.'),
      'ru',
      'Не удалось принять приглашение.',
    )).toBe('Этот аккаунт уже состоит в другом общем семейном пространстве.');
  });

  it('keeps the original server message in English', () => {
    const message = 'This household profile changed while you were updating it. Refresh and try again.';
    expect(householdErrorMessage(new Error(message), 'en', 'Fallback')).toBe(message);
  });

  it('does not rewrite unknown server messages', () => {
    const message = 'Unexpected household error.';
    expect(householdErrorMessage(new Error(message), 'ru', 'Fallback')).toBe(message);
  });

  it('uses the supplied fallback for non-Error values', () => {
    expect(householdErrorMessage('offline', 'ru', 'Не удалось загрузить данные.'))
      .toBe('Не удалось загрузить данные.');
  });
});
