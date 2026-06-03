import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import cors from 'cors';
import cron from 'node-cron';
import express from 'express';
import morgan from 'morgan';
import webpush from 'web-push';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');
const PORT = Number(process.env.PORT || 9900);
const DB_PATH = path.resolve(ROOT_DIR, process.env.DB_PATH || './data/meal-check-in.db');
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || '';
const APP_TOKEN = process.env.APP_TOKEN || '';
const APP_TIMEZONE = process.env.TZ || 'Asia/Kolkata';
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
const WEEKLY_SUMMARY_TIME = process.env.WEEKLY_SUMMARY_TIME || '18:00';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS expenses (
    id TEXT PRIMARY KEY,
    expense_date TEXT NOT NULL,
    meal_type TEXT NOT NULL CHECK(meal_type IN ('lunch','dinner')),
    amount REAL NOT NULL,
    note TEXT DEFAULT '',
    tag TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ux_expenses_date_meal ON expenses(expense_date, meal_type);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    subscription_json TEXT NOT NULL,
    user_agent TEXT DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_error TEXT DEFAULT ''
  );
`);

process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection', error);
});
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception', error);
});

const DEFAULT_SETTINGS = {
  currency: 'INR',
  reminderTime: '13:00',
  notificationsEnabled: false,
  weeklySummaryEnabled: true,
  monthlyBudget: 0,
  theme: 'system'
};

const app = express();
app.use(express.json({ limit: '200kb' }));
app.use(morgan('tiny'));
app.use(cors(CLIENT_ORIGIN ? { origin: CLIENT_ORIGIN.split(',').map((v) => v.trim()) } : {}));
app.use((req, res, next) => {
  if (!APP_TOKEN || req.path === '/api/health') return next();
  if (req.get('x-app-token') === APP_TOKEN) return next();
  return res.status(401).json({ error: 'Unauthorized. Add a valid app token.' });
});

app.get('/api/health', (_req, res) => res.json({ ok: true, pushConfigured: isPushConfigured() }));

app.get('/api/bootstrap', (_req, res, next) => {
  try {
    res.json({
      settings: getSettings(),
      expenses: listExpenses(),
      push: getPushStatus(),
      generatedAt: new Date().toISOString()
    });
  } catch (error) { next(error); }
});

app.put('/api/expenses', (req, res, next) => {
  try {
    const payload = normalizeExpense(req.body || {});
    const existing = db.prepare('SELECT id, created_at FROM expenses WHERE expense_date = ? AND meal_type = ?').get(payload.expense_date, payload.meal_type);
    const now = new Date().toISOString();
    const expense = {
      id: existing?.id || payload.id || crypto.randomUUID(),
      expense_date: payload.expense_date,
      meal_type: payload.meal_type,
      amount: payload.amount,
      note: payload.note,
      tag: payload.tag,
      created_at: existing?.created_at || now,
      updated_at: now
    };
    db.prepare(`
      INSERT INTO expenses (id, expense_date, meal_type, amount, note, tag, created_at, updated_at)
      VALUES (@id, @expense_date, @meal_type, @amount, @note, @tag, @created_at, @updated_at)
      ON CONFLICT(expense_date, meal_type) DO UPDATE SET
        amount = excluded.amount,
        note = excluded.note,
        tag = excluded.tag,
        updated_at = excluded.updated_at
    `).run(expense);
    res.json({ expense: mapExpense(expense) });
  } catch (error) { next(error); }
});

app.delete('/api/expenses/:date/:mealType', (req, res, next) => {
  try {
    const { date, mealType } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !['lunch', 'dinner'].includes(mealType)) {
      return res.status(400).json({ error: 'Invalid expense target.' });
    }
    db.prepare('DELETE FROM expenses WHERE expense_date = ? AND meal_type = ?').run(date, mealType);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.put('/api/settings', (req, res, next) => {
  try {
    const current = getSettings();
    const input = req.body || {};
    const monthlyBudget = Number(input.monthlyBudget);
    const settings = {
      currency: ['INR', 'USD', 'EUR', 'GBP'].includes(input.currency) ? input.currency : current.currency,
      reminderTime: /^\d{2}:\d{2}$/.test(String(input.reminderTime || '')) ? input.reminderTime : current.reminderTime,
      notificationsEnabled: Boolean(input.notificationsEnabled),
      weeklySummaryEnabled: Boolean(input.weeklySummaryEnabled),
      monthlyBudget: Number.isFinite(monthlyBudget) && monthlyBudget >= 0 ? Math.round(monthlyBudget * 100) / 100 : current.monthlyBudget,
      theme: ['system', 'light', 'dark'].includes(input.theme) ? input.theme : current.theme
    };
    setSettings(settings);
    res.json({ settings: getSettings() });
  } catch (error) { next(error); }
});

app.get('/api/push/public-key', (_req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY, configured: isPushConfigured() });
});

app.post('/api/push/subscribe', (req, res, next) => {
  try {
    if (!isPushConfigured()) return res.status(503).json({ error: 'Web push is not configured on the server.' });
    const subscription = normalizeSubscription(req.body?.subscription || req.body);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO push_subscriptions (endpoint, subscription_json, user_agent, enabled, created_at, updated_at, last_error)
      VALUES (?, ?, ?, 1, ?, ?, '')
      ON CONFLICT(endpoint) DO UPDATE SET
        subscription_json = excluded.subscription_json,
        user_agent = excluded.user_agent,
        enabled = 1,
        updated_at = excluded.updated_at,
        last_error = ''
    `).run(subscription.endpoint, JSON.stringify(subscription), String(req.get('user-agent') || '').slice(0, 240), now, now);
    res.json({ ok: true, push: getPushStatus() });
  } catch (error) { next(error); }
});

