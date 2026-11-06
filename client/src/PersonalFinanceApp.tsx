import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, getToken, setToken } from './lib/api';
import './personalFinance.css';

type Lang = 'ru' | 'en';
type User = { id: string; email: string };
type Member = { id: string; name: string; color?: string | null; isArchived: boolean };
type Category = { id: string; name: string; slug: string; userId: string | null; isArchived: boolean };
type IncomeEntry = { id: string; sourceId?: string | null; plannedDate: string; plannedAmount: number | string; status: string; actualAmount?: number | string | null; memberId?: string | null; member?: Member | null; source?: { title: string } | null };
type ObligationOccurrence = { id: string; dueDate: string; plannedAmount: number | string; status: string; actualAmount?: number | string | null; obligation: { id: string; title: string; category: string; memberId?: string | null; member?: Member | null } };
type Expense = { id: string; title: string; amount: number | string; date: string; memberId?: string | null; category?: Category | null; member?: Member | null; obligationOccurrence?: { id: string } | null; note?: string | null };
type Analytics = { totals: { income: number; expenses: number; obligations: number }; categories: Array<{ name: string; amount: number }>; members: Array<{ name: string; income: number; expenses: number; net: number }>; months: Array<{ month: string; income: number; expenses: number; net: number }> };
type BudgetRecord = { id: string; periodMonth: string; limitAmount: number | string; member?: Member | null; category?: Category | null; memberId?: string | null; categoryId?: string | null };
type SavingsGoal = { id: string; title: string; targetAmount: number | string; currentAmount: number | string; targetDate?: string | null; status: string };
type Dashboard = {
  actual: { income: number; expenses: number; balance: number };
  forecast: { plannedIncome: number; unpaidObligations: number; balance: number };
  obligations: { due: number; paid: number; unpaid: number; coverage: { receivedIncome: number; shortfall: number; surplus: number }; plannedCoverage: { income: number; shortfall: number } };
  nextPayments: ObligationOccurrence[];
};
type Tab = 'overview' | 'income' | 'expenses' | 'obligations' | 'calendar' | 'analytics' | 'budgets' | 'family' | 'settings';

const PF = '/personal-finance';
const translations: Record<string, { ru: string; en: string }> = {
  overview: { ru: 'Обзор', en: 'Overview' }, income: { ru: 'Доходы', en: 'Income' }, expenses: { ru: 'Расходы', en: 'Expenses' }, obligations: { ru: 'Обязательства', en: 'Obligations' }, calendar: { ru: 'Календарь', en: 'Calendar' }, analytics: { ru: 'Аналитика', en: 'Analytics' }, budgets: { ru: 'Бюджеты и цели', en: 'Budgets & goals' }, family: { ru: 'Семья', en: 'Family' }, settings: { ru: 'Настройки', en: 'Settings' },
  actualBalance: { ru: 'Фактический остаток', en: 'Actual balance' }, forecastBalance: { ru: 'Прогнозный остаток', en: 'Forecast balance' }, received: { ru: 'Получено за месяц', en: 'Received this month' }, spent: { ru: 'Потрачено за месяц', en: 'Spent this month' },
  planned: { ru: 'Запланировано', en: 'Planned' }, add: { ru: 'Добавить', en: 'Add' }, date: { ru: 'Дата', en: 'Date' }, amount: { ru: 'Сумма, ₽', en: 'Amount, RUB' }, title: { ru: 'Название', en: 'Title' }, member: { ru: 'Кому', en: 'Member' }, shared: { ru: 'Общее', en: 'Shared' }, category: { ru: 'Категория', en: 'Category' }, note: { ru: 'Комментарий', en: 'Note' }, save: { ru: 'Сохранить', en: 'Save' }, cancel: { ru: 'Отмена', en: 'Cancel' }, loading: { ru: 'Загружаем ваши финансы…', en: 'Loading your finances…' }, logout: { ru: 'Выйти', en: 'Sign out' }, signIn: { ru: 'Войти', en: 'Sign in' }, signUp: { ru: 'Создать аккаунт', en: 'Create account' }, email: { ru: 'Электронная почта', en: 'Email' }, password: { ru: 'Пароль (не менее 8 символов)', en: 'Password (at least 8 characters)' },
  daily: { ru: 'Каждый день', en: 'Daily' }, weekly: { ru: 'Еженедельно', en: 'Weekly' }, twice: { ru: 'Два раза в месяц', en: 'Twice monthly' }, monthly: { ru: 'Ежемесячно', en: 'Monthly' }, yearly: { ru: 'Ежегодно', en: 'Yearly' }, once: { ru: 'Разово', en: 'One-time' }, frequency: { ru: 'Периодичность', en: 'Frequency' }, startDate: { ru: 'Начало', en: 'Start date' }, endDate: { ru: 'Окончание (необязательно)', en: 'End date (optional)' }, firstDay: { ru: 'Первое число', en: 'First day' }, secondDay: { ru: 'Второе число', en: 'Second day' }, day: { ru: 'Число месяца', en: 'Day of month' }, receivedAction: { ru: 'Отметить полученным', en: 'Mark received' }, paidAction: { ru: 'Оплатить', en: 'Mark paid' }, due: { ru: 'К оплате в этом месяце', en: 'Due this month' }, paid: { ru: 'Оплачено', en: 'Paid' }, unpaid: { ru: 'Не оплачено', en: 'Unpaid' }, shortfall: { ru: 'Не хватает', en: 'Shortfall' }, surplus: { ru: 'Остаток после обязательств', en: 'Surplus after obligations' }, upcoming: { ru: 'Ближайшие платежи', en: 'Upcoming payments' }, opening: { ru: 'Начальный остаток / корректировка', en: 'Opening balance / adjustment' }, openingHelp: { ru: 'Укажите сумму со знаком: положительную, если добавляете деньги, отрицательную — если уменьшаете остаток. Начальный остаток учитывается один раз.', en: 'Enter a signed amount: positive adds money, negative reduces it. The opening balance is recorded once as an adjustment.' }, reason: { ru: 'Причина корректировки', en: 'Adjustment reason' }, newMember: { ru: 'Имя участника семьи', en: 'Family member name' }, addMember: { ru: 'Добавить участника', en: 'Add member' }, addCategory: { ru: 'Новая категория', en: 'New category' }, noData: { ru: 'Пока нет записей', en: 'Nothing here yet' }, forecastInfo: { ru: 'Прогноз учитывает запланированные поступления и неоплаченные обязательства. Не полученные деньги не входят в фактический остаток.', en: 'Forecast includes planned income and unpaid obligations. Unreceived money is excluded from actual balance.' }, coverageInfo: { ru: 'Сравнение полученных доходов с суммой обязательств за выбранный месяц.', en: 'Received income compared with obligations due this month.' }, overdue: { ru: 'Просрочено', en: 'Overdue' }, plannedStatus: { ru: 'Ожидается', en: 'Planned' }, actualStatus: { ru: 'Получено', en: 'Received' }, paidStatus: { ru: 'Оплачено', en: 'Paid' }, addExpense: { ru: 'Новый расход', en: 'New expense' }, addIncome: { ru: 'Новый источник дохода', en: 'New income source' }, addObligation: { ru: 'Новое обязательство', en: 'New obligation' }, signInTitle: { ru: 'Ваш семейный бюджет', en: 'Your family budget' }, signInText: { ru: 'Доходы, расходы и обязательные платежи — в одном месте.', en: 'Income, expenses and recurring commitments in one place.' }, emptyTitle: { ru: 'Пока нет данных', en: 'No data yet' }, refresh: { ru: 'Обновить', en: 'Refresh' }
};
function tr(lang: Lang, key: string) { return translations[key]?.[lang] ?? key; }
function todayInTimezone(timeZone = 'Europe/Moscow') {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
const moscowToday = () => todayInTimezone();
function monthBounds(timeZone = 'Europe/Moscow', selectedMonth = todayInTimezone(timeZone).slice(0, 7)) {
  const [year, month] = selectedMonth.split('-').map(Number);
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const last = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  const horizon = new Date(Date.UTC(year, month + 3, 0)).toISOString().slice(0, 10);
  const analyticsFrom = new Date(Date.UTC(year, month - 6, 1)).toISOString().slice(0, 10);
  return { from, to: last, horizon, analyticsFrom };
}
function rub(value: number | string | null | undefined) {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2 }).format(Number(value ?? 0));
}
function categoryName(category: Category, lang: Lang) {
  if (lang === 'en' || category.userId) return category.name;
  const labels: Record<string, string> = {
    groceries: 'Продукты', 'cafes-restaurants': 'Кафе и рестораны', coffee: 'Кофе',
    'transport-taxi': 'Транспорт и такси', fuel: 'Топливо', 'car-repair': 'Ремонт авто',
    'car-maintenance': 'ТО и обслуживание', 'housing-home': 'Дом и жильё', health: 'Здоровье',
    entertainment: 'Развлечения', shopping: 'Покупки', subscriptions: 'Подписки',
    education: 'Образование', travel: 'Путешествия', other: 'Другое',
  };
  return labels[category.slug] ?? category.name;
}

