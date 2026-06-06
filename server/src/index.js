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
    expense_kind TEXT NOT NULL DEFAULT 'meal' CHECK(expense_kind IN ('meal','extra','monthly')),
    expense_date TEXT NOT NULL,
    meal_type TEXT DEFAULT '',
    amount REAL NOT NULL,
    title TEXT DEFAULT '',
    category TEXT DEFAULT '',
    recurring_id TEXT DEFAULT '',
    note TEXT DEFAULT '',
    tag TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
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

  CREATE TABLE IF NOT EXISTS recurring_expenses (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    amount REAL NOT NULL,
    note TEXT DEFAULT '',
    tag TEXT DEFAULT '',
    day_of_month INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS skipped_recurring_expenses (
    recurring_id TEXT NOT NULL,
    month TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (recurring_id, month)
  );
`);
ensureExpenseSchema();

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
    const now = new Date().toISOString();
    const existing = payload.expense_kind === 'meal'
      ? db.prepare('SELECT id, created_at FROM expenses WHERE expense_date = ? AND meal_type = ? AND expense_kind = ?').get(payload.expense_date, payload.meal_type, payload.expense_kind)
      : null;
    const expense = {
      id: existing?.id || payload.id || crypto.randomUUID(),
      expense_kind: payload.expense_kind,
      expense_date: payload.expense_date,
      meal_type: payload.meal_type,
      amount: payload.amount,
      title: payload.title,
      category: payload.category,
      recurring_id: payload.recurring_id,
      note: payload.note,
      tag: payload.tag,
      created_at: existing?.created_at || now,
      updated_at: now
    };
    db.prepare(`
      INSERT INTO expenses (id, expense_kind, expense_date, meal_type, amount, title, category, recurring_id, note, tag, created_at, updated_at)
      VALUES (@id, @expense_kind, @expense_date, @meal_type, @amount, @title, @category, @recurring_id, @note, @tag, @created_at, @updated_at)
      ON CONFLICT(expense_date, meal_type) WHERE expense_kind = 'meal' DO UPDATE SET
        amount = excluded.amount,
        title = excluded.title,
        category = excluded.category,
        recurring_id = excluded.recurring_id,
        note = excluded.note,
        tag = excluded.tag,
        updated_at = excluded.updated_at
    `).run(expense);
    res.json({ expense: mapExpense(expense) });
  } catch (error) { next(error); }
});

app.delete('/api/expenses/:date/:kind/:itemId?', (req, res, next) => {
  try {
    const { date, kind, itemId } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !['meal', 'extra', 'monthly'].includes(kind)) {
      return res.status(400).json({ error: 'Invalid expense target.' });
    }
    if (kind === 'meal') {
      const mealType = String(itemId || '').trim();
      if (!['lunch', 'dinner'].includes(mealType)) return res.status(400).json({ error: 'Invalid meal target.' });
      db.prepare('DELETE FROM expenses WHERE expense_date = ? AND meal_type = ? AND expense_kind = ?').run(date, mealType, 'meal');
    } else {
      if (!itemId) return res.status(400).json({ error: 'Missing extra expense id.' });
      db.prepare('DELETE FROM expenses WHERE expense_date = ? AND id = ? AND expense_kind = ?').run(date, itemId, kind);
    }
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

app.get('/api/monthly', (req, res, next) => {
  try {
    const month = normalizeMonth(req.query.month || todayISO().slice(0, 7));
    ensureRecurringInstances(month);
    res.json(buildMonthlyPayload(month));
  } catch (error) { next(error); }
});

app.put('/api/monthly/expenses', (req, res, next) => {
  try {
    const input = req.body || {};
    const recurring = Boolean(input.recurring);
    const month = normalizeMonth(input.month || String(input.date || todayISO()).slice(0, 7));
    const now = new Date().toISOString();

    if (recurring && !input.id) {
      const template = normalizeRecurringExpense(input);
      db.prepare(`
        INSERT INTO recurring_expenses (id, title, category, amount, note, tag, day_of_month, active, created_at, updated_at)
        VALUES (@id, @title, @category, @amount, @note, @tag, @day_of_month, 1, @created_at, @updated_at)
      `).run({ ...template, created_at: now, updated_at: now });
      ensureRecurringInstances(month);
      res.json(buildMonthlyPayload(month));
      return;
    }

    const payload = normalizeExpense({ ...input, kind: 'monthly', date: input.date || `${month}-01` });
    const existing = payload.id ? db.prepare('SELECT created_at FROM expenses WHERE id = ? AND expense_kind = ?').get(payload.id, 'monthly') : null;
    const expense = {
      id: payload.id || crypto.randomUUID(),
      expense_kind: 'monthly',
      expense_date: payload.expense_date,
      meal_type: '',
      amount: payload.amount,
      title: payload.title,
      category: payload.category,
      recurring_id: payload.recurring_id,
      note: payload.note,
      tag: payload.tag,
      created_at: existing?.created_at || now,
      updated_at: now
    };
    db.prepare(`
      INSERT INTO expenses (id, expense_kind, expense_date, meal_type, amount, title, category, recurring_id, note, tag, created_at, updated_at)
      VALUES (@id, @expense_kind, @expense_date, @meal_type, @amount, @title, @category, @recurring_id, @note, @tag, @created_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        expense_date = excluded.expense_date,
        amount = excluded.amount,
        title = excluded.title,
        category = excluded.category,
        note = excluded.note,
        tag = excluded.tag,
        updated_at = excluded.updated_at
    `).run(expense);
    res.json(buildMonthlyPayload(month));
  } catch (error) { next(error); }
});

app.delete('/api/monthly/expenses/:id', (req, res, next) => {
  try {
    const id = String(req.params.id || '').trim();
    const month = normalizeMonth(req.query.month || todayISO().slice(0, 7));
    const row = db.prepare('SELECT recurring_id FROM expenses WHERE id = ? AND expense_kind = ?').get(id, 'monthly');
    if (row?.recurring_id) {
      db.prepare('INSERT OR IGNORE INTO skipped_recurring_expenses (recurring_id, month, created_at) VALUES (?, ?, ?)').run(row.recurring_id, month, new Date().toISOString());
    }
    db.prepare('DELETE FROM expenses WHERE id = ? AND expense_kind = ?').run(id, 'monthly');
    res.json(buildMonthlyPayload(month));
  } catch (error) { next(error); }
});

app.put('/api/monthly/recurring/:id', (req, res, next) => {
  try {
    const id = String(req.params.id || '').trim();
    const month = normalizeMonth(req.body?.month || todayISO().slice(0, 7));
    const active = req.body?.active !== false ? 1 : 0;
    db.prepare('UPDATE recurring_expenses SET active = ?, updated_at = ? WHERE id = ?').run(active, new Date().toISOString(), id);
    res.json(buildMonthlyPayload(month));
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
      ['date', 'kind', 'meal_type', 'title', 'category', 'amount', 'note', 'tag', 'created_at', 'updated_at'],
      ...rows.map((row) => [row.date, row.kind, row.mealType, row.title || '', row.category || '', row.amount.toFixed(2), row.note || '', row.tag || '', row.createdAt, row.updatedAt])
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

function buildMonthlyPayload(month) {
  ensureRecurringInstances(month);
  const food = listExpenses().filter((entry) => entry.date.startsWith(month) && ['meal', 'extra'].includes(entry.kind));
  const monthly = db.prepare(`
    SELECT id, expense_kind, expense_date, meal_type, amount, title, category, recurring_id, note, tag, created_at, updated_at
    FROM expenses
    WHERE expense_kind = 'monthly' AND substr(expense_date, 1, 7) = ?
    ORDER BY expense_date DESC, category ASC, title ASC
  `).all(month).map(mapExpense);
  const recurring = db.prepare('SELECT id, title, category, amount, note, tag, day_of_month, active, created_at, updated_at FROM recurring_expenses ORDER BY active DESC, category ASC, title ASC').all().map(mapRecurringExpense);
  const all = [...food, ...monthly];
  const foodTotal = sum(food);
  const monthlyTotal = sum(monthly);
  const total = foodTotal + monthlyTotal;
  const previousMonth = shiftMonth(month, -1);
  const previousFood = listExpenses().filter((entry) => entry.date.startsWith(previousMonth) && ['meal', 'extra'].includes(entry.kind));
  const previousMonthly = db.prepare('SELECT amount FROM expenses WHERE expense_kind = ? AND substr(expense_date, 1, 7) = ?').all('monthly', previousMonth);
  const previousTotal = sum(previousFood) + sum(previousMonthly);
  return {
    month,
    food,
    monthly,
    recurring,
    totals: {
      total,
      food: foodTotal,
      nonFood: monthlyTotal,
      previousTotal,
      changePercent: previousTotal ? Math.round(((total - previousTotal) / previousTotal) * 100) : null,
      categories: categoryTotals(all)
    }
  };
}
function ensureRecurringInstances(month) {
  const templates = db.prepare('SELECT id, title, category, amount, note, tag, day_of_month FROM recurring_expenses WHERE active = 1').all();
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO expenses (id, expense_kind, expense_date, meal_type, amount, title, category, recurring_id, note, tag, created_at, updated_at)
    VALUES (@id, 'monthly', @expense_date, '', @amount, @title, @category, @recurring_id, @note, @tag, @created_at, @updated_at)
  `);
  db.transaction(() => {
    templates.forEach((template) => {
      const skipped = db.prepare('SELECT 1 FROM skipped_recurring_expenses WHERE recurring_id = ? AND month = ?').get(template.id, month);
      if (skipped) return;
      const existing = db.prepare('SELECT 1 FROM expenses WHERE recurring_id = ? AND substr(expense_date, 1, 7) = ?').get(template.id, month);
      if (existing) return;
      insert.run({
        id: crypto.randomUUID(),
        expense_date: `${month}-${String(Math.min(Number(template.day_of_month || 1), daysInMonth(month))).padStart(2, '0')}`,
        amount: Number(template.amount),
        title: template.title,
        category: template.category,
        recurring_id: template.id,
        note: template.note || '',
        tag: template.tag || '',
        created_at: now,
        updated_at: now
      });
    });
  })();
}
function normalizeRecurringExpense(input) {
  const amount = Number(input.amount);
  const title = String(input.title || '').trim().slice(0, 80);
  const category = String(input.category || '').trim().slice(0, 40);
  const dayOfMonth = Number(input.recurringDay || input.dayOfMonth || 1);
  if (!title) throw badRequest('Recurring expenses need a title.');
  if (!category) throw badRequest('Recurring expenses need a category.');
  if (!Number.isFinite(amount) || amount < 0) throw badRequest('Amount cannot be negative.');
  if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) throw badRequest('Recurring day must be between 1 and 31.');
  return {
    id: crypto.randomUUID(),
    title,
    category,
    amount: Math.round(amount * 100) / 100,
    note: String(input.note || '').trim().slice(0, 140),
    tag: String(input.tag || '').trim().slice(0, 32),
    day_of_month: dayOfMonth
  };
}
function mapRecurringExpense(row) {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    amount: Number(row.amount),
    note: row.note || '',
    tag: row.tag || '',
    dayOfMonth: Number(row.day_of_month || 1),
    active: Boolean(row.active),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
function categoryTotals(entries) {
  const totals = entries.reduce((acc, entry) => {
    const key = entry.kind === 'meal' || entry.kind === 'extra' ? 'Food' : entry.category || 'Other';
    acc[key] = (acc[key] || 0) + Number(entry.amount || 0);
    return acc;
  }, {});
  return Object.entries(totals).sort((a, b) => b[1] - a[1]).map(([category, total]) => ({ category, total }));
}

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return rows.reduce((acc, row) => {
    if (row.key in DEFAULT_SETTINGS) acc[row.key] = JSON.parse(row.value);
    return acc;
  }, { ...DEFAULT_SETTINGS });
}
function ensureExpenseSchema() {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'expenses'").get();
  if (table?.sql?.includes("meal_type IN ('lunch','dinner')")) {
    rebuildExpensesTable();
  }
  const columns = new Set(db.prepare('PRAGMA table_info(expenses)').all().map((row) => row.name));
  const alter = db.transaction(() => {
    if (!columns.has('expense_kind')) db.exec(`ALTER TABLE expenses ADD COLUMN expense_kind TEXT NOT NULL DEFAULT 'meal'`);
    if (!columns.has('title')) db.exec(`ALTER TABLE expenses ADD COLUMN title TEXT DEFAULT ''`);
    if (!columns.has('meal_type')) db.exec(`ALTER TABLE expenses ADD COLUMN meal_type TEXT DEFAULT ''`);
    if (!columns.has('category')) db.exec(`ALTER TABLE expenses ADD COLUMN category TEXT DEFAULT ''`);
    if (!columns.has('recurring_id')) db.exec(`ALTER TABLE expenses ADD COLUMN recurring_id TEXT DEFAULT ''`);
  });
  alter();
  db.exec(`DROP INDEX IF EXISTS ux_expenses_date_meal`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_expenses_date_meal ON expenses(expense_date, meal_type) WHERE expense_kind = 'meal'`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_expenses_kind_date ON expenses(expense_kind, expense_date)`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_expenses_recurring_month ON expenses(recurring_id, substr(expense_date, 1, 7)) WHERE recurring_id != ''`);
  db.exec(`UPDATE expenses SET expense_kind = 'meal' WHERE expense_kind IS NULL OR expense_kind = ''`);
}
function rebuildExpensesTable() {
  db.transaction(() => {
    db.exec(`ALTER TABLE expenses RENAME TO expenses_old`);
    db.exec(`
      CREATE TABLE expenses (
        id TEXT PRIMARY KEY,
        expense_kind TEXT NOT NULL DEFAULT 'meal' CHECK(expense_kind IN ('meal','extra','monthly')),
        expense_date TEXT NOT NULL,
        meal_type TEXT DEFAULT '',
        amount REAL NOT NULL,
        title TEXT DEFAULT '',
        category TEXT DEFAULT '',
        recurring_id TEXT DEFAULT '',
        note TEXT DEFAULT '',
        tag TEXT DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    db.exec(`
      INSERT INTO expenses (id, expense_kind, expense_date, meal_type, amount, title, category, recurring_id, note, tag, created_at, updated_at)
      SELECT id, 'meal', expense_date, meal_type, amount, '', '', '', note, tag, created_at, updated_at
      FROM expenses_old
    `);
    db.exec(`DROP TABLE expenses_old`);
  })();
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
  return db.prepare('SELECT id, expense_kind, expense_date, meal_type, amount, title, category, recurring_id, note, tag, created_at, updated_at FROM expenses ORDER BY expense_date DESC, expense_kind ASC, meal_type ASC, created_at DESC').all().map(mapExpense);
}
function mapExpense(row) {
  return {
    id: row.id,
    kind: row.expense_kind || 'meal',
    date: row.expense_date,
    mealType: row.meal_type || '',
    amount: Number(row.amount),
    title: row.title || '',
    category: row.category || '',
    recurringId: row.recurring_id || '',
    note: row.note || '',
    tag: row.tag || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
function normalizeExpense(input) {
  const expense_date = String(input.date || '').trim();
  const expense_kind = String(input.kind || 'meal').trim();
  const meal_type = String(input.mealType || '').trim();
  const amount = Number(input.amount);
  const title = String(input.title || '').trim().slice(0, 80);
  const category = String(input.category || '').trim().slice(0, 40);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expense_date)) throw badRequest('Invalid date.');
  if (!['meal', 'extra', 'monthly'].includes(expense_kind)) throw badRequest('Invalid expense kind.');
  if (expense_kind === 'meal' && !['lunch', 'dinner'].includes(meal_type)) throw badRequest('Invalid meal type.');
  if (['extra', 'monthly'].includes(expense_kind) && !title) throw badRequest('Expense needs a title.');
  if (expense_kind === 'monthly' && !category) throw badRequest('Monthly expenses need a category.');
  if (!Number.isFinite(amount) || amount < 0) throw badRequest('Amount cannot be negative.');
  return {
    id: input.id,
    expense_kind,
    expense_date,
    meal_type: expense_kind === 'meal' ? meal_type : '',
    amount: Math.round(amount * 100) / 100,
    title,
    category,
    recurring_id: String(input.recurringId || '').trim(),
    note: String(input.note || '').trim().slice(0, 140),
    tag: String(input.tag || '').trim().slice(0, 32)
  };
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
function normalizeMonth(value) {
  const month = String(value || '').trim();
  if (!/^\d{4}-\d{2}$/.test(month)) throw badRequest('Invalid month.');
  return month;
}
function shiftMonth(month, offset) {
  const [year, monthNumber] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1 + offset, 1));
  return date.toISOString().slice(0, 7);
}
function daysInMonth(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
}
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