app.delete('/api/push/subscribe', (req, res, next) => {
  try {
    const endpoint = String(req.body?.endpoint || '').trim();
    if (!endpoint) return res.status(400).json({ error: 'Missing subscription endpoint.' });
    db.prepare('UPDATE push_subscriptions SET enabled = 0, updated_at = ? WHERE endpoint = ?').run(new Date().toISOString(), endpoint);
    res.json({ ok: true, push: getPushStatus() });
  } catch (error) { next(error); }
});

app.post('/api/push/test', async (_req, res, next) => {
  try {
    if (!isPushConfigured()) return res.status(503).json({ error: 'Web push is not configured on the server.' });
    const result = await sendPushToAll({
      title: 'Meal Check In is ready',
      body: 'Push notifications are connected for this device.',
      tag: 'meal-checkin-test',
      url: '/'
    });
    res.json({ ok: true, ...result, push: getPushStatus() });
  } catch (error) { next(error); }
});

app.get('/api/export.csv', (_req, res, next) => {
  try {
    const rows = listExpenses();
    const csvRows = [
      ['date', 'meal_type', 'amount', 'note', 'tag', 'created_at', 'updated_at'],
      ...rows.map((row) => [row.date, row.mealType, row.amount.toFixed(2), row.note || '', row.tag || '', row.createdAt, row.updatedAt])
    ];
    const csv = csvRows.map((row) => row.map(csvCell).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="meal-check-in-${todayISO()}.csv"`);
    res.send(csv);
  } catch (error) { next(error); }
});

const clientDist = path.resolve(ROOT_DIR, 'client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist, { index: false }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error?.status || 500).json({ error: error?.message || 'Unexpected server error.' });
});

app.listen(PORT, () => {
  console.log(`Meal Check In server running on http://localhost:${PORT}`);
  console.log(`Web push ${isPushConfigured() ? 'configured' : 'not configured'}.`);
});

cron.schedule('* * * * *', () => {
  runReminderJobs().catch((error) => console.error('Reminder job failed', error));
}, { timezone: APP_TIMEZONE });

async function runReminderJobs(now = new Date()) {
  if (!isPushConfigured()) return;
  const settings = getSettings();
  const today = dateInZone(now);
  const time = timeInZone(now);

  if (settings.notificationsEnabled && time === settings.reminderTime && getSettingValue('lastDailyReminderDate') !== today) {
    await sendDailyReminder(today);
    setSettingValue('lastDailyReminderDate', today);
  }

  if (settings.weeklySummaryEnabled && isSundayInZone(now) && time === WEEKLY_SUMMARY_TIME && getSettingValue('lastWeeklySummaryDate') !== today) {
    await sendWeeklySummary(today, settings.currency);
    setSettingValue('lastWeeklySummaryDate', today);
  }
}

async function sendDailyReminder(today) {
  const entries = listExpenses().filter((entry) => entry.date === today);
  const hasLunch = entries.some((entry) => entry.mealType === 'lunch');
  const hasDinner = entries.some((entry) => entry.mealType === 'dinner');
  if (hasLunch && hasDinner) return { sent: 0, skipped: true };
  const missing = !hasLunch && !hasDinner ? 'lunch and dinner' : !hasLunch ? 'lunch' : 'dinner';
  return sendPushToAll({
    title: 'Meal Check In reminder',
    body: `Log ${missing} for today before you forget.`,
    tag: `daily-${today}`,
    url: '/'
  });
}

async function sendWeeklySummary(today, currency) {
  const { from, to } = weekRange(today);
  const rows = rangeExpenses(listExpenses(), from, to);
  const total = sum(rows);
  const days = new Set(rows.map((entry) => entry.date)).size;
  const streak = computeStreak(listExpenses(), today);
  return sendPushToAll({
    title: 'Weekly meal summary',
    body: `${formatCurrency(total, currency)} across ${days} day${days === 1 ? '' : 's'}. Current streak: ${streak} day${streak === 1 ? '' : 's'}.`,
    tag: `weekly-${today}`,
    url: '/'
  });
}

async function sendPushToAll(payload) {
  const subscriptions = db.prepare('SELECT endpoint, subscription_json FROM push_subscriptions WHERE enabled = 1').all();
  let sent = 0;
  let failed = 0;
  await Promise.all(subscriptions.map(async (row) => {
    try {
      await webpush.sendNotification(JSON.parse(row.subscription_json), JSON.stringify(payload));
      sent += 1;
    } catch (error) {
      failed += 1;
      const statusCode = Number(error?.statusCode || 0);
      const lastError = String(error?.body || error?.message || 'Push send failed.').slice(0, 500);
      if (statusCode === 404 || statusCode === 410) {
        db.prepare('UPDATE push_subscriptions SET enabled = 0, last_error = ?, updated_at = ? WHERE endpoint = ?').run(lastError, new Date().toISOString(), row.endpoint);
      } else {
        db.prepare('UPDATE push_subscriptions SET last_error = ?, updated_at = ? WHERE endpoint = ?').run(lastError, new Date().toISOString(), row.endpoint);
      }
    }
  }));
  return { sent, failed };
}

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return rows.reduce((acc, row) => {
    if (row.key in DEFAULT_SETTINGS) acc[row.key] = JSON.parse(row.value);
    return acc;
  }, { ...DEFAULT_SETTINGS });
}
function setSettings(settings) {
  const insert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  db.transaction(() => {
    Object.entries(settings).forEach(([key, value]) => insert.run(key, JSON.stringify(value)));
  })();
}
function getSettingValue(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return row.value; }
}
function setSettingValue(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}
function listExpenses() {
  return db.prepare('SELECT id, expense_date, meal_type, amount, note, tag, created_at, updated_at FROM expenses ORDER BY expense_date DESC, meal_type ASC').all().map(mapExpense);
}
function mapExpense(row) {
  return { id: row.id, date: row.expense_date, mealType: row.meal_type, amount: Number(row.amount), note: row.note || '', tag: row.tag || '', createdAt: row.created_at, updatedAt: row.updated_at };
}
function normalizeExpense(input) {
  const expense_date = String(input.date || '').trim();
  const meal_type = String(input.mealType || '').trim();
  const amount = Number(input.amount);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expense_date)) throw badRequest('Invalid date.');
  if (!['lunch', 'dinner'].includes(meal_type)) throw badRequest('Invalid meal type.');
  if (!Number.isFinite(amount) || amount <= 0) throw badRequest('Amount must be greater than zero.');
  return { id: input.id, expense_date, meal_type, amount: Math.round(amount * 100) / 100, note: String(input.note || '').trim().slice(0, 140), tag: String(input.tag || '').trim().slice(0, 32) };
}
function normalizeSubscription(input) {
  if (!input || typeof input !== 'object') throw badRequest('Missing push subscription.');
  if (!input.endpoint || !input.keys?.p256dh || !input.keys?.auth) throw badRequest('Invalid push subscription.');
  return input;
}
function getPushStatus() {
  const row = db.prepare('SELECT COUNT(*) AS total FROM push_subscriptions WHERE enabled = 1').get();
  return { configured: isPushConfigured(), subscriptions: Number(row?.total || 0), publicKey: VAPID_PUBLIC_KEY };
}
function isPushConfigured() { return Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY); }
function badRequest(message) { const error = new Error(message); error.status = 400; return error; }
function csvCell(value) { const str = String(value ?? ''); return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str; }
function todayISO() { return dateInZone(new Date()); }
function dateInZone(date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: APP_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  return `${part(parts, 'year')}-${part(parts, 'month')}-${part(parts, 'day')}`;
}
function timeInZone(date) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: APP_TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
  return `${part(parts, 'hour')}:${part(parts, 'minute')}`;
}
function isSundayInZone(date) { return new Intl.DateTimeFormat('en-US', { timeZone: APP_TIMEZONE, weekday: 'short' }).format(date) === 'Sun'; }
function part(parts, type) { return parts.find((item) => item.type === type)?.value || ''; }
function rangeExpenses(expenses, from, to) { return expenses.filter((entry) => entry.date >= from && entry.date <= to); }
function sum(items) { return items.reduce((total, item) => total + Number(item.amount || 0), 0); }
function weekRange(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  const from = d.toISOString().slice(0, 10);
  d.setUTCDate(d.getUTCDate() + 6);
  return { from, to: d.toISOString().slice(0, 10) };
}
function computeStreak(expenses, fromIso) {
  const dates = new Set(expenses.map((item) => item.date));
  let streak = 0;
  const cursor = new Date(`${fromIso}T00:00:00Z`);
  while (dates.has(cursor.toISOString().slice(0, 10))) {
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}
function formatCurrency(value, currency) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value || 0);
}