function dateLabel(value: string, lang: Lang) {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  return new Intl.DateTimeFormat(lang === 'ru' ? 'ru-RU' : 'en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, day)));
}

export default function PersonalFinanceApp() {
  const [lang, setLang] = useState<Lang>('ru');
  const [timezone, setTimezone] = useState('Europe/Moscow');
  const [openingBalance, setOpeningBalance] = useState('0');
  const [openingBalanceDate, setOpeningBalanceDate] = useState(moscowToday());
  const [selectedMonth, setSelectedMonth] = useState(moscowToday().slice(0, 7));
  const [user, setUser] = useState<User | null>(null);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tab, setTab] = useState<Tab>('overview');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [budgets, setBudgets] = useState<BudgetRecord[]>([]);
  const [goals, setGoals] = useState<SavingsGoal[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [filterMember, setFilterMember] = useState('all');
  const [filterCategory, setFilterCategory] = useState('all');
  const [expensePeriod, setExpensePeriod] = useState<'month' | 'all'>('month');
  const [categories, setCategories] = useState<Category[]>([]);
  const [incomeEntries, setIncomeEntries] = useState<IncomeEntry[]>([]);
  const [obligationOccurrences, setObligationOccurrences] = useState<ObligationOccurrence[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [adjustments, setAdjustments] = useState<Array<{ id: string; amount: number | string; date: string; reason: string }>>([]);

  const [incomeTitle, setIncomeTitle] = useState('Зарплата');
  const [incomeAmount, setIncomeAmount] = useState('5000');
  const [incomeRecurrence, setIncomeRecurrence] = useState('DAILY');
  const [incomeStart, setIncomeStart] = useState(moscowToday());
  const [incomeEnd, setIncomeEnd] = useState('');
  const [incomeDay1, setIncomeDay1] = useState('1');
  const [incomeDay2, setIncomeDay2] = useState('15');
  const [incomeWeekday, setIncomeWeekday] = useState('1');
  const [incomeIntervalWeeks, setIncomeIntervalWeeks] = useState('1');
  const [incomeMember, setIncomeMember] = useState('');
  const [editingIncomeId, setEditingIncomeId] = useState<string | null>(null);
  const [incomeEditDate, setIncomeEditDate] = useState(moscowToday());
  const [incomeEditAmount, setIncomeEditAmount] = useState('');
  const [expenseTitle, setExpenseTitle] = useState('');
  const [expenseAmount, setExpenseAmount] = useState('');
  const [expenseDate, setExpenseDate] = useState(moscowToday());
  const [expenseCategory, setExpenseCategory] = useState('');
  const [expenseMember, setExpenseMember] = useState('');
  const [editingExpenseId, setEditingExpenseId] = useState<string | null>(null);
  const [obligationTitle, setObligationTitle] = useState('');
  const [obligationCategory, setObligationCategory] = useState('Кредит');
  const [obligationAmount, setObligationAmount] = useState('');
  const [obligationRecurrence, setObligationRecurrence] = useState('MONTHLY');
  const [obligationDate, setObligationDate] = useState(moscowToday());
  const [obligationDay, setObligationDay] = useState('13');
  const [obligationWeekday, setObligationWeekday] = useState('1');
  const [obligationIntervalWeeks, setObligationIntervalWeeks] = useState('1');
  const [obligationMember, setObligationMember] = useState('');
  const [editingObligationId, setEditingObligationId] = useState<string | null>(null);
  const [openingAmount, setOpeningAmount] = useState('');
  const [openingReason, setOpeningReason] = useState('Начальный остаток');
  const [newMemberName, setNewMemberName] = useState('');
  const [newCategoryName, setNewCategoryName] = useState('');
  const [budgetLimit, setBudgetLimit] = useState('');
  const [budgetCategory, setBudgetCategory] = useState('');
  const [budgetMember, setBudgetMember] = useState('');
  const [goalTitle, setGoalTitle] = useState('');
  const [goalTarget, setGoalTarget] = useState('');
  const [goalCurrent, setGoalCurrent] = useState('0');
  const [goalDate, setGoalDate] = useState('');

  const ranges = useMemo(() => monthBounds(timezone, selectedMonth), [timezone, selectedMonth]);
  const refresh = useCallback(async () => {
    const [dash, income, expenseData, obligations, memberData, adjustmentData, analyticsData, budgetData, goalData, settingsData] = await Promise.all([
      api<Dashboard>(`${PF}/dashboard?from=${ranges.from}&to=${ranges.to}&horizon=${ranges.horizon}${filterMember !== 'all' ? `&memberId=${filterMember}` : ''}`),
      api<{ entries: IncomeEntry[] }>(`${PF}/income-sources?from=${ranges.from}&to=${ranges.horizon}`),
      api<{ expenses: Expense[]; categories: Category[] }>(`${PF}/expenses`),
      api<{ occurrences: ObligationOccurrence[] }>(`${PF}/obligations?from=${ranges.from}&to=${ranges.horizon}`),
      api<Member[]>(`${PF}/members`),
      api<Array<{ id: string; amount: number | string; date: string; reason: string }>>(`${PF}/balance-adjustments`),
      api<Analytics>(`${PF}/analytics?from=${ranges.analyticsFrom}&to=${ranges.to}${filterMember !== 'all' ? `&memberId=${filterMember}` : ''}`),
      api<BudgetRecord[]>(`${PF}/budgets?month=${ranges.from}`),
      api<SavingsGoal[]>(`${PF}/savings-goals`),
      api<{ timezone: string; locale: Lang; openingBalance: number | string; openingBalanceDate: string }>(`${PF}/settings`)
    ]);
    setDashboard(dash); setIncomeEntries(income.entries); setExpenses(expenseData.expenses); setCategories(expenseData.categories.filter(x => !x.isArchived)); setObligationOccurrences(obligations.occurrences); setMembers(memberData.filter(x => !x.isArchived)); setAdjustments(adjustmentData); setAnalytics(analyticsData); setBudgets(budgetData); setGoals(goalData); setTimezone(settingsData.timezone); setLang(settingsData.locale); setOpeningBalance(String(settingsData.openingBalance)); setOpeningBalanceDate(settingsData.openingBalanceDate.slice(0, 10));
    if (!expenseData.categories.some(x => x.id === expenseCategory && !x.isArchived)) setExpenseCategory(expenseData.categories.find(x => !x.isArchived)?.id ?? '');
  }, [ranges, expenseCategory, filterMember]);

  useEffect(() => {
    const token = getToken();
    if (!token) { setLoading(false); return; }
    api<User>('/auth/me').then(async current => { setUser(current); await refresh(); }).catch(() => { setToken(null); }).finally(() => setLoading(false));
  }, [refresh]);

  async function saveOpeningBalance() { const amount = Number(openingBalance); if (!Number.isFinite(amount)) { setError(lang === 'ru' ? 'Введите корректную сумму начального остатка.' : 'Enter a valid opening balance.'); return; } setBusy(true); setError(''); try { await api(`${PF}/settings`, { method: 'PATCH', body: JSON.stringify({ openingBalance: amount, openingBalanceDate }) }); await refresh(); setNotice(lang === 'ru' ? 'Начальный остаток сохранён.' : 'Opening balance saved.'); } catch (e) { setError(e instanceof Error ? e.message : 'Error'); } finally { setBusy(false); } }
  async function changeLanguage(next: Lang) { setLang(next); if (user) { try { await api(`${PF}/settings`, { method: 'PATCH', body: JSON.stringify({ locale: next }) }); } catch (e) { setError(e instanceof Error ? e.message : 'Error'); } } }
  async function changeTimezone(next: string) { setTimezone(next); const today = todayInTimezone(next); setSelectedMonth(today.slice(0,7)); setIncomeStart(today); setExpenseDate(today); setObligationDate(today); try { await api(`${PF}/settings`, { method: 'PATCH', body: JSON.stringify({ timezone: next }) }); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : 'Error'); } }
  async function handleAuth(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const result = await api<{ token: string; user: User }>(authMode === 'login' ? '/auth/login' : '/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) });
      setToken(result.token); setUser(result.user); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось выполнить вход.'); }
    finally { setBusy(false); setLoading(false); }
  }
  async function perform(event: FormEvent, path: string, body: unknown, success: string, method = 'POST') {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try { await api(path, { method, body: JSON.stringify(body) }); await refresh(); setNotice(success); if (path.includes('/expenses/') && method === 'PATCH') setEditingExpenseId(null); if (path.includes('/obligations/') && method === 'PATCH') setEditingObligationId(null); }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось сохранить данные.'); }
    finally { setBusy(false); }
  }
  async function markReceived(id: string) {
    setBusy(true); setError('');
    try { await api(`${PF}/income-entries/${id}/receive`, { method: 'POST', body: JSON.stringify({}) }); await refresh(); setNotice(lang === 'ru' ? 'Доход отмечен как полученный.' : 'Income marked as received.'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Error'); } finally { setBusy(false); }
  }
  async function saveIncomeEdit(id: string) {
    setBusy(true); setError('');
    try { await api(`${PF}/income-entries/${id}`, { method: 'PATCH', body: JSON.stringify({ plannedDate: incomeEditDate, plannedAmount: Number(incomeEditAmount) }) }); setEditingIncomeId(null); await refresh(); setNotice(lang === 'ru' ? 'Плановый доход обновлён.' : 'Planned income updated.'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Error'); } finally { setBusy(false); }
  }
  async function skipIncomeEntry(id: string) { setBusy(true); try { await api(`${PF}/income-entries/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'SKIPPED' }) }); await refresh(); setNotice(lang === 'ru' ? 'Плановое поступление пропущено.' : 'Planned income skipped.'); } catch (e) { setError(e instanceof Error ? e.message : 'Error'); } finally { setBusy(false); } }
  async function deleteIncomeSource(id: string) {
    if (!window.confirm(lang === 'ru' ? 'Отключить этот источник дохода и отменить будущие поступления?' : 'Archive this income source and skip future entries?')) return;
    setBusy(true); try { await api(`${PF}/income-sources/${id}`, { method: 'DELETE' }); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : 'Error'); } finally { setBusy(false); }
  }
  async function deleteObligation(id: string) {
    if (!window.confirm(lang === 'ru' ? 'Отключить это обязательство?' : 'Archive this obligation?')) return;
    setBusy(true); try { await api(`${PF}/obligations/${id}`, { method: 'DELETE' }); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : 'Error'); } finally { setBusy(false); }
  }
  async function skipObligation(id: string) { setBusy(true); try { await api(`${PF}/obligation-occurrences/${id}/skip`, { method: 'POST', body: JSON.stringify({}) }); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : 'Error'); } finally { setBusy(false); } }
  async function markPaid(id: string) {
    setBusy(true); setError('');
    try { await api(`${PF}/obligation-occurrences/${id}/pay`, { method: 'POST', body: JSON.stringify({}) }); await refresh(); setNotice(lang === 'ru' ? 'Платёж отмечен оплаченным и добавлен в расходы один раз.' : 'Payment marked paid and recorded as one expense.'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Error'); } finally { setBusy(false); }
  }
  async function removeExpense(id: string) {
    if (!window.confirm(lang === 'ru' ? 'Удалить этот расход?' : 'Delete this expense?')) return;
    setBusy(true); try { await api(`${PF}/expenses/${id}`, { method: 'DELETE' }); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : 'Error'); } finally { setBusy(false); }
  }
  async function renameMember(member: Member) { const name = window.prompt(lang === 'ru' ? 'Имя участника' : 'Member name', member.name); if (!name?.trim()) return; setBusy(true); try { await api(`${PF}/members/${member.id}`, { method: 'PATCH', body: JSON.stringify({ name: name.trim() }) }); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : 'Error'); } finally { setBusy(false); } }
  async function archiveMember(member: Member) { if (!window.confirm(lang === 'ru' ? 'Убрать участника из списка? Старые операции сохранят привязку.' : 'Archive this member? Historical transactions keep the attribution.')) return; setBusy(true); try { await api(`${PF}/members/${member.id}`, { method: 'PATCH', body: JSON.stringify({ isArchived: true }) }); await refresh(); if (filterMember === member.id) setFilterMember('all'); } catch (e) { setError(e instanceof Error ? e.message : 'Error'); } finally { setBusy(false); } }
  async function addMember(event: FormEvent) {
    event.preventDefault(); if (!newMemberName.trim()) return; setBusy(true);
    try { await api(`${PF}/members`, { method: 'POST', body: JSON.stringify({ name: newMemberName.trim() }) }); setNewMemberName(''); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Error'); } finally { setBusy(false); }
  }
  async function deleteBudget(id: string) { setBusy(true); try { await api(`${PF}/budgets/${id}`, { method: 'DELETE' }); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : 'Error'); } finally { setBusy(false); } }
  async function deleteGoal(id: string) { setBusy(true); try { await api(`${PF}/savings-goals/${id}`, { method: 'DELETE' }); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : 'Error'); } finally { setBusy(false); } }
  async function addGoalContribution(goal: SavingsGoal) { const raw = window.prompt(lang === 'ru' ? 'Сколько добавить к накоплениям?' : 'How much would you like to add?'); if (raw === null) return; const amount = Number(raw); if (!Number.isFinite(amount) || amount <= 0) { setError(lang === 'ru' ? 'Введите положительную сумму.' : 'Enter a positive amount.'); return; } setBusy(true); try { await api(`${PF}/savings-goals/${goal.id}`, { method: 'PATCH', body: JSON.stringify({ currentAmount: Number(goal.currentAmount) + amount, status: Number(goal.currentAmount) + amount >= Number(goal.targetAmount) ? 'COMPLETED' : 'ACTIVE' }) }); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : 'Error'); } finally { setBusy(false); } }
  async function renameCategory(category: Category) { const name = window.prompt(lang === 'ru' ? 'Новое название категории' : 'New category name', category.name); if (!name?.trim()) return; setBusy(true); try { await api(`${PF}/categories/${category.id}`, { method: 'PATCH', body: JSON.stringify({ name: name.trim() }) }); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : 'Error'); } finally { setBusy(false); } }
  async function archiveCategory(category: Category) { if (!window.confirm(lang === 'ru' ? 'Архивировать категорию? Старые расходы сохранят её.' : 'Archive this category? Historical expenses will keep it.')) return; setBusy(true); try { await api(`${PF}/categories/${category.id}`, { method: 'PATCH', body: JSON.stringify({ isArchived: true }) }); if (filterCategory === category.id) setFilterCategory('all'); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : 'Error'); } finally { setBusy(false); } }
  async function addCategory(event: FormEvent) {
    event.preventDefault(); const name = newCategoryName.trim(); if (!name) return;
    const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `category-${Date.now()}`;
    setBusy(true); try { await api(`${PF}/categories`, { method: 'POST', body: JSON.stringify({ name, slug }) }); setNewCategoryName(''); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Error'); } finally { setBusy(false); }
  }

  if (loading) return <div className="pf-loading"><div className="pf-brand">FLOW<span>MONEY</span></div><div className="pf-spinner"/><p>{tr(lang, 'loading')}</p></div>;
  if (!user) return <main className="pf-auth">
    <div className="pf-auth-card">
      <div className="pf-brand">FLOW<span>MONEY</span></div>
      <div className="pf-auth-icon">₽</div>
      <h1>{tr(lang, 'signInTitle')}</h1><p>{tr(lang, 'signInText')}</p>
      {error && <div className="pf-alert error">{error}</div>}
      <form onSubmit={handleAuth} className="pf-form">
        <label>{tr(lang, 'email')}<input type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} /></label>
        <label>{tr(lang, 'password')}<input type="password" autoComplete={authMode === 'login' ? 'current-password' : 'new-password'} minLength={8} required value={password} onChange={e => setPassword(e.target.value)} /></label>
        <button className="pf-button primary" disabled={busy}>{busy ? '…' : tr(lang, authMode === 'login' ? 'signIn' : 'signUp')}</button>
      </form>
      <button className="pf-link" onClick={() => { setAuthMode(authMode === 'login' ? 'register' : 'login'); setError(''); }}>{authMode === 'login' ? tr(lang, 'signUp') : tr(lang, 'signIn')}</button>
      <button className="pf-language" onClick={() => setLang(lang === 'ru' ? 'en' : 'ru')}>{lang === 'ru' ? '🇬🇧 English' : '🇷🇺 Русский'}</button>
    </div>
  </main>;

  const memberOptions = <><option value="">{tr(lang, 'shared')}</option>{members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</>;
  const matchesMember = (id?: string | null) => filterMember === 'all' || (filterMember === 'shared' ? !id : id === filterMember);
  const visibleIncome = incomeEntries.filter(entry => entry.status !== 'SKIPPED' && matchesMember(entry.memberId ?? entry.member?.id));
  const memberExpenses = expenses.filter(item => matchesMember(item.memberId ?? item.member?.id));
  const visibleExpenses = memberExpenses.filter(item => (filterCategory === 'all' || item.category?.id === filterCategory) && (expensePeriod === 'all' || (item.date >= ranges.from && item.date <= ranges.to)));
  const visibleObligations = obligationOccurrences.filter(item => matchesMember(item.obligation.memberId));
  const monthIncome = visibleIncome.filter(entry => entry.plannedDate >= ranges.from && entry.plannedDate <= ranges.to);
  const monthObligations = visibleObligations.filter(item => item.dueDate >= ranges.from && item.dueDate <= ranges.to);
  const visibleBudgets = budgets.filter(item => matchesMember(item.memberId));
  const analyticsMax = analytics ? Math.max(1, ...analytics.months.flatMap(item => [item.income, item.expenses])) : 1;
  const calendarEvents = [
    ...visibleIncome.filter(x => x.plannedDate >= ranges.from && x.plannedDate <= ranges.to).map(x => ({ date: x.plannedDate.slice(0,10), title: x.source?.title ?? (lang === 'ru' ? 'Доход' : 'Income'), amount: Number(x.actualAmount ?? x.plannedAmount), kind: 'income' as const, status: x.status })),
    ...memberExpenses.filter(x => !x.obligationOccurrence && x.date >= ranges.from && x.date <= ranges.to).map(x => ({ date: x.date.slice(0,10), title: x.title, amount: Number(x.amount), kind: 'expense' as const, status: 'ACTUAL' })),
    ...monthObligations.map(x => ({ date: x.dueDate.slice(0,10), title: x.obligation.title, amount: Number(x.actualAmount ?? x.plannedAmount), kind: 'obligation' as const, status: x.status })),
  ].sort((a,b) => a.date.localeCompare(b.date));
  const monthParts = ranges.from.split('-').map(Number);
  const calendarDayCount = new Date(Date.UTC(monthParts[0], monthParts[1], 0)).getUTCDate();
  const calendarOffset = new Date(Date.UTC(monthParts[0], monthParts[1]-1, 1)).getUTCDay();
  const calendarCells: Array<number | null> = [...Array(calendarOffset).fill(null), ...Array.from({ length: calendarDayCount }, (_, i) => i + 1)];

  return <div className="pf-shell">
    <aside className="pf-sidebar">
      <div className="pf-brand">FLOW<span>MONEY</span></div>
      <div className="pf-sidebar-caption">{lang === 'ru' ? 'СЕМЕЙНЫЕ ФИНАНСЫ' : 'HOUSEHOLD FINANCE'}</div>
      <nav>{(['overview', 'income', 'expenses', 'obligations', 'calendar', 'analytics', 'budgets', 'family', 'settings'] as Tab[]).map(item => <button key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}><span className="pf-nav-dot"/>{tr(lang, item)}</button>)}</nav>
      <div className="pf-sidebar-bottom"><div className="pf-avatar">{user.email[0].toUpperCase()}</div><div className="pf-user"><strong>{user.email.split('@')[0]}</strong><small>{user.email}</small></div><button className="pf-icon-button" title={tr(lang, 'logout')} onClick={() => { setToken(null); setUser(null); }}>↪</button></div>
    </aside>
    <main className="pf-main">
      <header className="pf-topbar"><div><span className="pf-eyebrow">{lang === 'ru' ? 'ЛИЧНЫЙ ФИНАНСОВЫЙ ПЛАН' : 'PERSONAL FINANCE'}</span><h1>{tr(lang, tab)}</h1><p>{new Intl.DateTimeFormat(lang === 'ru' ? 'ru-RU' : 'en-GB', { month: 'long', year: 'numeric', timeZone: timezone }).format(new Date(ranges.from + 'T00:00:00.000Z'))}</p></div><div className="pf-top-actions"><input className="pf-month-filter" type="month" value={selectedMonth} onChange={e => { if (e.target.value) setSelectedMonth(e.target.value); }} aria-label={lang === 'ru' ? 'Выбранный месяц' : 'Selected month'}/><select className="pf-member-filter" value={filterMember} onChange={e => setFilterMember(e.target.value)} aria-label={tr(lang, 'member')}><option value="all">{lang === 'ru' ? 'Вся семья' : 'Whole household'}</option><option value="shared">{tr(lang, 'shared')}</option>{members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select><button className="pf-language" onClick={() => changeLanguage(lang === 'ru' ? 'en' : 'ru')}>{lang === 'ru' ? '🇬🇧 EN' : '🇷🇺 RU'}</button><button className="pf-button ghost" onClick={() => refresh()}>{tr(lang, 'refresh')} ↻</button></div></header>
      {error && <div className="pf-alert error">{error}<button onClick={() => setError('')}>×</button></div>}
      {notice && <div className="pf-alert success">{notice}<button onClick={() => setNotice('')}>×</button></div>}

      {tab === 'overview' && dashboard && <div className="pf-page">
        <section className="pf-balance-grid">
          <article className="pf-balance-card primary-balance"><span>{tr(lang, 'actualBalance')}</span><strong>{rub(dashboard.actual.balance)}</strong><small>{lang === 'ru' ? 'Реальные деньги на основе записей' : 'Real cash based on recorded transactions'}</small></article>
          <article className="pf-balance-card forecast-balance"><span>{tr(lang, 'forecastBalance')}</span><strong>{rub(dashboard.forecast.balance)}</strong><small>{tr(lang, 'forecastInfo')}</small></article>
        </section>
        <section className="pf-metric-grid">
          <article><span>{tr(lang, 'received')}</span><strong className="positive">{rub(dashboard.actual.income)}</strong></article>
          <article><span>{tr(lang, 'spent')}</span><strong>{rub(dashboard.actual.expenses)}</strong></article>
          <article><span>{tr(lang, 'planned')}</span><strong>{rub(dashboard.forecast.plannedIncome)}</strong></article>
          <article><span>{tr(lang, 'due')}</span><strong>{rub(dashboard.obligations.due)}</strong></article>
        </section>
        <section className="pf-two-col">
          <article className="pf-card"><div className="pf-card-heading"><div><span className="pf-eyebrow">{lang === 'ru' ? 'ОБЯЗАТЕЛЬНЫЕ ПЛАТЕЖИ' : 'COMMITMENTS'}</span><h2>{lang === 'ru' ? 'Покрытие обязательств' : 'Obligation coverage'}</h2></div><span className="pf-heading-icon">◎</span></div>
            <div className="pf-coverage-number">{dashboard.obligations.coverage.shortfall > 0 ? <><strong className="negative">{rub(dashboard.obligations.coverage.shortfall)}</strong><span>{tr(lang, 'shortfall')}</span></> : <><strong className="positive">{rub(dashboard.obligations.coverage.surplus)}</strong><span>{tr(lang, 'surplus')}</span></>}</div>
            <div className="pf-coverage-track"><span style={{ width: `${dashboard.obligations.due ? Math.min(100, dashboard.obligations.coverage.receivedIncome / dashboard.obligations.due * 100) : 100}%` }}/></div>
            <div className="pf-split"><span>{tr(lang, 'paid')}: {rub(dashboard.obligations.paid)}</span><span>{tr(lang, 'unpaid')}: {rub(dashboard.obligations.unpaid)}</span></div>
            <p className="pf-muted">{tr(lang, 'coverageInfo')}</p>
            <div className="pf-planned-coverage">{lang === 'ru' ? 'С учётом ожидаемых доходов:' : 'Including planned income:'} <strong>{rub(dashboard.obligations.plannedCoverage.income)}</strong> · {lang === 'ru' ? 'не хватает' : 'short'} <strong>{rub(dashboard.obligations.plannedCoverage.shortfall)}</strong></div>
          </article>
          <article className="pf-card"><div className="pf-card-heading"><div><span className="pf-eyebrow">{lang === 'ru' ? 'КАЛЕНДАРЬ ПЛАТЕЖЕЙ' : 'PAYMENT CALENDAR'}</span><h2>{tr(lang, 'upcoming')}</h2></div><button className="pf-link" onClick={() => setTab('obligations')}>{lang === 'ru' ? 'Все' : 'All'} →</button></div>
            {dashboard.nextPayments.length ? dashboard.nextPayments.slice(0, 5).map(p => <div className="pf-list-row" key={p.id}><div><strong>{p.obligation.title}</strong><small>{dateLabel(p.dueDate, lang)} · {p.status === 'OVERDUE' ? tr(lang, 'overdue') : tr(lang, 'unpaid')}</small></div><b>{rub(p.plannedAmount)}</b></div>) : <p className="pf-empty">{tr(lang, 'noData')}</p>}
          </article>
        </section>
        <section className="pf-card pf-adjustment-card"><div className="pf-card-heading"><div><span className="pf-eyebrow">{lang === 'ru' ? 'НАСТРОЙКА БАЛАНСА' : 'BALANCE SETUP'}</span><h2>{tr(lang, 'opening')}</h2></div></div><p className="pf-muted">{tr(lang, 'openingHelp')}</p>
          <form className="pf-inline-form" onSubmit={e => perform(e, `${PF}/balance-adjustments`, { amount: Number(openingAmount), date: moscowToday(), reason: openingReason }, lang === 'ru' ? 'Корректировка баланса сохранена.' : 'Balance adjustment saved.')}>
            <label>{tr(lang, 'amount')}<input type="number" step="0.01" required value={openingAmount} onChange={e => setOpeningAmount(e.target.value)} placeholder="0.00"/></label>
            <label>{tr(lang, 'reason')}<input required value={openingReason} onChange={e => setOpeningReason(e.target.value)}/></label>
            <button className="pf-button primary" disabled={busy}>{tr(lang, 'save')}</button>
          </form>
          {adjustments.length > 0 && <small className="pf-muted">{lang === 'ru' ? 'Корректировок записано:' : 'Adjustments recorded:'} {adjustments.length}</small>}
        </section>
      </div>}

      {tab === 'income' && <div className="pf-page pf-two-col">
        <section className="pf-card"><div className="pf-card-heading"><div><span className="pf-eyebrow">{lang === 'ru' ? 'ПЛАНИРОВАНИЕ ПОСТУПЛЕНИЙ' : 'INCOME PLANNING'}</span><h2>{tr(lang, 'addIncome')}</h2></div></div>
          <form className="pf-form" onSubmit={e => perform(e, `${PF}/income-sources`, { title: incomeTitle, amount: Number(incomeAmount), recurrence: incomeRecurrence, recurrenceConfig: incomeRecurrence === 'WEEKLY' ? { weekdays: [Number(incomeWeekday)], intervalWeeks: Number(incomeIntervalWeeks) } : incomeRecurrence === 'TWICE_MONTHLY' ? { firstDay: Number(incomeDay1), secondDay: Number(incomeDay2) } : incomeRecurrence === 'MONTHLY' ? { day: Number(incomeDay1) } : {}, startDate: incomeStart, endDate: incomeEnd || null, memberId: incomeMember || null }, lang === 'ru' ? 'Источник дохода добавлен.' : 'Income source added.')}>
            <label>{tr(lang, 'title')}<input required value={incomeTitle} onChange={e => setIncomeTitle(e.target.value)}/></label>
            <label>{tr(lang, 'amount')}<input type="number" min="0.01" step="0.01" required value={incomeAmount} onChange={e => setIncomeAmount(e.target.value)}/></label>
            <label>{tr(lang, 'frequency')}<select value={incomeRecurrence} onChange={e => setIncomeRecurrence(e.target.value)}><option value="DAILY">{tr(lang, 'daily')}</option><option value="WEEKLY">{tr(lang, 'weekly')}</option><option value="TWICE_MONTHLY">{tr(lang, 'twice')}</option><option value="MONTHLY">{tr(lang, 'monthly')}</option><option value="YEARLY">{tr(lang, 'yearly')}</option><option value="ONCE">{tr(lang, 'once')}</option></select></label>
            {incomeRecurrence === 'WEEKLY' && <div className="pf-field-row"><label>{lang === 'ru' ? 'День недели' : 'Weekday'}<select value={incomeWeekday} onChange={e => setIncomeWeekday(e.target.value)}>{(lang === 'ru' ? ['Воскресенье','Понедельник','Вторник','Среда','Четверг','Пятница','Суббота'] : ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']).map((d,i)=><option key={d} value={i}>{d}</option>)}</select></label><label>{lang === 'ru' ? 'Каждые N недель' : 'Every N weeks'}<input type="number" min="1" max="52" value={incomeIntervalWeeks} onChange={e=>setIncomeIntervalWeeks(e.target.value)}/></label></div>}
            {['TWICE_MONTHLY','MONTHLY'].includes(incomeRecurrence) && <div className="pf-field-row"><label>{incomeRecurrence === 'MONTHLY' ? tr(lang, 'day') : tr(lang, 'firstDay')}<input type="number" min="1" max="31" value={incomeDay1} onChange={e => setIncomeDay1(e.target.value)}/></label>{incomeRecurrence === 'TWICE_MONTHLY' && <label>{tr(lang, 'secondDay')}<input type="number" min="1" max="31" value={incomeDay2} onChange={e => setIncomeDay2(e.target.value)}/></label>}</div>}
            <div className="pf-field-row"><label>{tr(lang, 'startDate')}<input type="date" required value={incomeStart} onChange={e => setIncomeStart(e.target.value)}/></label><label>{tr(lang, 'endDate')}<input type="date" value={incomeEnd} onChange={e => setIncomeEnd(e.target.value)}/></label></div>
            <label>{tr(lang, 'member')}<select value={incomeMember} onChange={e => setIncomeMember(e.target.value)}>{memberOptions}</select></label>
            <button className="pf-button primary" disabled={busy}>{tr(lang, 'add')}</button>
          </form>
        </section>
        <section className="pf-card"><div className="pf-card-heading"><div><span className="pf-eyebrow">{lang === 'ru' ? 'ОЖИДАЕМЫЕ И ФАКТИЧЕСКИЕ' : 'PLANNED AND RECEIVED'}</span><h2>{tr(lang, 'income')}</h2></div><span className="pf-count">{monthIncome.length}</span></div>
          {visibleIncome.length ? visibleIncome.map(entry => <div className="pf-list-row" key={entry.id}><div><strong>{entry.source?.title ?? (lang === 'ru' ? 'Разовый доход' : 'One-time income')}</strong><small>{dateLabel(entry.plannedDate, lang)} · {entry.member?.name ?? tr(lang, 'shared')}</small><small className={entry.status === 'RECEIVED' ? 'positive' : ''}>{entry.status === 'RECEIVED' ? tr(lang, 'actualStatus') : tr(lang, 'plannedStatus')}</small>{editingIncomeId === entry.id && <div className="pf-inline-edit"><input aria-label={tr(lang, 'date')} type="date" value={incomeEditDate} onChange={e => setIncomeEditDate(e.target.value)}/><input aria-label={tr(lang, 'amount')} type="number" min="0.01" step="0.01" value={incomeEditAmount} onChange={e => setIncomeEditAmount(e.target.value)}/><button className="pf-button small" disabled={busy} onClick={() => saveIncomeEdit(entry.id)}>{tr(lang, 'save')}</button></div>}</div><div className="pf-row-action"><b>{rub(entry.actualAmount ?? entry.plannedAmount)}</b>{entry.status === 'PLANNED' && <><button className="pf-edit" title={lang === 'ru' ? 'Изменить план' : 'Edit plan'} onClick={() => { setEditingIncomeId(entry.id); setIncomeEditDate(entry.plannedDate.slice(0,10)); setIncomeEditAmount(String(entry.plannedAmount)); }}>✎</button><button className="pf-button small" disabled={busy} onClick={() => markReceived(entry.id)}>{tr(lang, 'receivedAction')}</button><button className="pf-delete" title={lang === 'ru' ? 'Пропустить поступление' : 'Skip income'} onClick={() => skipIncomeEntry(entry.id)}>×</button>{entry.sourceId && <button className="pf-delete" title={lang === 'ru' ? 'Отключить источник' : 'Archive source'} onClick={() => deleteIncomeSource(entry.sourceId!)}>⨯</button>}</>}</div></div>) : <p className="pf-empty">{tr(lang, 'noData')}</p>}
        </section>
      </div>}

      {tab === 'expenses' && <div className="pf-page pf-two-col">
        <section className="pf-card"><div className="pf-card-heading"><div><span className="pf-eyebrow">{lang === 'ru' ? 'УЧЁТ ПОКУПОК' : 'TRANSACTION TRACKING'}</span><h2>{editingExpenseId ? (lang === 'ru' ? 'Изменить расход' : 'Edit expense') : tr(lang, 'addExpense')}</h2></div></div>
          <form className="pf-form" onSubmit={e => perform(e, editingExpenseId ? `${PF}/expenses/${editingExpenseId}` : `${PF}/expenses`, { title: expenseTitle, amount: Number(expenseAmount), date: expenseDate, categoryId: expenseCategory || null, memberId: expenseMember || null }, editingExpenseId ? (lang === 'ru' ? 'Расход обновлён.' : 'Expense updated.') : (lang === 'ru' ? 'Расход добавлен.' : 'Expense added.'), editingExpenseId ? 'PATCH' : 'POST')}>
            <label>{tr(lang, 'title')}<input required value={expenseTitle} onChange={e => setExpenseTitle(e.target.value)} placeholder={lang === 'ru' ? 'Например, продукты' : 'e.g. Groceries'}/></label>
            <label>{tr(lang, 'amount')}<input type="number" min="0.01" step="0.01" required value={expenseAmount} onChange={e => setExpenseAmount(e.target.value)}/></label>
            <label>{tr(lang, 'date')}<input type="date" required value={expenseDate} onChange={e => setExpenseDate(e.target.value)}/></label>
            <label>{tr(lang, 'category')}<select value={expenseCategory} onChange={e => setExpenseCategory(e.target.value)}>{categories.map(c=><option key={c.id} value={c.id}>{categoryName(c, lang)}</option>)}</select></label>
            <label>{tr(lang, 'member')}<select value={expenseMember} onChange={e => setExpenseMember(e.target.value)}>{memberOptions}</select></label>
            <div className="pf-form-actions">{editingExpenseId && <button type="button" className="pf-button ghost" onClick={() => { setEditingExpenseId(null); setExpenseTitle(''); setExpenseAmount(''); setExpenseDate(moscowToday()); }}>{tr(lang, 'cancel')}</button>}<button className="pf-button primary" disabled={busy}>{tr(lang, 'save')}</button></div>
          </form>
          <form className="pf-inline-form category-create" onSubmit={addCategory}><label>{tr(lang, 'addCategory')}<input value={newCategoryName} onChange={e => setNewCategoryName(e.target.value)} placeholder={lang === 'ru' ? 'Например, Питомцы' : 'e.g. Pets'}/></label><button className="pf-button ghost" disabled={busy}>+</button></form>{categories.filter(category=>Boolean(category.userId)).map(category=><div className="pf-category-manage" key={category.id}><span>{category.name}</span><div><button className="pf-edit" onClick={()=>renameCategory(category)}>✎</button><button className="pf-delete" onClick={()=>archiveCategory(category)}>×</button></div></div>)}
        </section>
        <section className="pf-card"><div className="pf-card-heading"><div><span className="pf-eyebrow">{lang === 'ru' ? 'ИСТОРИЯ ОПЕРАЦИЙ' : 'TRANSACTION HISTORY'}</span><h2>{tr(lang, 'expenses')}</h2></div><span className="pf-count">{visibleExpenses.length}</span></div><div className="pf-expense-filters"><select className="pf-member-filter" value={expensePeriod} onChange={e=>setExpensePeriod(e.target.value as 'month'|'all')}><option value="month">{lang === 'ru' ? 'Выбранный месяц' : 'Selected month'}</option><option value="all">{lang === 'ru' ? 'Вся история' : 'All history'}</option></select><select className="pf-member-filter" value={filterCategory} onChange={e=>setFilterCategory(e.target.value)}><option value="all">{lang === 'ru' ? 'Все категории' : 'All categories'}</option>{categories.map(x=><option key={x.id} value={x.id}>{categoryName(x,lang)}</option>)}</select></div>
          {visibleExpenses.length ? visibleExpenses.slice(0, 100).map(item => <div className="pf-list-row" key={item.id}><div><strong>{item.title}</strong><small>{item.category ? categoryName(item.category, lang) : (lang === 'ru' ? 'Без категории' : 'Uncategorized')} · {dateLabel(item.date, lang)} · {item.member?.name ?? tr(lang, 'shared')}</small></div><div className="pf-row-action"><b>−{rub(item.amount)}</b><button className="pf-edit" onClick={() => { setEditingExpenseId(item.id); setExpenseTitle(item.title); setExpenseAmount(String(item.amount)); setExpenseDate(item.date.slice(0,10)); setExpenseCategory(item.category?.id ?? ''); setExpenseMember(item.memberId ?? ''); }} aria-label={lang === 'ru' ? 'Изменить расход' : 'Edit expense'}>✎</button><button className="pf-delete" onClick={() => removeExpense(item.id)} aria-label="Delete">×</button></div></div>) : <p className="pf-empty">{tr(lang, 'noData')}</p>}
        </section>
      </div>}

      {tab === 'obligations' && <div className="pf-page pf-two-col">
        <section className="pf-card"><div className="pf-card-heading"><div><span className="pf-eyebrow">{lang === 'ru' ? 'РЕГУЛЯРНЫЕ ПЛАТЕЖИ' : 'RECURRING COMMITMENTS'}</span><h2>{editingObligationId ? (lang === 'ru' ? 'Изменить обязательство' : 'Edit obligation') : tr(lang, 'addObligation')}</h2></div></div>
          <form className="pf-form" onSubmit={e => perform(e, editingObligationId ? PF + '/obligations/' + editingObligationId : PF + '/obligations', editingObligationId ? { title: obligationTitle, category: obligationCategory, amount: Number(obligationAmount), memberId: obligationMember || null } : { title: obligationTitle, category: obligationCategory, amount: Number(obligationAmount), recurrence: obligationRecurrence, recurrenceConfig: obligationRecurrence === 'MONTHLY' ? { day: Number(obligationDay) } : obligationRecurrence === 'WEEKLY' ? { weekdays: [Number(obligationWeekday)], intervalWeeks: Number(obligationIntervalWeeks) } : {}, startDate: obligationDate, memberId: obligationMember || null }, editingObligationId ? (lang === 'ru' ? 'Обязательство обновлено.' : 'Obligation updated.') : (lang === 'ru' ? 'Обязательство добавлено.' : 'Obligation added.'), editingObligationId ? 'PATCH' : 'POST')}>
            <label>{tr(lang, 'title')}<input required value={obligationTitle} onChange={e => setObligationTitle(e.target.value)} placeholder={lang === 'ru' ? 'Например, автокредит' : 'e.g. Car loan'}/></label>
            <label>{tr(lang, 'category')}<select value={obligationCategory} onChange={e => setObligationCategory(e.target.value)}>{(lang === 'ru' ? ['Кредит','Автокредит','Ипотека','Аренда','Коммунальные услуги','Фитнес','Подписки','Другое'] : ['Loan','Car loan','Mortgage','Rent','Utilities','Fitness','Subscriptions','Other']).map(x=><option key={x}>{x}</option>)}</select></label>
            <label>{tr(lang, 'amount')}<input type="number" min="0.01" step="0.01" required value={obligationAmount} onChange={e => setObligationAmount(e.target.value)}/></label>
            <label>{tr(lang, 'frequency')}<select value={obligationRecurrence} onChange={e => setObligationRecurrence(e.target.value)}><option value="MONTHLY">{tr(lang, 'monthly')}</option><option value="ONCE">{tr(lang, 'once')}</option><option value="WEEKLY">{tr(lang, 'weekly')}</option><option value="YEARLY">{tr(lang, 'yearly')}</option></select></label>
            {obligationRecurrence === 'MONTHLY' && <label>{tr(lang, 'day')}<input type="number" min="1" max="31" value={obligationDay} onChange={e => setObligationDay(e.target.value)}/></label>}{obligationRecurrence === 'WEEKLY' && <div className="pf-field-row"><label>{lang === 'ru' ? 'День недели' : 'Weekday'}<select value={obligationWeekday} onChange={e=>setObligationWeekday(e.target.value)}>{(lang === 'ru' ? ['Воскресенье','Понедельник','Вторник','Среда','Четверг','Пятница','Суббота'] : ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']).map((d,i)=><option key={d} value={i}>{d}</option>)}</select></label><label>{lang === 'ru' ? 'Каждые N недель' : 'Every N weeks'}<input type="number" min="1" max="52" value={obligationIntervalWeeks} onChange={e=>setObligationIntervalWeeks(e.target.value)}/></label></div>}
            <label>{tr(lang, 'startDate')}<input type="date" required value={obligationDate} onChange={e => setObligationDate(e.target.value)}/></label>
            <label>{tr(lang, 'member')}<select value={obligationMember} onChange={e => setObligationMember(e.target.value)}>{memberOptions}</select></label>
            <button className="pf-button primary" disabled={busy}>{tr(lang, 'add')}</button>
          </form>
        </section>
        <section className="pf-card"><div className="pf-card-heading"><div><span className="pf-eyebrow">{lang === 'ru' ? 'ПЛАН И ОПЛАТА' : 'DUE AND PAID'}</span><h2>{tr(lang, 'obligations')}</h2></div><span className="pf-count">{monthObligations.length}</span></div>
          {visibleObligations.length ? visibleObligations.map(item => <div className="pf-list-row" key={item.id}><div><strong>{item.obligation.title}</strong><small>{item.obligation.category} · {dateLabel(item.dueDate, lang)}</small><small className={item.status === 'PAID' ? 'positive' : item.status === 'OVERDUE' ? 'negative' : ''}>{item.status === 'PAID' ? tr(lang, 'paidStatus') : item.status === 'OVERDUE' ? tr(lang, 'overdue') : tr(lang, 'unpaid')}</small></div><div className="pf-row-action"><b>{rub(item.actualAmount ?? item.plannedAmount)}</b>{item.status !== 'PAID' && <><button className="pf-edit" title={lang === 'ru' ? 'Изменить обязательство' : 'Edit obligation'} onClick={() => { setEditingObligationId(item.obligation.id); setObligationTitle(item.obligation.title); setObligationCategory(item.obligation.category); setObligationAmount(String(item.plannedAmount)); setObligationMember(item.obligation.memberId ?? ''); }}>✎</button><button className="pf-button small" disabled={busy} onClick={() => markPaid(item.id)}>{tr(lang, 'paidAction')}</button><button className="pf-delete" title={lang === 'ru' ? 'Пропустить этот платёж' : 'Skip this occurrence'} onClick={() => skipObligation(item.id)}>⊘</button><button className="pf-delete" title={lang === 'ru' ? 'Отключить обязательство' : 'Archive obligation'} onClick={() => deleteObligation(item.obligation.id)}>×</button></>}</div></div>) : <p className="pf-empty">{tr(lang, 'noData')}</p>}
        </section>
      </div>}


      {tab === 'calendar' && <div className="pf-page pf-two-col">
        <section className="pf-card"><div className="pf-card-heading"><div><span className="pf-eyebrow">{lang === 'ru' ? 'КАЛЕНДАРЬ ДОМОХОЗЯЙСТВА' : 'HOUSEHOLD CALENDAR'}</span><h2>{new Intl.DateTimeFormat(lang === 'ru' ? 'ru-RU' : 'en-GB', { month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' }).format(new Date())}</h2></div></div>
          <div className="pf-calendar-grid pf-calendar-weekdays">{(lang === 'ru' ? ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'] : ['Su','Mo','Tu','We','Th','Fr','Sa']).map(day => <span key={day}>{day}</span>)}</div>
          <div className="pf-calendar-grid">{calendarCells.map((day, index) => {
            const date = day ? ranges.from.slice(0,8) + String(day).padStart(2,'0') : '';
            const events = calendarEvents.filter(item => item.date === date);
            return <div key={index} className={day ? 'pf-calendar-day' : 'pf-calendar-day blank'}><b>{day ?? ''}</b>{events.length > 0 && <span>{events.length} {lang === 'ru' ? 'событ.' : 'items'}</span>}<div className="pf-calendar-dots">{events.slice(0,3).map((item,i)=><i key={i} className={item.kind}/>)}</div></div>;
          })}</div>
        </section>
        <section className="pf-card"><div className="pf-card-heading"><div><span className="pf-eyebrow">{lang === 'ru' ? 'СОБЫТИЯ МЕСЯЦА' : 'MONTH EVENTS'}</span><h2>{lang === 'ru' ? 'Доходы и платежи' : 'Income and payments'}</h2></div><span className="pf-count">{calendarEvents.length}</span></div>
          {calendarEvents.length ? calendarEvents.map((item,index)=><div className="pf-list-row" key={item.date + item.title + index}><div><strong>{item.title}</strong><small>{dateLabel(item.date,lang)} · {item.kind === 'income' ? (item.status === 'RECEIVED' ? tr(lang,'actualStatus') : tr(lang,'plannedStatus')) : item.kind === 'expense' ? tr(lang,'expenses') : item.status === 'PAID' ? tr(lang,'paidStatus') : tr(lang,'unpaid')}</small></div><b className={item.kind === 'income' ? 'positive' : ''}>{item.kind === 'income' ? '+' : '−'}{rub(item.amount)}</b></div>) : <p className="pf-empty">{tr(lang,'noData')}</p>}
        </section>
      </div>}

      {tab === 'analytics' && analytics && <div className="pf-page">
        <section className="pf-metric-grid"><article><span>{lang === 'ru' ? 'Доходы за период' : 'Income for period'}</span><strong className="positive">{rub(analytics.totals.income)}</strong></article><article><span>{lang === 'ru' ? 'Расходы за период' : 'Expenses for period'}</span><strong>{rub(analytics.totals.expenses)}</strong></article><article><span>{tr(lang,'due')}</span><strong>{rub(analytics.totals.obligations)}</strong></article><article><span>{lang === 'ru' ? 'Разница доходов и расходов' : 'Income minus expenses'}</span><strong>{rub(analytics.totals.income-analytics.totals.expenses)}</strong></article></section>
        <section className="pf-two-col">
          <article className="pf-card"><div className="pf-card-heading"><div><span className="pf-eyebrow">{lang === 'ru' ? 'СТРУКТУРА РАСХОДОВ' : 'EXPENSE BREAKDOWN'}</span><h2>{lang === 'ru' ? 'По категориям' : 'By category'}</h2></div></div>
            {analytics.categories.length ? analytics.categories.map(item=><div className="pf-category-bar" key={item.name}><div><span>{item.name}</span><b>{rub(item.amount)}</b></div><div className="pf-coverage-track"><span style={{width: Math.max(2,item.amount/Math.max(...analytics.categories.map(x=>x.amount))*100) + '%'}}/></div></div>) : <p className="pf-empty">{tr(lang,'noData')}</p>}
          </article>
          <article className="pf-card"><div className="pf-card-heading"><div><span className="pf-eyebrow">{lang === 'ru' ? 'СЕМЕЙНЫЕ ДАННЫЕ' : 'HOUSEHOLD DATA'}</span><h2>{lang === 'ru' ? 'По участникам' : 'By member'}</h2></div></div>
            {analytics.members.length ? analytics.members.map(item=><div className="pf-list-row" key={item.name}><div><strong>{item.name}</strong><small>{lang === 'ru' ? 'Доходы' : 'Income'}: {rub(item.income)} · {lang === 'ru' ? 'Расходы' : 'Expenses'}: {rub(item.expenses)}</small></div><b className={item.net >= 0 ? 'positive' : 'negative'}>{rub(item.net)}</b></div>) : <p className="pf-empty">{tr(lang,'noData')}</p>}
          </article>
        </section>
        <section className="pf-card"><div className="pf-card-heading"><div><span className="pf-eyebrow">{lang === 'ru' ? 'ДИНАМИКА' : 'TREND'}</span><h2>{lang === 'ru' ? 'Доходы и расходы по месяцам' : 'Monthly income and expenses'}</h2></div></div>
          {analytics.months.length ? <><div className="pf-trend-legend"><span><i className="income"/> {lang === 'ru' ? 'Доходы' : 'Income'}</span><span><i className="expense"/> {lang === 'ru' ? 'Расходы' : 'Expenses'}</span></div>{analytics.months.map(item=><div className="pf-trend-row" key={item.month}><div className="pf-trend-label"><strong>{item.month}</strong><b className={item.net >= 0 ? 'positive' : 'negative'}>{rub(item.net)}</b></div><div className="pf-trend-bar income"><span style={{width:(item.income/analyticsMax*100)+'%'}}/></div><div className="pf-trend-bar expense"><span style={{width:(item.expenses/analyticsMax*100)+'%'}}/></div><small>{lang === 'ru' ? 'Доходы' : 'Income'}: {rub(item.income)} · {lang === 'ru' ? 'Расходы' : 'Expenses'}: {rub(item.expenses)}</small></div>)}</> : <p className="pf-empty">{tr(lang,'noData')}</p>}
        </section>
      </div>}

      {tab === 'budgets' && <div className="pf-page pf-two-col">
        <section className="pf-card"><div className="pf-card-heading"><div><span className="pf-eyebrow">{lang === 'ru' ? 'ЛИМИТЫ РАСХОДОВ' : 'SPENDING LIMITS'}</span><h2>{lang === 'ru' ? 'Месячный бюджет' : 'Monthly budget'}</h2></div></div>
          <form className="pf-form" onSubmit={e => perform(e, PF + '/budgets', { periodMonth: ranges.from, limitAmount: Number(budgetLimit), categoryId: budgetCategory || null, memberId: budgetMember || null }, lang === 'ru' ? 'Бюджет сохранён.' : 'Budget saved.')}>
            <label>{tr(lang,'amount')}<input type="number" min="0.01" step="0.01" required value={budgetLimit} onChange={e=>setBudgetLimit(e.target.value)}/></label>
            <label>{tr(lang,'category')}<select value={budgetCategory} onChange={e=>setBudgetCategory(e.target.value)}><option value="">{lang === 'ru' ? 'Все категории' : 'All categories'}</option>{categories.map(x=><option key={x.id} value={x.id}>{categoryName(x,lang)}</option>)}</select></label>
            <label>{tr(lang,'member')}<select value={budgetMember} onChange={e=>setBudgetMember(e.target.value)}>{memberOptions}</select></label>
            <button className="pf-button primary" disabled={busy}>{tr(lang,'save')}</button>
          </form>
          {visibleBudgets.map(item=>{const used=memberExpenses.filter(x=>x.date>=ranges.from&&x.date<=ranges.to&&(!item.categoryId||x.category?.id===item.categoryId)&&(!item.memberId||x.memberId===item.memberId)).reduce((sum,x)=>sum+Number(x.amount),0);const limit=Number(item.limitAmount);const progress=limit>0?Math.min(100,used/limit*100):0;return <div className="pf-budget-item" key={item.id}><div className="pf-list-row"><div><strong>{item.category ? categoryName(item.category,lang) : (lang === 'ru' ? 'Общий бюджет' : 'Overall budget')}</strong><small>{item.member?.name ?? tr(lang,'shared')}</small></div><div className="pf-row-action"><b>{rub(used)} / {rub(limit)}</b><button className="pf-delete" onClick={()=>deleteBudget(item.id)}>×</button></div></div><div className="pf-coverage-track"><span style={{width:progress+'%',background:used>limit?'#ff8796':undefined}}/></div></div>})}
          {!visibleBudgets.length && <p className="pf-empty">{tr(lang,'noData')}</p>}
        </section>
        <section className="pf-card"><div className="pf-card-heading"><div><span className="pf-eyebrow">{lang === 'ru' ? 'НАКОПЛЕНИЯ' : 'SAVINGS'}</span><h2>{lang === 'ru' ? 'Финансовая цель' : 'Savings goal'}</h2></div></div>
          <form className="pf-form" onSubmit={e=>perform(e,PF+'/savings-goals',{title:goalTitle,targetAmount:Number(goalTarget),currentAmount:Number(goalCurrent),targetDate:goalDate||null},lang === 'ru' ? 'Цель добавлена.' : 'Goal added.')}>
            <label>{tr(lang,'title')}<input required value={goalTitle} onChange={e=>setGoalTitle(e.target.value)}/></label>
            <div className="pf-field-row"><label>{lang === 'ru' ? 'Целевая сумма' : 'Target amount'}<input type="number" min="0.01" step="0.01" required value={goalTarget} onChange={e=>setGoalTarget(e.target.value)}/></label><label>{lang === 'ru' ? 'Уже накоплено' : 'Already saved'}<input type="number" min="0" step="0.01" value={goalCurrent} onChange={e=>setGoalCurrent(e.target.value)}/></label></div>
            <label>{lang === 'ru' ? 'Желаемая дата' : 'Target date'}<input type="date" value={goalDate} onChange={e=>setGoalDate(e.target.value)}/></label>
            <button className="pf-button primary" disabled={busy}>{tr(lang,'add')}</button>
          </form>
          {goals.map(goal=>{const progress=Math.min(100,Number(goal.currentAmount)/Number(goal.targetAmount)*100);return <div className="pf-goal" key={goal.id}><div><strong>{goal.title}</strong><b>{rub(goal.currentAmount)} / {rub(goal.targetAmount)}</b></div><div className="pf-coverage-track"><span style={{width: progress + '%'}}/></div><div className="pf-goal-bottom"><small>{Math.round(progress)}% {lang === 'ru' ? 'накоплено' : 'saved'}{goal.targetDate ? ' · '+dateLabel(goal.targetDate,lang) : ''}</small><div className="pf-row-action"><button className="pf-button small" disabled={busy || goal.status === 'COMPLETED'} onClick={()=>addGoalContribution(goal)}>{lang === 'ru' ? 'Пополнить' : 'Add funds'}</button><button className="pf-delete" onClick={()=>deleteGoal(goal.id)}>×</button></div></div></div>})}
          {!goals.length && <p className="pf-empty">{tr(lang,'noData')}</p>}
        </section>
      </div>}

      {tab === 'settings' && <div className="pf-page">
        <section className="pf-card pf-settings-card"><div className="pf-card-heading"><div><span className="pf-eyebrow">{lang === 'ru' ? 'ПЕРСОНАЛИЗАЦИЯ' : 'PREFERENCES'}</span><h2>{tr(lang,'settings')}</h2></div></div>
          <label className="pf-setting-row"><span><strong>{lang === 'ru' ? 'Язык интерфейса' : 'Interface language'}</strong><small>{lang === 'ru' ? 'Язык названий и подсказок' : 'Labels and helper text language'}</small></span><select value={lang} onChange={e=>changeLanguage(e.target.value as Lang)}><option value="ru">Русский</option><option value="en">English</option></select></label>
          <label className="pf-setting-row"><span><strong>{lang === 'ru' ? 'Часовой пояс' : 'Time zone'}</strong><small>{lang === 'ru' ? 'Используется для текущей даты и календаря платежей' : 'Used for today and payment calendar dates'}</small></span><select value={timezone} onChange={e=>changeTimezone(e.target.value)}>{[['Europe/Moscow','Москва (UTC+3)'],['Europe/Minsk','Минск (UTC+3)'],['Europe/Warsaw','Варшава'],['Europe/Berlin','Берлин'],['Europe/London','Лондон'],['Asia/Dubai','Дубай'],['Asia/Bangkok','Бангкок'],['Asia/Ho_Chi_Minh','Хошимин'],['UTC','UTC']].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
          <div className="pf-opening-balance"><div><strong>{lang === 'ru' ? 'Начальный остаток' : 'Opening balance'}</strong><small>{lang === 'ru' ? 'Сколько денег было на счетах и наличными на дату начала учёта' : 'Money held across accounts and cash on the start date'}</small></div><div className="pf-opening-fields"><label>{lang === 'ru' ? 'Сумма, ₽' : 'Amount, RUB'}<input type="number" step="0.01" value={openingBalance} onChange={e=>setOpeningBalance(e.target.value)}/></label><label>{lang === 'ru' ? 'Дата начала учёта' : 'Tracking start date'}<input type="date" max={todayInTimezone(timezone)} value={openingBalanceDate} onChange={e=>setOpeningBalanceDate(e.target.value)}/></label></div><button className="pf-button" disabled={busy || !openingBalanceDate} onClick={saveOpeningBalance}>{lang === 'ru' ? 'Сохранить начальный остаток' : 'Save opening balance'}</button><p className="pf-muted">{lang === 'ru' ? 'Фактический баланс будет считать доходы, расходы и корректировки только начиная с этой даты, чтобы не учитывать старую историю повторно.' : 'The actual balance includes income, expenses and adjustments from this date onward, avoiding double-counting older history.'}</p></div><p className="pf-muted">{lang === 'ru' ? 'Суммы хранятся в рублях. Смена часового пояса влияет на формирование будущих дат, но не пересчитывает уже записанные операции.' : 'Amounts are stored in RUB. Changing the timezone affects future date generation but does not rewrite existing transactions.'}</p>
        </section>
      </div>}

      {tab === 'family' && <div className="pf-page pf-two-col">
        <section className="pf-card"><div className="pf-card-heading"><div><span className="pf-eyebrow">{lang === 'ru' ? 'УЧАСТНИКИ ДОМОХОЗЯЙСТВА' : 'HOUSEHOLD MEMBERS'}</span><h2>{tr(lang, 'family')}</h2></div></div>
          <form className="pf-inline-form" onSubmit={addMember}><label>{tr(lang, 'newMember')}<input required value={newMemberName} onChange={e => setNewMemberName(e.target.value)}/></label><button className="pf-button primary" disabled={busy}>{tr(lang, 'addMember')}</button></form>
          {members.map(m => <div className="pf-list-row" key={m.id}><div><strong>{m.name}</strong><small>{lang === 'ru' ? 'Участник семейного бюджета' : 'Household member'}</small></div><div className="pf-row-action"><span className="pf-member-dot"/><button className="pf-edit" onClick={()=>renameMember(m)}>✎</button><button className="pf-delete" onClick={()=>archiveMember(m)}>×</button></div></div>)}
        </section>
        <section className="pf-card"><div className="pf-card-heading"><div><span className="pf-eyebrow">{lang === 'ru' ? 'ОБЩИЕ ПРАВИЛА' : 'HOUSEHOLD RULES'}</span><h2>{lang === 'ru' ? 'Как считается бюджет' : 'How the budget works'}</h2></div></div>
          <ul className="pf-rules"><li>{lang === 'ru' ? 'Доходы учитываются в фактическом остатке только после отметки «Получено».' : 'Income affects actual balance only after being marked received.'}</li><li>{lang === 'ru' ? 'Обязательство становится расходом один раз после отметки «Оплачено».' : 'An obligation becomes an expense once when marked paid.'}</li><li>{lang === 'ru' ? 'Пустой участник означает общий расход или доход семьи.' : 'An empty member means a shared household item.'}</li><li>{lang === 'ru' ? 'Все суммы ведутся только в рублях.' : 'All amounts are tracked in RUB only.'}</li></ul>
        </section>
      </div>}
      <footer className="pf-footer">FLOWMONEY <span>·</span> {lang === 'ru' ? 'Семейные финансы без догадок' : 'Family finances, without guesswork'}</footer>
    </main>
  </div>;
}
