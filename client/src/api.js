const API_BASE = import.meta.env.VITE_API_BASE || '';
const TOKEN_KEY = 'meal-checkin-app-token';
export function readToken() { try { return window.localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }
export function writeToken(value) { try { if (value) window.localStorage.setItem(TOKEN_KEY, value); else window.localStorage.removeItem(TOKEN_KEY); } catch {} }
async function request(path, options = {}) {
  const token = readToken();
  const headers = new Headers(options.headers || {});
  if (!headers.has('Content-Type') && options.body) headers.set('Content-Type', 'application/json');
  if (token) headers.set('x-app-token', token);
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
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
  return contentType.includes('application/json') ? response.json() : response;
}
export const api = {
  getToken: readToken,
  setToken: writeToken,
  bootstrap: () => request('/api/bootstrap'),
  upsertExpense: (payload) => request('/api/expenses', { method: 'PUT', body: JSON.stringify(payload) }),
  deleteExpense: (date, mealType) => request(`/api/expenses/${date}/${mealType}`, { method: 'DELETE' }),
  updateSettings: (payload) => request('/api/settings', { method: 'PUT', body: JSON.stringify(payload) }),
  exportCsv: async () => {
    const token = readToken();
    const response = await fetch(`${API_BASE}/api/export.csv`, { headers: token ? { 'x-app-token': token } : {} });
    if (!response.ok) throw new Error('CSV export failed.');
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `meal-check-in-${new Date().toISOString().slice(0,10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }
};
