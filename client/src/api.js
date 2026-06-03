const BUILD_API_BASE = import.meta.env.VITE_API_BASE || '';
const API_BASE_KEY = 'meal-checkin-api-base';
const TOKEN_KEY = 'meal-checkin-app-token';

export function readToken() {
  try { return window.localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

export function writeToken(value) {
  try {
    if (value) window.localStorage.setItem(TOKEN_KEY, value);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

export function readApiBase() {
  try { return window.localStorage.getItem(API_BASE_KEY) || BUILD_API_BASE || ''; } catch { return BUILD_API_BASE; }
}

export function writeApiBase(value) {
  try {
    const clean = normalizeApiBase(value);
    if (clean) window.localStorage.setItem(API_BASE_KEY, clean);
    else window.localStorage.removeItem(API_BASE_KEY);
    return clean;
  } catch {
    return BUILD_API_BASE;
  }
}

export function normalizeApiBase(value) {
  const clean = String(value || '').trim().replace(/\/+$/, '');
  if (!clean) return '';
  if (!/^https?:\/\//i.test(clean)) return `https://${clean}`;
  return clean;
}

async function request(path, options = {}) {
  const token = readToken();
  const headers = new Headers(options.headers || {});
  if (!headers.has('Content-Type') && options.body) headers.set('Content-Type', 'application/json');
  if (token) headers.set('x-app-token', token);

  const apiBase = readApiBase();
  const response = await fetch(`${apiBase}${path}`, { ...options, headers });
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) {
    let message = 'Request failed.';
    if (contentType.includes('application/json')) {
      const payload = await response.json().catch(() => ({}));
      if (payload.error) message = payload.error;
    }
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  if (!contentType.includes('application/json')) {
    throw new Error('The backend API did not return JSON. Check the saved backend URL.');
  }
  return response.json();
}


export const api = {
  getApiBase: readApiBase,
  setApiBase: writeApiBase,
  getToken: readToken,
  setToken: writeToken,
  bootstrap: () => request('/api/bootstrap'),
  upsertExpense: (payload) => request('/api/expenses', { method: 'PUT', body: JSON.stringify(payload) }),
  deleteExpense: (date, kind, itemId) => request(`/api/expenses/${date}/${kind}/${itemId || ''}`, { method: 'DELETE' }),
  updateSettings: (payload) => request('/api/settings', { method: 'PUT', body: JSON.stringify(payload) }),
  getPushPublicKey: () => request('/api/push/public-key'),
  subscribePush: (subscription) => request('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription }) }),
  unsubscribePush: (endpoint) => request('/api/push/subscribe', { method: 'DELETE', body: JSON.stringify({ endpoint }) }),
  testPush: () => request('/api/push/test', { method: 'POST' }),
  exportCsv: async () => {
    const token = readToken();
    const apiBase = readApiBase();
    const response = await fetch(`${apiBase}/api/export.csv`, { headers: token ? { 'x-app-token': token } : {} });
    if (!response.ok) throw new Error('CSV export failed.');
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `meal-check-in-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }
};
