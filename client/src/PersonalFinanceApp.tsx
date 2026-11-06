import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, getToken, setToken } from './lib/api';
import './personalFinance.css';

type Lang = 'ru' | 'en';
type User = { id: string; email: string };
type Member = { id: string; name: string; color?: string | null; isArchived: boolean };
type Category = { id: string; name: string; slug: string; userId: string | null; isArchived: boolean };
type IncomeEntry = { id: string; plannedDate: string; plannedAmount: number | string; status: string; actualAmount?: number | string | null; memberId?: string | null; member?: Member | null; source?: { title: string } | null };
type ObligationOccurrence = { id: string; dueDate: string; plannedAmount: number | string; status: string; actualAmount?: number | string | null; obligation: { title: string; category: string; memberId?: string | null; member?: Member | null } };
type Expense = { id: string; title: string; amount: number | string; date: string; memberId?: string | null; category?: Category | null; member?: Member | null; note?: string | null };
type Dashboard = {
  actual: { income: number; expenses: number; balance: number };
  forecast: { plannedIncome: number; unpaidObligations: number; balance: number };
  obligations: { due: number; paid: number; unpaid: number; coverage: { receivedIncome: number; shortfall: number; surplus: number }; plannedCoverage: { income: number; shortfall: number } };
  nextPayments: ObligationOccurrence[];
};
type Tab = 'overview' | 'income' | 'expenses' | 'obligations' | 'family';

