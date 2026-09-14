import { io } from 'socket.io-client';

const TOKEN_KEY = 'drivelocal_token';
const USER_KEY = 'drivelocal_user';
// The API base. In development the backend is served by the Vite proxy at the
// same origin (/api …). In production set VITE_API_BASE to the backend origin
// (e.g. https://api.drivelocal.example) or keep it empty to serve the SPA and
// API from one host behind a reverse proxy.
const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');
// The platform owner's phone. Their account is the admin (who also drives).
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
  return !!user && (user.role === 'driver' || user.role === 'admin' || user.phone === DRIVER_PHONE);
}

// The user may drive NOW: admin owner or an approved (vetted) driver.
export function isApprovedDriver(user) {
  return !!user && (user.role === 'admin' || (user.role === 'driver' && user.driverStatus === 'approved'));
}

// The platform owner (can review/approve driver applications).
export function isAdminUser(user) {
  return !!user && user.role === 'admin';
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

// Send a multipart/form-data request (file uploads). Blobs/FormData set their
// own Content-Type (with the boundary), so we must not set it manually.
export async function apiUpload(path, formData) {
  const headers = {};
  const t = getToken();
  if (t) headers.Authorization = `Bearer ${t}`;
  const res = await fetch(`${API_BASE}/api${path}`, {
    method: 'POST',
    headers,
    body: formData,
  });
  let json = {};
  try {
    json = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok && !json.success) {
    const err = new Error(json.error || `Upload failed (${res.status})`);
    err.status = res.status;
    err.code = json.code;
    throw err;
  }
  return json;
}

export function connectSocket() {
  return io(API_BASE || undefined, { auth: { token: getToken() } });
}

// Download a protected file (e.g. an uploaded driver document) using the auth
// token. Anchors can't attach the Authorization header, so we fetch the blob
// ourselves and save it with the file's original name.
export async function apiDownload(url, { filename } = {}) {
  const headers = {};
  const t = getToken();
  if (t) headers.Authorization = `Bearer ${t}`;
  const res = await fetch(`${API_BASE}${url}`, { headers });
  if (!res.ok) {
    const err = new Error(`Download failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename || String(url).split('/').pop() || 'document';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);
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

// Validate a South African ID number (13 digits, plausible birthdate, Luhn
// checksum) — mirrors backend/src/services/saidNumber.js.
export function validateSaId(value) {
  const id = String(value || '').trim();
  if (!/^\d{13}$/.test(id)) return false;
  const y = Number(id.slice(0, 2));
  const m = Number(id.slice(2, 4));
  const d = Number(id.slice(4, 6));
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const year = y <= new Date().getFullYear() % 100 ? 2000 + y : 1900 + y;
  const date = new Date(Date.UTC(year, m - 1, d));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    let n = Number(id[i]) * (i % 2 === 1 ? 2 : 1);
    if (n > 9) n -= 9;
    sum += n;
  }
  return (10 - (sum % 10)) % 10 === Number(id[12]);
}
