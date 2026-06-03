import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import cors from 'cors';
import express from 'express';
import morgan from 'morgan';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');
const PORT = Number(process.env.PORT || 8080);
const DB_PATH = path.resolve(ROOT_DIR, process.env.DB_PATH || './data/meal-check-in.db');
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || '';
const APP_TOKEN = process.env.APP_TOKEN || '';

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
`);

const DEFAULT_SETTINGS = {
  currency: 'INR',
  reminderTime: '13:00',
  notificationsEnabled: false,
  weeklySummaryEnabled: true,
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

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/bootstrap', (_req, res, next) => {
  try {
    res.json({ settings: getSettings(), expenses: listExpenses(), generatedAt: new Date().toISOString() });
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
    const settings = {
      currency: ['INR', 'USD', 'EUR', 'GBP'].includes(input.currency) ? input.currency : current.currency,
      reminderTime: /^\d{2}:\d{2}$/.test(String(input.reminderTime || '')) ? input.reminderTime : current.reminderTime,
      notificationsEnabled: Boolean(input.notificationsEnabled),
      weeklySummaryEnabled: Boolean(input.weeklySummaryEnabled),
      theme: ['system', 'light', 'dark'].includes(input.theme) ? input.theme : current.theme
    };
    const insert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    const tx = db.transaction(() => {
      Object.entries(settings).forEach(([key, value]) => insert.run(key, JSON.stringify(value)));
    });
    tx();
    res.json({ settings: getSettings() });
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
});

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return rows.reduce((acc, row) => {
    acc[row.key] = JSON.parse(row.value);
    return acc;
  }, { ...DEFAULT_SETTINGS });
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
function badRequest(message) { const error = new Error(message); error.status = 400; return error; }
function csvCell(value) { const str = String(value ?? ''); return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str; }
function todayISO() { return new Date().toISOString().slice(0, 10); }
