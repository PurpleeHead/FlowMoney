export type HouseholdErrorLanguage = 'ru' | 'en';

const russianMessages: Record<string, string> = {
  'Only the household owner can manage invitations and access.': 'Только владелец семейного пространства может управлять приглашениями и доступом.',
  'Accept a household invitation to continue.': 'Примите приглашение в семейное пространство, чтобы продолжить.',
  'Household not found.': 'Семейное пространство не найдено.',
  'Enter a household name.': 'Введите название семейного пространства.',
  'Choose a valid household profile.': 'Выберите корректный семейный профиль.',
  'Household member profile not found.': 'Профиль участника семьи не найден.',
  'This profile is already linked to another active account.': 'Этот профиль уже привязан к другой активной учётной записи.',
  'Choose a household member profile for the invitation.': 'Выберите профиль участника семьи для приглашения.',
  'This profile is already linked to an active account.': 'Этот профиль уже привязан к активной учётной записи.',
  'The invitation link is invalid.': 'Ссылка-приглашение недействительна.',
  'This invitation is invalid, expired, revoked or already used.': 'Приглашение недействительно, истекло, отозвано или уже использовано.',
  'The household owner cannot accept their own invitation.': 'Владелец семейного пространства не может принять собственное приглашение.',
  'This account already belongs to another shared household.': 'Этот аккаунт уже состоит в другом общем семейном пространстве.',
  'The household owner cannot leave while other members still have access. Transfer ownership or remove members first.': 'Владелец не может покинуть семейное пространство, пока у других участников есть доступ. Сначала передайте владение или отключите участников.',
  'This household profile is already linked to an active account. Ask the owner to revoke that access before reusing the profile.': 'Этот профиль уже привязан к активному аккаунту. Попросите владельца сначала отключить его доступ.',
  'This invitation was just used or the account already has active household access. Refresh and try again.': 'Приглашение уже использовано или у аккаунта есть активный доступ к семье. Обновите страницу и повторите попытку.',
  'This household profile is already linked to an active account.': 'Этот семейный профиль уже привязан к активной учётной записи.',
  'Revoke the linked account before archiving this profile.': 'Перед архивацией профиля сначала отключите связанный аккаунт.',
  'This household profile changed while you were updating it. Refresh and try again.': 'Профиль семьи изменился во время сохранения. Обновите данные и повторите попытку.',
  'A household member with this name already exists.': 'Участник семьи с таким именем уже существует.',
  'Pending invitation not found.': 'Ожидающее приглашение не найдено.',
  'Active household member not found.': 'Активный участник семейного пространства не найден.',
  'The owner cannot revoke their own access.': 'Владелец не может отключить собственный доступ.',
};

export function householdErrorMessage(
  error: unknown,
  language: HouseholdErrorLanguage,
  fallback: string,
): string {
  const message = error instanceof Error ? error.message : fallback;
  return language === 'ru' ? (russianMessages[message] ?? message) : message;
}
