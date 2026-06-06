import React, { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { loadBootstrapCache, saveBootstrapCache } from './storage';

const DEFAULT_SETTINGS = {
  currency: 'INR',
  reminderTime: '13:00',
  notificationsEnabled: false,
  weeklySummaryEnabled: true,
  monthlyBudget: 0,
  theme: 'system'
};
const MEALS = [{ key: 'lunch', label: 'Lunch' }, { key: 'dinner', label: 'Dinner' }];
const EXPENSE_KINDS = [{ key: 'meal', label: 'Meal' }, { key: 'extra', label: 'Extra food' }];
const MONTHLY_CATEGORIES = ['Housing', 'Utilities', 'Transport', 'Groceries', 'Health', 'Subscriptions', 'Shopping', 'Family', 'Travel', 'Other'];

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, message: '' };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, message: error?.message || 'App crashed.' };
  }
  componentDidCatch(error) { console.error(error); }
  render() {
    if (this.state.hasError) {
      return <div className="auth-shell"><div className="auth-card"><p className="eyebrow">App error</p><h1>Something broke</h1><p className="muted">{this.state.message}</p><button className="primary-btn" onClick={() => window.location.reload()}>Reload app</button></div></div>;
    }
    return this.props.children;
  }
}

function AppContent() {
  const [route, setRoute] = useState(routeFromPath(window.location.pathname));
  const [screen, setScreen] = useState('home');
  const [expenses, setExpenses] = useState([]);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [selectedDate, setSelectedDate] = useState(todayISO());
  const [sheetOpen, setSheetOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [offlineMessage, setOfflineMessage] = useState('');
  const [toast, setToast] = useState('');
  const [requiresToken, setRequiresToken] = useState(false);
  const [tokenDraft, setTokenDraft] = useState(api.getToken());
  const [apiBaseDraft, setApiBaseDraft] = useState(api.getApiBase());
  const [needsApiSetup, setNeedsApiSetup] = useState(false);
  const [installPrompt, setInstallPrompt] = useState(null);
  const [isInstalled, setIsInstalled] = useState(isStandalone());
  const [permission, setPermission] = useState(getNotificationPermission());
  const [pushStatus, setPushStatus] = useState({ configured: false, subscriptions: 0, publicKey: '' });
  const [pushBusy, setPushBusy] = useState(false);
  const [filters, setFilters] = useState({ from: startOfMonthISO(todayISO()), to: todayISO(), q: '' });
  const [form, setForm] = useState({ kind: 'meal', mealType: 'lunch', title: '', date: todayISO(), amount: '', note: '', tag: '' });
  const [monthlyMonth, setMonthlyMonth] = useState(todayISO().slice(0, 7));
  const [monthlyData, setMonthlyData] = useState(null);
  const [monthlyLoading, setMonthlyLoading] = useState(false);
  const [monthlyError, setMonthlyError] = useState('');
  const [monthlySheetOpen, setMonthlySheetOpen] = useState(false);
  const [monthlyForm, setMonthlyForm] = useState(newMonthlyForm(todayISO().slice(0, 7)));

  useEffect(() => { bootstrap(); }, []);
  useEffect(() => {
    const handleRoute = () => setRoute(routeFromPath(window.location.pathname));
    window.addEventListener('popstate', handleRoute);
    return () => window.removeEventListener('popstate', handleRoute);
  }, []);
  useEffect(() => { document.documentElement.dataset.theme = resolveTheme(settings.theme); }, [settings.theme]);
  useEffect(() => {
    if (route === 'monthly' && !loading && !requiresToken && !needsApiSetup) fetchMonthly(monthlyMonth);
  }, [route, monthlyMonth, loading, requiresToken, needsApiSetup]);
  useEffect(() => {
    const handleInstallPrompt = (event) => { event.preventDefault(); setInstallPrompt(event); };
    const handleInstalled = () => { setIsInstalled(true); setInstallPrompt(null); };
    window.addEventListener('beforeinstallprompt', handleInstallPrompt);
    window.addEventListener('appinstalled', handleInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', handleInstallPrompt);
      window.removeEventListener('appinstalled', handleInstalled);
    };
  }, []);
  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(''), 2400);
    return () => clearTimeout(timer);
  }, [toast]);

  const currentEntries = useMemo(() => expenses.filter((entry) => entry.date === selectedDate), [expenses, selectedDate]);
  const mealEntries = currentEntries.filter((entry) => entry.kind === 'meal');
  const extraEntries = currentEntries.filter((entry) => entry.kind === 'extra');
  const completedMeals = MEALS.filter((meal) => mealEntries.some((entry) => entry.mealType === meal.key)).length;
  const todayTotal = sum(currentEntries);
  const selectedWeekTotal = sum(rangeExpenses(expenses, startOfWeekISO(selectedDate), endOfWeekISO(selectedDate)));
  const selectedMonthEntries = expenses.filter((entry) => entry.date.startsWith(selectedDate.slice(0, 7)));
  const selectedMonthTotal = sum(selectedMonthEntries);
  const streak = computeStreak(expenses);
  const insights = useMemo(() => buildInsights(expenses, settings, selectedDate), [expenses, settings, selectedDate]);
  const historyEntries = useMemo(() => expenses.filter((entry) => {
    const inRange = entry.date >= filters.from && entry.date <= filters.to;
    const haystack = `${entry.title || ''} ${entry.note || ''} ${entry.tag || ''} ${entry.mealType} ${entry.kind || ''}`.toLowerCase();
    return inRange && (!filters.q || haystack.includes(filters.q.toLowerCase()));
  }), [expenses, filters]);
  const groupedHistory = useMemo(() => groupByDate(historyEntries), [historyEntries]);
  const historyDates = Object.keys(groupedHistory).sort((a, b) => b.localeCompare(a));

  async function bootstrap() {
    setLoading(true);
    setError('');
    try {
      const payload = await api.bootstrap();
      setExpenses(Array.isArray(payload.expenses) ? payload.expenses : []);
      setSettings({ ...DEFAULT_SETTINGS, ...(payload.settings || {}) });
      setPushStatus(payload.push || { configured: false, subscriptions: 0, publicKey: '' });
      saveBootstrapCache(payload);
      setOfflineMessage('');
      setNeedsApiSetup(false);
      setRequiresToken(false);
    } catch (err) {
      if (err.status === 401) {
        setNeedsApiSetup(false);
        setRequiresToken(true);
        setError(err.message);
      } else {
        const cached = loadBootstrapCache();
        if (cached) {
          setExpenses(Array.isArray(cached.expenses) ? cached.expenses : []);
          setSettings({ ...DEFAULT_SETTINGS, ...(cached.settings || {}) });
          setPushStatus(cached.push || { configured: false, subscriptions: 0, publicKey: '' });
          setOfflineMessage('Showing your last synced data.');
        } else if (!err.status) {
          setNeedsApiSetup(true);
          setError('Add your VPS backend URL to connect this Cloudflare Pages app.');
        } else {
          setError(err.message || 'Unable to load your data.');
        }
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveExpense(event) {
    event.preventDefault();
    if (form.amount === '' || !Number.isFinite(Number(form.amount)) || Number(form.amount) < 0) {
      setToast('Add a valid non-negative amount first.');
      return;
    }
    if (form.kind === 'extra' && !form.title.trim()) {
      setToast('Add a title for the extra food expense.');
      return;
    }
    try {
      const payload = form.kind === 'meal'
        ? { kind: 'meal', mealType: form.mealType, date: form.date, amount: Number(form.amount), note: form.note, tag: form.tag }
        : { kind: 'extra', title: form.title, date: form.date, amount: Number(form.amount), note: form.note, tag: form.tag };
      const { expense } = await api.upsertExpense(payload);
      setExpenses((current) => {
        const next = current.filter((entry) => {
          if (expense.kind === 'meal') return !(entry.kind === 'meal' && entry.date === expense.date && entry.mealType === expense.mealType);
          return true;
        });
        next.push(expense);
        return sortExpenses(next);
      });
      setSelectedDate(form.date);
      setSheetOpen(false);
      setToast('Saved.');
    } catch (err) {
      setToast(err.message || 'Could not save expense.');
    }
  }

  async function handleDelete(date, kind, itemId) {
    try {
      await api.deleteExpense(date, kind, itemId);
      setExpenses((current) => current.filter((entry) => {
        if (kind === 'meal') return !(entry.kind === 'meal' && entry.date === date && entry.mealType === itemId);
        return !(entry.kind === 'extra' && entry.id === itemId);
      }));
      setToast('Entry deleted.');
    } catch (err) {
      setToast(err.message || 'Delete failed.');
    }
  }

  async function patchSettings(patch) {
    const next = { ...settings, ...patch };
    setSettings(next);
    try {
      const response = await api.updateSettings(next);
      setSettings({ ...DEFAULT_SETTINGS, ...(response.settings || {}) });
      setToast('Settings saved.');
    } catch (err) {
      setToast(err.message || 'Settings could not be saved.');
    }
  }

  function openSheet(mealType) {
    const existing = expenses.find((entry) => entry.kind === 'meal' && entry.date === selectedDate && entry.mealType === mealType);
    setForm({ kind: 'meal', mealType, title: '', date: selectedDate, amount: existing?.amount ?? '', note: existing?.note ?? '', tag: existing?.tag ?? '' });
    setSheetOpen(true);
  }

  function openExtraSheet() {
    setForm({ kind: 'extra', mealType: 'lunch', title: '', date: selectedDate, amount: '', note: '', tag: '' });
    setSheetOpen(true);
  }

  async function installApp() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    setInstallPrompt(null);
  }

  async function saveTokenAndRetry(event) {
    event.preventDefault();
    api.setToken(tokenDraft.trim());
    await bootstrap();
  }

  async function saveApiBaseAndRetry(event) {
    event.preventDefault();
    const clean = api.setApiBase(apiBaseDraft);
    setApiBaseDraft(clean);
    await bootstrap();
  }

  async function enablePush() {
    setPushBusy(true);
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') {
        setToast('Push is not supported in this browser.');
        return;
      }
      const keyPayload = await api.getPushPublicKey();
      if (!keyPayload.configured || !keyPayload.publicKey) {
        setToast('Push is not configured on the server yet.');
        return;
      }
      const nextPermission = await Notification.requestPermission();
      setPermission(nextPermission);
      if (nextPermission !== 'granted') {
        setToast('Notifications were not enabled.');
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      const subscription = existing || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(keyPayload.publicKey) });
      const response = await api.subscribePush(subscription.toJSON());
      setPushStatus(response.push || { ...pushStatus, subscriptions: Math.max(pushStatus.subscriptions, 1) });
      await patchSettings({ notificationsEnabled: true });
      setToast('Push reminders enabled.');
    } catch (err) {
      setToast(err.message || 'Push setup failed.');
    } finally {
      setPushBusy(false);
    }
  }

  async function disablePush() {
    setPushBusy(true);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await api.unsubscribePush(subscription.endpoint);
        await subscription.unsubscribe();
      }
      await patchSettings({ notificationsEnabled: false });
      setPushStatus((current) => ({ ...current, subscriptions: Math.max(0, current.subscriptions - 1) }));
      setToast('Push reminders disabled.');
    } catch (err) {
      setToast(err.message || 'Could not disable push.');
    } finally {
      setPushBusy(false);
    }
  }

  async function sendTestPush() {
    setPushBusy(true);
    try {
      const response = await api.testPush();
      setPushStatus(response.push || pushStatus);
      setToast(response.sent ? 'Test notification sent.' : 'No active device subscription yet.');
    } catch (err) {
      setToast(err.message || 'Test push failed.');
    } finally {
      setPushBusy(false);
    }
  }

  function navigateTo(path) {
    window.history.pushState({}, '', path);
    setRoute(routeFromPath(path));
  }

  async function fetchMonthly(month) {
    setMonthlyLoading(true);
    setMonthlyError('');
    try {
      const payload = await api.getMonthly(month);
      setMonthlyData(payload);
    } catch (err) {
      setMonthlyError(err.message || 'Monthly expenses could not be loaded.');
    } finally {
      setMonthlyLoading(false);
    }
  }

  function openMonthlySheet(entry) {
    setMonthlyForm(entry
      ? {
          id: entry.id,
          title: entry.title || '',
          category: entry.category || 'Other',
          date: entry.date || `${monthlyMonth}-01`,
          amount: entry.amount ?? '',
          note: entry.note || '',
          tag: entry.tag || '',
          recurring: false,
          recurringDay: Number(entry.date?.slice(-2) || 1)
        }
      : newMonthlyForm(monthlyMonth));
    setMonthlySheetOpen(true);
  }

  async function handleSaveMonthlyExpense(event) {
    event.preventDefault();
    const amount = Number(monthlyForm.amount);
    if (!monthlyForm.title.trim()) {
      setToast('Add an expense title.');
      return;
    }
    if (!monthlyForm.category.trim()) {
      setToast('Choose a category.');
      return;
    }
    if (monthlyForm.amount === '' || !Number.isFinite(amount) || amount < 0) {
      setToast('Add a valid non-negative amount first.');
      return;
    }
    try {
      const payload = await api.saveMonthlyExpense({
        id: monthlyForm.id || undefined,
        month: monthlyMonth,
        title: monthlyForm.title,
        category: monthlyForm.category,
        date: monthlyForm.date || `${monthlyMonth}-01`,
        amount,
        note: monthlyForm.note,
        tag: monthlyForm.tag,
        recurring: Boolean(monthlyForm.recurring && !monthlyForm.id),
        recurringDay: Number(monthlyForm.recurringDay || 1)
      });
      setMonthlyData(payload);
      setMonthlySheetOpen(false);
      setToast('Monthly expense saved.');
    } catch (err) {
      setToast(err.message || 'Could not save monthly expense.');
    }
  }

  async function deleteMonthlyExpense(entry) {
    try {
      const payload = await api.deleteMonthlyExpense(entry.id, monthlyMonth);
      setMonthlyData(payload);
      setToast(entry.recurringId ? 'Skipped this recurring expense for the month.' : 'Monthly expense deleted.');
    } catch (err) {
      setToast(err.message || 'Delete failed.');
    }
  }

  async function pauseRecurringExpense(entry) {
    try {
      const payload = await api.updateRecurringExpense(entry.id, { active: false, month: monthlyMonth });
      setMonthlyData(payload);
      setToast('Recurring expense paused.');
    } catch (err) {
      setToast(err.message || 'Recurring expense could not be paused.');
    }
  }

  if (requiresToken) {
    return <div className="auth-shell"><div className="auth-card"><p className="eyebrow">Private deployment</p><h1>Connect to your app</h1><p className="muted">This backend expects your private app token.</p><form className="stack" onSubmit={saveTokenAndRetry}><label className="field"><span>App token</span><input className="input" value={tokenDraft} onChange={(event) => setTokenDraft(event.target.value)} placeholder="Paste APP_TOKEN" /></label><button className="primary-btn" type="submit">Save token</button></form>{error ? <p className="inline-error">{error}</p> : null}</div></div>;
  }

  if (needsApiSetup) {
    return <div className="auth-shell"><div className="auth-card"><p className="eyebrow">Cloudflare setup</p><h1>Connect your backend</h1><p className="muted">Enter the HTTPS URL for the VPS API running on port 9900 behind Nginx.</p><form className="stack" onSubmit={saveApiBaseAndRetry}><label className="field"><span>Backend API URL</span><input className="input" value={apiBaseDraft} onChange={(event) => setApiBaseDraft(event.target.value)} placeholder="https://api.example.com" /></label><button className="primary-btn" type="submit">Save and connect</button></form>{error ? <p className="inline-error">{error}</p> : null}</div></div>;
  }

  return <div className="app-shell"><div className="app-frame">
    <header className="topbar"><div className="brand"><div className="logo" aria-hidden="true">M</div><div><p className="eyebrow">Private tracker</p><h1>Meal Check In</h1></div></div><div className="topbar-actions"><button className="icon-btn" onClick={() => navigateTo(route === 'monthly' ? '/' : '/expenses')}>{route === 'monthly' ? 'Meals' : 'Monthly'}</button>{installPrompt ? <button className="icon-btn" onClick={installApp}>Install</button> : null}<button className="icon-btn" onClick={() => patchSettings({ theme: nextTheme(settings.theme) })}>{themeLabel(settings.theme)}</button></div></header>
    {offlineMessage ? <div className="banner">{offlineMessage}</div> : null}
    {loading ? <div className="section loading-card">Loading your tracker...</div> : null}
    {error && !loading ? <div className="section inline-error">{error}</div> : null}

    {!loading && !error ? <main className="content">
      {route === 'monthly' ? <MonthlyExpensesView month={monthlyMonth} setMonth={setMonthlyMonth} data={monthlyData} loading={monthlyLoading} error={monthlyError} settings={settings} onBack={() => navigateTo('/')} onAdd={() => openMonthlySheet()} onEdit={openMonthlySheet} onDelete={deleteMonthlyExpense} onPauseRecurring={pauseRecurringExpense} /> : null}
      {route !== 'monthly' ? <>
      {screen === 'home' ? <section className="screen-block">
        <section className="hero-panel"><div className="hero-row"><div><p className="eyebrow">Today</p><h2>{prettyDate(selectedDate)}</h2><p className="muted">Log lunch and dinner, then let the app handle reminders.</p></div><input className="date-input" type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} /></div><div className="progress-line"><span style={{ width: `${completedMeals * 50}%` }} /></div><div className="hero-totals"><Metric label="Today" value={formatCurrency(todayTotal, settings.currency)} /><Metric label="This week" value={formatCurrency(selectedWeekTotal, settings.currency)} /><Metric label="Streak" value={`${streak} day${streak === 1 ? '' : 's'}`} /></div></section>
        <section className="meal-grid">{MEALS.map((meal) => { const entry = mealEntries.find((item) => item.mealType === meal.key); return <article className="meal-card" key={meal.key}><div className="row-between"><div className={`status-pill ${entry ? 'done' : ''}`}>{meal.label}</div><span className={`tag ${entry ? '' : 'pending'}`}>{entry ? 'Saved' : 'Pending'}</span></div><div><div className="amount">{entry ? formatCurrency(entry.amount, settings.currency) : 'Not logged'}</div><p className="muted meal-note">{entry ? entry.note || entry.tag || 'Saved for this meal.' : 'Amount is required; note and tag are optional.'}</p></div><div className="row-between actions-row"><span className="helper">{entry?.tag || 'Fast edit for any date'}</span><button className={`action-btn ${entry ? 'secondary' : ''}`} onClick={() => openSheet(meal.key)}>{entry ? `Edit ${meal.label}` : `Add ${meal.label}`}</button></div></article>; })}</section>
        <section className="section"><div className="section-head"><h3>Extra food</h3><button className="ghost-btn" onClick={openExtraSheet}>Add extra</button></div>{extraEntries.length ? <div className="extra-list">{extraEntries.map((entry) => <div className="history-row extra-row" key={entry.id}><div><p className="history-meal">{entry.title || 'Extra food'}</p><p className="muted small">{entry.note || entry.tag || 'One-off food expense'}</p></div><div className="history-actions"><strong>{formatCurrency(entry.amount, settings.currency)}</strong><button className="tiny-link" onClick={() => handleDelete(entry.date, 'extra', entry.id)}>Delete</button></div></div>)}</div> : <div className="empty-state"><strong>No extra food expenses yet</strong><p>Add snacks, drinks, desserts, or other food costs separately.</p></div>}</section>
        <section className="section"><div className="section-head"><h3>Insights</h3><button className="ghost-btn" onClick={() => api.exportCsv().then(() => setToast('CSV exported.')).catch(() => setToast('CSV export failed.'))}>Export CSV</button></div><div className="stat-grid"><StatCard label="Month total" value={formatCurrency(selectedMonthTotal, settings.currency)} /><StatCard label="Meal average" value={formatCurrency(insights.averageMeal, settings.currency)} /><StatCard label="Top tag" value={insights.topTag} /><StatCard label="Week change" value={insights.weekChange} /></div><div className="budget-row"><div><span>Monthly budget</span><strong>{settings.monthlyBudget ? `${Math.min(100, Math.round((selectedMonthTotal / settings.monthlyBudget) * 100))}% used` : 'Not set'}</strong></div><div className="budget-track"><span style={{ width: settings.monthlyBudget ? `${Math.min(100, (selectedMonthTotal / settings.monthlyBudget) * 100)}%` : '0%' }} /></div></div></section>
        <section className="section"><div className="section-head"><h3>Last 7 days</h3><span className="helper">Spend trend</span></div><div className="spark-bars">{insights.lastSeven.map((day) => <div className="spark-day" key={day.date}><span style={{ height: `${day.height}%` }} /><small>{shortDate(day.date)}</small></div>)}</div></section>
      </section> : null}

      {screen === 'history' ? <section className="screen-block"><section className="section"><div className="section-head"><h2>History</h2></div><div className="filter-grid"><label className="field"><span>From</span><input className="input" type="date" value={filters.from} onChange={(event) => setFilters((current) => ({ ...current, from: event.target.value }))} /></label><label className="field"><span>To</span><input className="input" type="date" value={filters.to} onChange={(event) => setFilters((current) => ({ ...current, to: event.target.value }))} /></label></div><label className="field"><span>Search note or tag</span><input className="input" type="search" placeholder="Office, home, travel" value={filters.q} onChange={(event) => setFilters((current) => ({ ...current, q: event.target.value }))} /></label><div className="stat-grid two"><StatCard label="Visible days" value={String(historyDates.length)} /><StatCard label="Visible total" value={formatCurrency(sum(historyEntries), settings.currency)} /></div><div className="history-list">{historyDates.length ? historyDates.map((date) => <article className="day-card" key={date}><div className="row-between day-head"><div><h3>{prettyDate(date)}</h3><p className="muted">{groupedHistory[date].length} entries</p></div><strong className="day-total">{formatCurrency(sum(groupedHistory[date]), settings.currency)}</strong></div>{groupedHistory[date].map((entry) => <div className="history-row" key={entry.id}><div><p className="history-meal">{entry.kind === 'extra' ? (entry.title || 'Extra food') : title(entry.mealType)} {entry.tag ? <span className="tag">{entry.tag}</span> : null}</p><p className="muted small">{entry.note || (entry.kind === 'extra' ? 'One-off food expense' : 'No note')}</p></div><div className="history-actions"><strong>{formatCurrency(entry.amount, settings.currency)}</strong><button className="tiny-link" onClick={() => handleDelete(entry.date, entry.kind, entry.kind === 'meal' ? entry.mealType : entry.id)}>Delete</button></div></div>)}</article>) : <div className="empty-state"><strong>No matching days yet</strong><p>Try a broader date range or clear your search.</p></div>}</div></section></section> : null}

      {screen === 'settings' ? <section className="screen-block"><section className="section settings-stack"><div className="section-head"><h2>Settings</h2></div><div className="filter-grid"><label className="field"><span>Reminder time</span><input className="input" type="time" value={settings.reminderTime} onChange={(event) => patchSettings({ reminderTime: event.target.value })} /></label><label className="field"><span>Currency</span><select className="input" value={settings.currency} onChange={(event) => patchSettings({ currency: event.target.value })}><option value="INR">INR</option><option value="USD">USD</option><option value="EUR">EUR</option><option value="GBP">GBP</option></select></label></div><label className="field"><span>Monthly budget</span><input className="input" type="number" min="0" step="0.01" value={settings.monthlyBudget || ''} onChange={(event) => patchSettings({ monthlyBudget: Number(event.target.value || 0) })} placeholder="Optional" /></label><div className="setting-row"><div><p>Daily push reminders</p><small>Server sends a reminder at {settings.reminderTime} when a meal is missing.</small></div><button className={`toggle ${settings.notificationsEnabled ? 'on' : ''}`} disabled={pushBusy} onClick={settings.notificationsEnabled ? disablePush : enablePush}>{settings.notificationsEnabled ? 'On' : 'Off'}</button></div><div className="setting-row"><div><p>Weekly summary</p><small>Sunday evening total, streak, and logged days.</small></div><button className={`toggle ${settings.weeklySummaryEnabled ? 'on' : ''}`} onClick={() => patchSettings({ weeklySummaryEnabled: !settings.weeklySummaryEnabled })}>{settings.weeklySummaryEnabled ? 'On' : 'Off'}</button></div><div className="setting-row"><div><p>Push status</p><small>{pushStatus.configured ? `${pushStatus.subscriptions} active device${pushStatus.subscriptions === 1 ? '' : 's'}; permission ${permission}` : 'Server VAPID keys are not configured.'}</small></div><button className="ghost-btn" disabled={pushBusy || !pushStatus.configured} onClick={sendTestPush}>Test</button></div><div className="setting-row"><div><p>Install status</p><small>{isInstalled ? 'Installed as a standalone app.' : installPrompt ? 'Ready to install on this device.' : 'Install prompt appears when the browser allows it.'}</small></div><button className="ghost-btn" disabled={!installPrompt} onClick={installApp}>Install</button></div><div className="field"><span>Backend API URL</span><input className="input" value={apiBaseDraft} onChange={(event) => setApiBaseDraft(event.target.value)} placeholder="https://api.example.com" /><div className="row-between actions-row compact"><button className="ghost-btn" onClick={() => { const clean = api.setApiBase(apiBaseDraft); setApiBaseDraft(clean); setToast('Backend URL saved.'); bootstrap(); }}>Save URL</button><button className="ghost-btn" onClick={() => { api.setApiBase(''); setApiBaseDraft(''); setToast('Backend URL cleared.'); }}>Clear</button></div></div><div className="field"><span>API token</span><input className="input" value={tokenDraft} onChange={(event) => setTokenDraft(event.target.value)} placeholder="Only needed if APP_TOKEN is set" /><div className="row-between actions-row compact"><button className="ghost-btn" onClick={() => { api.setToken(tokenDraft.trim()); setToast('Token saved in this browser.'); }}>Save token</button><button className="ghost-btn" onClick={() => { api.setToken(''); setTokenDraft(''); setToast('Token cleared.'); }}>Clear</button></div></div></section></section> : null}
      </> : null}
    </main> : null}
  </div>

  {route !== 'monthly' ? <nav className="bottom-nav"><button className={screen === 'home' ? 'active' : ''} onClick={() => setScreen('home')}>Today</button><button className={screen === 'history' ? 'active' : ''} onClick={() => setScreen('history')}>History</button><button className="add-btn" onClick={() => openSheet(nextMeal(currentEntries))}>+</button><button className={screen === 'settings' ? 'active' : ''} onClick={() => setScreen('settings')}>Settings</button></nav> : null}

  {sheetOpen ? <div className="sheet-backdrop" onClick={() => setSheetOpen(false)}><div className="sheet" onClick={(event) => event.stopPropagation()}><div className="sheet-head"><div><p className="eyebrow">Quick add</p><h3>{form.kind === 'extra' ? 'Extra food' : title(form.mealType)}</h3></div><button className="icon-btn" onClick={() => setSheetOpen(false)}>Close</button></div><form className="stack" onSubmit={handleSaveExpense}><label className="field"><span>Type</span><select className="input" value={form.kind} onChange={(event) => setForm((current) => ({ ...current, kind: event.target.value, title: event.target.value === 'extra' ? current.title : '' }))}>{EXPENSE_KINDS.map((kind) => <option key={kind.key} value={kind.key}>{kind.label}</option>)}</select></label>{form.kind === 'meal' ? <label className="field"><span>Meal</span><select className="input" value={form.mealType} onChange={(event) => setForm((current) => ({ ...current, mealType: event.target.value }))}>{MEALS.map((meal) => <option key={meal.key} value={meal.key}>{meal.label}</option>)}</select></label> : <label className="field"><span>Title</span><input className="input" value={form.title} onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))} placeholder="Snacks, tea, dessert, extra meal" /></label>}<label className="field"><span>Date</span><input className="input" type="date" value={form.date} onChange={(event) => setForm((current) => ({ ...current, date: event.target.value }))} /></label><label className="field"><span>Amount</span><input className="input amount-input" inputMode="decimal" type="number" min="0" step="0.01" value={form.amount} onChange={(event) => setForm((current) => ({ ...current, amount: event.target.value }))} placeholder="0" /></label><label className="field"><span>Note</span><textarea className="input textarea" value={form.note} onChange={(event) => setForm((current) => ({ ...current, note: event.target.value }))} placeholder="Home food, outside, takeaway" /></label><label className="field"><span>Category / tag</span><input className="input" value={form.tag} onChange={(event) => setForm((current) => ({ ...current, tag: event.target.value }))} placeholder="Office, Home, Travel" /></label><button className="primary-btn" type="submit">Save entry</button></form></div></div> : null}
  {monthlySheetOpen ? <div className="sheet-backdrop" onClick={() => setMonthlySheetOpen(false)}><div className="sheet" onClick={(event) => event.stopPropagation()}><div className="sheet-head"><div><p className="eyebrow">Monthly ledger</p><h3>{monthlyForm.id ? 'Edit expense' : 'Add expense'}</h3></div><button className="icon-btn" onClick={() => setMonthlySheetOpen(false)}>Close</button></div><form className="stack" onSubmit={handleSaveMonthlyExpense}><div className="filter-grid"><label className="field"><span>Title</span><input className="input" value={monthlyForm.title} onChange={(event) => setMonthlyForm((current) => ({ ...current, title: event.target.value }))} placeholder="Rent, recharge, medicine" /></label><label className="field"><span>Category</span><select className="input" value={monthlyForm.category} onChange={(event) => setMonthlyForm((current) => ({ ...current, category: event.target.value }))}>{MONTHLY_CATEGORIES.map((category) => <option key={category} value={category}>{category}</option>)}</select></label></div><div className="filter-grid"><label className="field"><span>Date</span><input className="input" type="date" value={monthlyForm.date} onChange={(event) => setMonthlyForm((current) => ({ ...current, date: event.target.value }))} /></label><label className="field"><span>Amount</span><input className="input" type="number" min="0" step="0.01" inputMode="decimal" value={monthlyForm.amount} onChange={(event) => setMonthlyForm((current) => ({ ...current, amount: event.target.value }))} placeholder="0" /></label></div><label className="field"><span>Note</span><textarea className="input textarea" value={monthlyForm.note} onChange={(event) => setMonthlyForm((current) => ({ ...current, note: event.target.value }))} placeholder="Optional context" /></label><label className="field"><span>Tag</span><input className="input" value={monthlyForm.tag} onChange={(event) => setMonthlyForm((current) => ({ ...current, tag: event.target.value }))} placeholder="UPI, card, cash, planned" /></label>{!monthlyForm.id ? <div className="setting-row"><div><p>Repeat every month</p><small>Create this entry automatically for future months.</small></div><button type="button" className={`toggle ${monthlyForm.recurring ? 'on' : ''}`} onClick={() => setMonthlyForm((current) => ({ ...current, recurring: !current.recurring }))}>{monthlyForm.recurring ? 'On' : 'Off'}</button></div> : null}{monthlyForm.recurring && !monthlyForm.id ? <label className="field"><span>Repeat day</span><input className="input" type="number" min="1" max="31" value={monthlyForm.recurringDay} onChange={(event) => setMonthlyForm((current) => ({ ...current, recurringDay: event.target.value }))} /></label> : null}<button className="primary-btn" type="submit">Save expense</button></form></div></div> : null}
  {toast ? <div className="toast">{toast}</div> : null}
  </div>;
}

