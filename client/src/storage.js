const CACHE_KEY = 'meal-checkin-last-sync';
export function saveBootstrapCache(payload) { try { window.localStorage.setItem(CACHE_KEY, JSON.stringify(payload)); } catch {} }
export function loadBootstrapCache() { try { const raw = window.localStorage.getItem(CACHE_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; } }