const PF = '/personal-finance';
const translations: Record<string, { ru: string; en: string }> = {
  overview: { ru: 'Обзор', en: 'Overview' }, income: { ru: 'Доходы', en: 'Income' }, expenses: { ru: 'Расходы', en: 'Expenses' }, obligations: { ru: 'Обязательства', en: 'Obligations' }, family: { ru: 'Семья', en: 'Family' },
  actualBalance: { ru: 'Фактический остаток', en: 'Actual balance' }, forecastBalance: { ru: 'Прогнозный остаток', en: 'Forecast balance' }, received: { ru: 'Получено за месяц', en: 'Received this month' }, spent: { ru: 'Потрачено за месяц', en: 'Spent this month' },
  planned: { ru: 'Запланировано', en: 'Planned' }, add: { ru: 'Добавить', en: 'Add' }, date: { ru: 'Дата', en: 'Date' }, amount: { ru: 'Сумма, ₽', en: 'Amount, RUB' }, title: { ru: 'Название', en: 'Title' }, member: { ru: 'Кому', en: 'Member' }, shared: { ru: 'Общее', en: 'Shared' }, category: { ru: 'Категория', en: 'Category' }, note: { ru: 'Комментарий', en: 'Note' }, save: { ru: 'Сохранить', en: 'Save' }, cancel: { ru: 'Отмена', en: 'Cancel' }, loading: { ru: 'Загружаем ваши финансы…', en: 'Loading your finances…' }, logout: { ru: 'Выйти', en: 'Sign out' }, signIn: { ru: 'Войти', en: 'Sign in' }, signUp: { ru: 'Создать аккаунт', en: 'Create account' }, email: { ru: 'Электронная почта', en: 'Email' }, password: { ru: 'Пароль (не менее 8 символов)', en: 'Password (at least 8 characters)' },
  daily: { ru: 'Каждый день', en: 'Daily' }, weekly: { ru: 'Еженедельно', en: 'Weekly' }, twice: { ru: 'Два раза в месяц', en: 'Twice monthly' }, monthly: { ru: 'Ежемесячно', en: 'Monthly' }, yearly: { ru: 'Ежегодно', en: 'Yearly' }, once: { ru: 'Разово', en: 'One-time' }, frequency: { ru: 'Периодичность', en: 'Frequency' }, startDate: { ru: 'Начало', en: 'Start date' }, endDate: { ru: 'Окончание (необязательно)', en: 'End date (optional)' }, firstDay: { ru: 'Первое число', en: 'First day' }, secondDay: { ru: 'Второе число', en: 'Second day' }, day: { ru: 'Число месяца', en: 'Day of month' }, receivedAction: { ru: 'Отметить полученным', en: 'Mark received' }, paidAction: { ru: 'Оплатить', en: 'Mark paid' }, due: { ru: 'К оплате в этом месяце', en: 'Due this month' }, paid: { ru: 'Оплачено', en: 'Paid' }, unpaid: { ru: 'Не оплачено', en: 'Unpaid' }, shortfall: { ru: 'Не хватает', en: 'Shortfall' }, surplus: { ru: 'Остаток после обязательств', en: 'Surplus after obligations' }, upcoming: { ru: 'Ближайшие платежи', en: 'Upcoming payments' }, opening: { ru: 'Начальный остаток / корректировка', en: 'Opening balance / adjustment' }, openingHelp: { ru: 'Укажите сумму со знаком: положительную, если добавляете деньги, отрицательную — если уменьшаете остаток. Начальный остаток учитывается один раз.', en: 'Enter a signed amount: positive adds money, negative reduces it. The opening balance is recorded once as an adjustment.' }, reason: { ru: 'Причина корректировки', en: 'Adjustment reason' }, newMember: { ru: 'Имя участника семьи', en: 'Family member name' }, addMember: { ru: 'Добавить участника', en: 'Add member' }, addCategory: { ru: 'Новая категория', en: 'New category' }, noData: { ru: 'Пока нет записей', en: 'Nothing here yet' }, forecastInfo: { ru: 'Прогноз учитывает запланированные поступления и неоплаченные обязательства. Не полученные деньги не входят в фактический остаток.', en: 'Forecast includes planned income and unpaid obligations. Unreceived money is excluded from actual balance.' }, coverageInfo: { ru: 'Сравнение полученных доходов с суммой обязательств за выбранный месяц.', en: 'Received income compared with obligations due this month.' }, overdue: { ru: 'Просрочено', en: 'Overdue' }, plannedStatus: { ru: 'Ожидается', en: 'Planned' }, actualStatus: { ru: 'Получено', en: 'Received' }, paidStatus: { ru: 'Оплачено', en: 'Paid' }, addExpense: { ru: 'Новый расход', en: 'New expense' }, addIncome: { ru: 'Новый источник дохода', en: 'New income source' }, addObligation: { ru: 'Новое обязательство', en: 'New obligation' }, signInTitle: { ru: 'Ваш семейный бюджет', en: 'Your family budget' }, signInText: { ru: 'Доходы, расходы и обязательные платежи — в одном месте.', en: 'Income, expenses and recurring commitments in one place.' }, emptyTitle: { ru: 'Пока нет данных', en: 'No data yet' }, refresh: { ru: 'Обновить', en: 'Refresh' }
};
function tr(lang: Lang, key: string) { return translations[key]?.[lang] ?? key; }
function moscowToday() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function monthBounds() {
  const today = moscowToday(), [year, month] = today.split('-').map(Number);
  const last = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  const horizon = new Date(Date.UTC(year, month + 3, 0)).toISOString().slice(0, 10);
  return { from: `${year}-${String(month).padStart(2, '0')}-01`, to: last, horizon };
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
  const [members, setMembers] = useState<Member[]>([]);
  const [filterMember, setFilterMember] = useState('all');
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
  const [incomeMember, setIncomeMember] = useState('');
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
  const [obligationMember, setObligationMember] = useState('');
  const [openingAmount, setOpeningAmount] = useState('');
  const [openingReason, setOpeningReason] = useState('Начальный остаток');
  const [newMemberName, setNewMemberName] = useState('');
  const [newCategoryName, setNewCategoryName] = useState('');

  const ranges = useMemo(monthBounds, []);
  const refresh = useCallback(async () => {
    const [dash, income, expenseData, obligations, memberData, adjustmentData] = await Promise.all([
      api<Dashboard>(`${PF}/dashboard?from=${ranges.from}&to=${ranges.to}&horizon=${ranges.horizon}${filterMember !== 'all' ? `&memberId=${filterMember}` : ''}`),
      api<{ entries: IncomeEntry[] }>(`${PF}/income-sources?from=${ranges.from}&to=${ranges.horizon}`),
      api<{ expenses: Expense[]; categories: Category[] }>(`${PF}/expenses`),
      api<{ occurrences: ObligationOccurrence[] }>(`${PF}/obligations?from=${ranges.from}&to=${ranges.horizon}`),
      api<Member[]>(`${PF}/members`),
      api<Array<{ id: string; amount: number | string; date: string; reason: string }>>(`${PF}/balance-adjustments`)
    ]);
    setDashboard(dash); setIncomeEntries(income.entries); setExpenses(expenseData.expenses); setCategories(expenseData.categories.filter(x => !x.isArchived)); setObligationOccurrences(obligations.occurrences); setMembers(memberData.filter(x => !x.isArchived)); setAdjustments(adjustmentData);
    if (!expenseCategory && expenseData.categories[0]) setExpenseCategory(expenseData.categories[0].id);
  }, [ranges, expenseCategory, filterMember]);

  useEffect(() => {
    const token = getToken();
    if (!token) { setLoading(false); return; }
    api<User>('/auth/me').then(async current => { setUser(current); await refresh(); }).catch(() => { setToken(null); }).finally(() => setLoading(false));
  }, [refresh]);

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
    try { await api(path, { method, body: JSON.stringify(body) }); await refresh(); setNotice(success); if (path.includes('/expenses/') && method === 'PATCH') setEditingExpenseId(null); }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось сохранить данные.'); }
    finally { setBusy(false); }
  }
  async function markReceived(id: string) {
    setBusy(true); setError('');
    try { await api(`${PF}/income-entries/${id}/receive`, { method: 'POST', body: JSON.stringify({}) }); await refresh(); setNotice(lang === 'ru' ? 'Доход отмечен как полученный.' : 'Income marked as received.'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Error'); } finally { setBusy(false); }
  }
  async function markPaid(id: string) {
    setBusy(true); setError('');
    try { await api(`${PF}/obligation-occurrences/${id}/pay`, { method: 'POST', body: JSON.stringify({}) }); await refresh(); setNotice(lang === 'ru' ? 'Платёж отмечен оплаченным и добавлен в расходы один раз.' : 'Payment marked paid and recorded as one expense.'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Error'); } finally { setBusy(false); }
  }
  async function removeExpense(id: string) {
    if (!window.confirm(lang === 'ru' ? 'Удалить этот расход?' : 'Delete this expense?')) return;
    setBusy(true); try { await api(`${PF}/expenses/${id}`, { method: 'DELETE' }); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : 'Error'); } finally { setBusy(false); }
  }
  async function addMember(event: FormEvent) {
    event.preventDefault(); if (!newMemberName.trim()) return; setBusy(true);
    try { await api(`${PF}/members`, { method: 'POST', body: JSON.stringify({ name: newMemberName.trim() }) }); setNewMemberName(''); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Error'); } finally { setBusy(false); }
  }
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
  const visibleExpenses = expenses.filter(item => matchesMember(item.memberId ?? item.member?.id));
  const visibleObligations = obligationOccurrences.filter(item => matchesMember(item.obligation.memberId));
  const monthIncome = visibleIncome.filter(entry => entry.plannedDate >= ranges.from && entry.plannedDate <= ranges.to);
  const monthObligations = visibleObligations.filter(item => item.dueDate >= ranges.from && item.dueDate <= ranges.to);

  return <div className="pf-shell">
    <aside className="pf-sidebar">
      <div className="pf-brand">FLOW<span>MONEY</span></div>
      <div className="pf-sidebar-caption">{lang === 'ru' ? 'СЕМЕЙНЫЕ ФИНАНСЫ' : 'HOUSEHOLD FINANCE'}</div>
      <nav>{(['overview', 'income', 'expenses', 'obligations', 'family'] as Tab[]).map(item => <button key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}><span className="pf-nav-dot"/>{tr(lang, item)}</button>)}</nav>
      <div className="pf-sidebar-bottom"><div className="pf-avatar">{user.email[0].toUpperCase()}</div><div className="pf-user"><strong>{user.email.split('@')[0]}</strong><small>{user.email}</small></div><button className="pf-icon-button" title={tr(lang, 'logout')} onClick={() => { setToken(null); setUser(null); }}>↪</button></div>
    </aside>
    <main className="pf-main">
      <header className="pf-topbar"><div><span className="pf-eyebrow">{lang === 'ru' ? 'ЛИЧНЫЙ ФИНАНСОВЫЙ ПЛАН' : 'PERSONAL FINANCE'}</span><h1>{tr(lang, tab)}</h1><p>{new Intl.DateTimeFormat(lang === 'ru' ? 'ru-RU' : 'en-GB', { month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' }).format(new Date())}</p></div><div className="pf-top-actions"><select className="pf-member-filter" value={filterMember} onChange={e => setFilterMember(e.target.value)} aria-label={tr(lang, 'member')}><option value="all">{lang === 'ru' ? 'Вся семья' : 'Whole household'}</option><option value="shared">{tr(lang, 'shared')}</option>{members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select><button className="pf-language" onClick={() => setLang(lang === 'ru' ? 'en' : 'ru')}>{lang === 'ru' ? '🇬🇧 EN' : '🇷🇺 RU'}</button><button className="pf-button ghost" onClick={() => refresh()}>{tr(lang, 'refresh')} ↻</button></div></header>
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
          <form className="pf-form" onSubmit={e => perform(e, `${PF}/income-sources`, { title: incomeTitle, amount: Number(incomeAmount), recurrence: incomeRecurrence, recurrenceConfig: incomeRecurrence === 'WEEKLY' ? { weekdays: [Number(incomeWeekday)] } : incomeRecurrence === 'TWICE_MONTHLY' ? { firstDay: Number(incomeDay1), secondDay: Number(incomeDay2) } : incomeRecurrence === 'MONTHLY' ? { day: Number(incomeDay1) } : {}, startDate: incomeStart, endDate: incomeEnd || null, memberId: incomeMember || null }, lang === 'ru' ? 'Источник дохода добавлен.' : 'Income source added.')}>
            <label>{tr(lang, 'title')}<input required value={incomeTitle} onChange={e => setIncomeTitle(e.target.value)}/></label>
            <label>{tr(lang, 'amount')}<input type="number" min="0.01" step="0.01" required value={incomeAmount} onChange={e => setIncomeAmount(e.target.value)}/></label>
            <label>{tr(lang, 'frequency')}<select value={incomeRecurrence} onChange={e => setIncomeRecurrence(e.target.value)}><option value="DAILY">{tr(lang, 'daily')}</option><option value="WEEKLY">{tr(lang, 'weekly')}</option><option value="TWICE_MONTHLY">{tr(lang, 'twice')}</option><option value="MONTHLY">{tr(lang, 'monthly')}</option><option value="YEARLY">{tr(lang, 'yearly')}</option><option value="ONCE">{tr(lang, 'once')}</option></select></label>
            {incomeRecurrence === 'WEEKLY' && <label>{lang === 'ru' ? 'День недели' : 'Weekday'}<select value={incomeWeekday} onChange={e => setIncomeWeekday(e.target.value)}>{(lang === 'ru' ? ['Воскресенье','Понедельник','Вторник','Среда','Четверг','Пятница','Суббота'] : ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']).map((d,i)=><option key={d} value={i}>{d}</option>)}</select></label>}
            {['TWICE_MONTHLY','MONTHLY'].includes(incomeRecurrence) && <div className="pf-field-row"><label>{incomeRecurrence === 'MONTHLY' ? tr(lang, 'day') : tr(lang, 'firstDay')}<input type="number" min="1" max="31" value={incomeDay1} onChange={e => setIncomeDay1(e.target.value)}/></label>{incomeRecurrence === 'TWICE_MONTHLY' && <label>{tr(lang, 'secondDay')}<input type="number" min="1" max="31" value={incomeDay2} onChange={e => setIncomeDay2(e.target.value)}/></label>}</div>}
            <div className="pf-field-row"><label>{tr(lang, 'startDate')}<input type="date" required value={incomeStart} onChange={e => setIncomeStart(e.target.value)}/></label><label>{tr(lang, 'endDate')}<input type="date" value={incomeEnd} onChange={e => setIncomeEnd(e.target.value)}/></label></div>
            <label>{tr(lang, 'member')}<select value={incomeMember} onChange={e => setIncomeMember(e.target.value)}>{memberOptions}</select></label>
            <button className="pf-button primary" disabled={busy}>{tr(lang, 'add')}</button>
          </form>
        </section>
        <section className="pf-card"><div className="pf-card-heading"><div><span className="pf-eyebrow">{lang === 'ru' ? 'ОЖИДАЕМЫЕ И ФАКТИЧЕСКИЕ' : 'PLANNED AND RECEIVED'}</span><h2>{tr(lang, 'income')}</h2></div><span className="pf-count">{monthIncome.length}</span></div>
          {visibleIncome.length ? visibleIncome.map(entry => <div className="pf-list-row" key={entry.id}><div><strong>{entry.source?.title ?? (lang === 'ru' ? 'Разовый доход' : 'One-time income')}</strong><small>{dateLabel(entry.plannedDate, lang)} · {entry.member?.name ?? tr(lang, 'shared')}</small><small className={entry.status === 'RECEIVED' ? 'positive' : ''}>{entry.status === 'RECEIVED' ? tr(lang, 'actualStatus') : tr(lang, 'plannedStatus')}</small></div><div className="pf-row-action"><b>{rub(entry.actualAmount ?? entry.plannedAmount)}</b>{entry.status === 'PLANNED' && <button className="pf-button small" disabled={busy} onClick={() => markReceived(entry.id)}>{tr(lang, 'receivedAction')}</button>}</div></div>) : <p className="pf-empty">{tr(lang, 'noData')}</p>}
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
          <form className="pf-inline-form category-create" onSubmit={addCategory}><label>{tr(lang, 'addCategory')}<input value={newCategoryName} onChange={e => setNewCategoryName(e.target.value)} placeholder={lang === 'ru' ? 'Например, Питомцы' : 'e.g. Pets'}/></label><button className="pf-button ghost" disabled={busy}>+</button></form>
        </section>
        <section className="pf-card"><div className="pf-card-heading"><div><span className="pf-eyebrow">{lang === 'ru' ? 'ИСТОРИЯ ОПЕРАЦИЙ' : 'TRANSACTION HISTORY'}</span><h2>{tr(lang, 'expenses')}</h2></div><span className="pf-count">{visibleExpenses.length}</span></div>
          {visibleExpenses.length ? visibleExpenses.slice(0, 100).map(item => <div className="pf-list-row" key={item.id}><div><strong>{item.title}</strong><small>{item.category ? categoryName(item.category, lang) : (lang === 'ru' ? 'Без категории' : 'Uncategorized')} · {dateLabel(item.date, lang)} · {item.member?.name ?? tr(lang, 'shared')}</small></div><div className="pf-row-action"><b>−{rub(item.amount)}</b><button className="pf-edit" onClick={() => { setEditingExpenseId(item.id); setExpenseTitle(item.title); setExpenseAmount(String(item.amount)); setExpenseDate(item.date.slice(0,10)); setExpenseCategory(item.category?.id ?? ''); setExpenseMember(item.memberId ?? ''); }} aria-label={lang === 'ru' ? 'Изменить расход' : 'Edit expense'}>✎</button><button className="pf-delete" onClick={() => removeExpense(item.id)} aria-label="Delete">×</button></div></div>) : <p className="pf-empty">{tr(lang, 'noData')}</p>}
        </section>
      </div>}

      {tab === 'obligations' && <div className="pf-page pf-two-col">
        <section className="pf-card"><div className="pf-card-heading"><div><span className="pf-eyebrow">{lang === 'ru' ? 'РЕГУЛЯРНЫЕ ПЛАТЕЖИ' : 'RECURRING COMMITMENTS'}</span><h2>{tr(lang, 'addObligation')}</h2></div></div>
          <form className="pf-form" onSubmit={e => perform(e, `${PF}/obligations`, { title: obligationTitle, category: obligationCategory, amount: Number(obligationAmount), recurrence: obligationRecurrence, recurrenceConfig: obligationRecurrence === 'MONTHLY' ? { day: Number(obligationDay) } : {}, startDate: obligationDate, memberId: obligationMember || null }, lang === 'ru' ? 'Обязательство добавлено.' : 'Obligation added.')}>
            <label>{tr(lang, 'title')}<input required value={obligationTitle} onChange={e => setObligationTitle(e.target.value)} placeholder={lang === 'ru' ? 'Например, автокредит' : 'e.g. Car loan'}/></label>
            <label>{tr(lang, 'category')}<select value={obligationCategory} onChange={e => setObligationCategory(e.target.value)}>{(lang === 'ru' ? ['Кредит','Автокредит','Ипотека','Аренда','Коммунальные услуги','Фитнес','Подписки','Другое'] : ['Loan','Car loan','Mortgage','Rent','Utilities','Fitness','Subscriptions','Other']).map(x=><option key={x}>{x}</option>)}</select></label>
            <label>{tr(lang, 'amount')}<input type="number" min="0.01" step="0.01" required value={obligationAmount} onChange={e => setObligationAmount(e.target.value)}/></label>
            <label>{tr(lang, 'frequency')}<select value={obligationRecurrence} onChange={e => setObligationRecurrence(e.target.value)}><option value="MONTHLY">{tr(lang, 'monthly')}</option><option value="ONCE">{tr(lang, 'once')}</option><option value="WEEKLY">{tr(lang, 'weekly')}</option><option value="YEARLY">{tr(lang, 'yearly')}</option></select></label>
            {obligationRecurrence === 'MONTHLY' && <label>{tr(lang, 'day')}<input type="number" min="1" max="31" value={obligationDay} onChange={e => setObligationDay(e.target.value)}/></label>}
            <label>{tr(lang, 'startDate')}<input type="date" required value={obligationDate} onChange={e => setObligationDate(e.target.value)}/></label>
            <label>{tr(lang, 'member')}<select value={obligationMember} onChange={e => setObligationMember(e.target.value)}>{memberOptions}</select></label>
            <button className="pf-button primary" disabled={busy}>{tr(lang, 'add')}</button>
          </form>
        </section>
        <section className="pf-card"><div className="pf-card-heading"><div><span className="pf-eyebrow">{lang === 'ru' ? 'ПЛАН И ОПЛАТА' : 'DUE AND PAID'}</span><h2>{tr(lang, 'obligations')}</h2></div><span className="pf-count">{monthObligations.length}</span></div>
          {visibleObligations.length ? visibleObligations.map(item => <div className="pf-list-row" key={item.id}><div><strong>{item.obligation.title}</strong><small>{item.obligation.category} · {dateLabel(item.dueDate, lang)}</small><small className={item.status === 'PAID' ? 'positive' : item.status === 'OVERDUE' ? 'negative' : ''}>{item.status === 'PAID' ? tr(lang, 'paidStatus') : item.status === 'OVERDUE' ? tr(lang, 'overdue') : tr(lang, 'unpaid')}</small></div><div className="pf-row-action"><b>{rub(item.actualAmount ?? item.plannedAmount)}</b>{item.status !== 'PAID' && <button className="pf-button small" disabled={busy} onClick={() => markPaid(item.id)}>{tr(lang, 'paidAction')}</button>}</div></div>) : <p className="pf-empty">{tr(lang, 'noData')}</p>}
        </section>
      </div>}

      {tab === 'family' && <div className="pf-page pf-two-col">
        <section className="pf-card"><div className="pf-card-heading"><div><span className="pf-eyebrow">{lang === 'ru' ? 'УЧАСТНИКИ ДОМОХОЗЯЙСТВА' : 'HOUSEHOLD MEMBERS'}</span><h2>{tr(lang, 'family')}</h2></div></div>
          <form className="pf-inline-form" onSubmit={addMember}><label>{tr(lang, 'newMember')}<input required value={newMemberName} onChange={e => setNewMemberName(e.target.value)}/></label><button className="pf-button primary" disabled={busy}>{tr(lang, 'addMember')}</button></form>
          {members.map(m => <div className="pf-list-row" key={m.id}><div><strong>{m.name}</strong><small>{lang === 'ru' ? 'Участник семейного бюджета' : 'Household member'}</small></div><span className="pf-member-dot"/></div>)}
        </section>
        <section className="pf-card"><div className="pf-card-heading"><div><span className="pf-eyebrow">{lang === 'ru' ? 'ОБЩИЕ ПРАВИЛА' : 'HOUSEHOLD RULES'}</span><h2>{lang === 'ru' ? 'Как считается бюджет' : 'How the budget works'}</h2></div></div>
          <ul className="pf-rules"><li>{lang === 'ru' ? 'Доходы учитываются в фактическом остатке только после отметки «Получено».' : 'Income affects actual balance only after being marked received.'}</li><li>{lang === 'ru' ? 'Обязательство становится расходом один раз после отметки «Оплачено».' : 'An obligation becomes an expense once when marked paid.'}</li><li>{lang === 'ru' ? 'Пустой участник означает общий расход или доход семьи.' : 'An empty member means a shared household item.'}</li><li>{lang === 'ru' ? 'Все суммы ведутся только в рублях.' : 'All amounts are tracked in RUB only.'}</li></ul>
        </section>
      </div>}
      <footer className="pf-footer">FLOWMONEY <span>·</span> {lang === 'ru' ? 'Семейные финансы без догадок' : 'Family finances, without guesswork'}</footer>
    </main>
  </div>;
}