export default function App() {
  return <ErrorBoundary><AppContent /></ErrorBoundary>;
}

function Metric({ label, value }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
function StatCard({ label, value }) { return <div className="stat-card"><span>{label}</span><strong>{value}</strong></div>; }
function MonthlyExpensesView({ month, setMonth, data, loading, error, settings, onBack, onAdd, onEdit, onDelete, onPauseRecurring }) {
  const totals = data?.totals || { total: 0, food: 0, nonFood: 0, previousTotal: 0, changePercent: null, categories: [] };
  const monthly = data?.monthly || [];
  const recurring = data?.recurring || [];
  const food = data?.food || [];
  const foodEntries = food.slice(0, 6);
  return <section className="screen-block monthly-workspace">
    <section className="hero-panel"><div className="hero-row"><div><p className="eyebrow">Monthly expenses</p><h2>{formatMonth(month)}</h2><p className="muted">Food expenses are counted automatically from your meal tracker.</p></div><div className="month-actions"><input className="date-input" type="month" value={month} onChange={(event) => setMonth(event.target.value)} /><button className="ghost-btn" onClick={onBack}>Meals</button></div></div><div className="hero-totals monthly-totals"><Metric label="All expenses" value={formatCurrency(totals.total, settings.currency)} /><Metric label="Food" value={formatCurrency(totals.food, settings.currency)} /><Metric label="Other" value={formatCurrency(totals.nonFood, settings.currency)} /></div>{totals.changePercent === null ? <p className="muted small monthly-change">No previous month comparison yet.</p> : <p className="muted small monthly-change">{totals.changePercent >= 0 ? '+' : ''}{totals.changePercent}% versus previous month ({formatCurrency(totals.previousTotal, settings.currency)}).</p>}</section>
    {error ? <div className="section inline-error">{error}</div> : null}
    {loading ? <div className="section loading-card">Loading monthly ledger...</div> : null}
    {!loading ? <section className="section"><div className="section-head"><h3>Spend by category</h3><button className="ghost-btn" onClick={onAdd}>Add expense</button></div>{totals.categories.length ? <div className="category-list">{totals.categories.map((item) => <div className="category-row" key={item.category}><div><strong>{item.category}</strong><span>{Math.round((item.total / Math.max(1, totals.total)) * 100)}% of month</span></div><strong>{formatCurrency(item.total, settings.currency)}</strong></div>)}</div> : <div className="empty-state"><strong>No monthly expenses yet</strong><p>Add a monthly item or record a meal expense from the main tracker.</p></div>}</section> : null}
    {!loading ? <section className="section"><div className="section-head"><h3>Other monthly expenses</h3><button className="ghost-btn" onClick={onAdd}>Add</button></div>{monthly.length ? <div className="monthly-list">{monthly.map((entry) => <div className="monthly-row" key={entry.id}><div><p className="history-meal">{entry.title} <span className="tag">{entry.category || 'Other'}</span></p><p className="muted small">{shortDate(entry.date)}{entry.recurringId ? ' - recurring' : ''}{entry.note ? ` - ${entry.note}` : ''}</p></div><div className="history-actions"><strong>{formatCurrency(entry.amount, settings.currency)}</strong><button className="tiny-link" onClick={() => onEdit(entry)}>Edit</button><button className="tiny-link" onClick={() => onDelete(entry)}>{entry.recurringId ? 'Skip' : 'Delete'}</button></div></div>)}</div> : <div className="empty-state"><strong>No other expenses for this month</strong><p>Rent, bills, transport, shopping, subscriptions, and recurring costs go here.</p></div>}</section> : null}
    {!loading ? <section className="section"><div className="section-head"><h3>Food rollup</h3><strong>{formatCurrency(totals.food, settings.currency)}</strong></div>{foodEntries.length ? <div className="monthly-list">{foodEntries.map((entry) => <div className="monthly-row" key={entry.id}><div><p className="history-meal">{entry.kind === 'extra' ? entry.title || 'Extra food' : title(entry.mealType)}</p><p className="muted small">{shortDate(entry.date)}{entry.note ? ` - ${entry.note}` : ''}</p></div><strong>{formatCurrency(entry.amount, settings.currency)}</strong></div>)}</div> : <div className="empty-state"><strong>No food spend this month</strong><p>Meal and extra food entries from the main page will appear here automatically.</p></div>}{food.length > foodEntries.length ? <p className="muted small monthly-more">Showing {foodEntries.length} of {food.length} food entries.</p> : null}</section> : null}
    {!loading ? <section className="section"><div className="section-head"><h3>Recurring expenses</h3><span className="helper">{recurring.filter((item) => item.active).length} active</span></div>{recurring.length ? <div className="monthly-list">{recurring.map((entry) => <div className="monthly-row" key={entry.id}><div><p className="history-meal">{entry.title} <span className={`tag ${entry.active ? '' : 'pending'}`}>{entry.active ? 'Active' : 'Paused'}</span></p><p className="muted small">{entry.category} - day {entry.dayOfMonth}{entry.note ? ` - ${entry.note}` : ''}</p></div><div className="history-actions"><strong>{formatCurrency(entry.amount, settings.currency)}</strong>{entry.active ? <button className="tiny-link" onClick={() => onPauseRecurring(entry)}>Pause</button> : null}</div></div>)}</div> : <div className="empty-state"><strong>No recurring expenses</strong><p>Turn on repeat when adding rent, recharge, subscriptions, or other fixed costs.</p></div>}</section> : null}
  </section>;
}
function sum(items) { return items.reduce((total, item) => total + Number(item.amount || item.total || 0), 0); }
function sortExpenses(entries) { return [...entries].sort((a, b) => (a.date === b.date ? `${a.kind}-${a.mealType}-${a.createdAt}`.localeCompare(`${b.kind}-${b.mealType}-${b.createdAt}`) : b.date.localeCompare(a.date))); }
function rangeExpenses(expenses, from, to) { return expenses.filter((entry) => entry.date >= from && entry.date <= to); }
function groupByDate(entries) { return entries.reduce((acc, entry) => { acc[entry.date] = acc[entry.date] || []; acc[entry.date].push(entry); return acc; }, {}); }
function computeStreak(expenses) { const dates = new Set(expenses.map((item) => item.date)); let streak = 0; const cursor = new Date(); while (dates.has(toISO(cursor))) { streak += 1; cursor.setDate(cursor.getDate() - 1); } return streak; }
function buildInsights(expenses, settings, selectedDate) {
  const selectedWeek = rangeExpenses(expenses, startOfWeekISO(selectedDate), endOfWeekISO(selectedDate));
  const lastWeekStart = shiftISO(startOfWeekISO(selectedDate), -7);
  const lastWeekEnd = shiftISO(endOfWeekISO(selectedDate), -7);
  const lastWeek = rangeExpenses(expenses, lastWeekStart, lastWeekEnd);
  const selectedTotal = sum(selectedWeek);
  const lastTotal = sum(lastWeek);
  const averageMeal = expenses.length ? sum(expenses) / expenses.length : 0;
  const tagCounts = expenses.reduce((acc, entry) => { if (entry.tag) acc[entry.tag] = (acc[entry.tag] || 0) + 1; return acc; }, {});
  const topTag = Object.entries(tagCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'None yet';
  const weekChange = lastTotal ? `${selectedTotal >= lastTotal ? '+' : ''}${Math.round(((selectedTotal - lastTotal) / lastTotal) * 100)}%` : selectedTotal ? 'New spend' : 'No spend';
  const rawSeven = [];
  for (let i = 6; i >= 0; i -= 1) {
    const date = shiftISO(todayISO(), -i);
    rawSeven.push({ date, total: sum(expenses.filter((entry) => entry.date === date)) });
  }
  const max = Math.max(1, ...rawSeven.map((day) => day.total));
  return { averageMeal, topTag, weekChange, lastSeven: rawSeven.map((day) => ({ ...day, height: Math.max(8, Math.round((day.total / max) * 100)) })) };
}
function formatCurrency(value, currency) { return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(value || 0); }
function formatMonth(month) { return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(new Date(`${month}-01T00:00:00`)); }
function prettyDate(iso) { return new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${iso}T00:00:00`)); }
function shortDate(iso) { return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(new Date(`${iso}T00:00:00`)); }
function nextMeal(entries) { return entries.some((item) => item.mealType === 'lunch') ? 'dinner' : 'lunch'; }
function nextTheme(theme) { return theme === 'system' ? 'dark' : theme === 'dark' ? 'light' : 'system'; }
function themeLabel(theme) { return theme === 'system' ? 'Auto' : theme === 'dark' ? 'Dark' : 'Light'; }
function resolveTheme(theme) { if (theme === 'dark' || theme === 'light') return theme; return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
function routeFromPath(pathname) { return pathname === '/expenses' ? 'monthly' : 'main'; }
function newMonthlyForm(month) { return { id: '', title: '', category: 'Other', date: `${month}-01`, amount: '', note: '', tag: '', recurring: false, recurringDay: '1' }; }
function startOfMonthISO(iso) { const d = new Date(`${iso}T00:00:00`); d.setDate(1); return toISO(d); }
function startOfWeekISO(iso) { const d = new Date(`${iso}T00:00:00`); const day = d.getDay(); const diff = day === 0 ? -6 : 1 - day; d.setDate(d.getDate() + diff); return toISO(d); }
function endOfWeekISO(iso) { return shiftISO(startOfWeekISO(iso), 6); }
function shiftISO(iso, days) { const d = new Date(`${iso}T00:00:00`); d.setDate(d.getDate() + days); return toISO(d); }
function title(value) { return value.charAt(0).toUpperCase() + value.slice(1); }
function toISO(date) { return date.toISOString().slice(0, 10); }
function todayISO() { return toISO(new Date()); }
function isStandalone() { return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true; }
function getNotificationPermission() { return typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'; }
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}
