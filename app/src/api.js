import { io } from 'socket.io-client';

const TOKEN_KEY = 'drivelocal_token';
const USER_KEY = 'drivelocal_user';
// The API base. In development the backend is served by the Vite proxy at the
// same origin (/api …). In production set VITE_API_BASE to the backend origin
// (e.g. https://api.drivelocal.example) or keep it empty to serve the SPA and
// API from one host behind a reverse proxy.
const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');
// The driver's phone (the owner). If the logged-in user's phone matches,
// we show the driver dashboard instead of the customer app.
export const DRIVER_PHONE = import.meta.env.VITE_DRIVER_PHONE || '+27000000000';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function getStoredUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
  } catch {
    return null;
  }
}

export function isDriverUser(user) {
  return !!user && (user.role === 'driver' || user.phone === DRIVER_PHONE);
}

export function setSession(token, user) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export async function api(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const t = token ?? getToken();
  if (t) headers.Authorization = `Bearer ${t}`;
  const res = await fetch(`${API_BASE}/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = {};
  try {
    json = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok && !json.success) {
    const err = new Error(json.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = json.code;
    throw err;
  }
  return json;
}

export function connectSocket() {
  return io(API_BASE || undefined, { auth: { token: getToken() } });
}

// Format a South African phone for tel:/wa.me links.
export function toTel(phone) {
  return `tel:${(phone || '').replace(/[^\d+]/g, '')}`;
}

const THEME_KEY = 'drivelocal_theme';

export function currentTheme() {
  return localStorage.getItem(THEME_KEY) || 'light';
}

// Apply the saved theme to <html> (called at startup and on toggle).
export function applyTheme() {
  const t = localStorage.getItem(THEME_KEY);
  applyThemeValue(t === 'dark' ? 'dark' : 'light');
}

function applyThemeValue(v) {
  document.documentElement.setAttribute('data-theme', v);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', v === 'dark' ? '#0f1420' : '#1a1a2e');
  localStorage.setItem(THEME_KEY, v);
}

export function setTheme(v) {
  applyThemeValue(v === 'dark' ? 'dark' : 'light');
}

export function toWhatsApp(phone, text) {
  const num = String(phone || '').replace(/[^\d]/g, '');
  const msg = text ? encodeURIComponent(text) : '';
  return `https://wa.me/${num}${msg ? `?text=${msg}` : ''}`;
}

export function formatRand(n) {
  return `R${Number(n || 0).toFixed(2)}`;
}
