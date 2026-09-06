import { io } from 'socket.io-client';

const TOKEN_KEY = 'drivelocal_token';
const USER_KEY = 'drivelocal_user';
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
  const res = await fetch(`/api${path}`, {
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
  return io({ auth: { token: getToken() } });
}

// Format a South African phone for tel:/wa.me links.
export function toTel(phone) {
  return `tel:${(phone || '').replace(/[^\d+]/g, '')}`;
}

export function toWhatsApp(phone, text) {
  const num = String(phone || '').replace(/[^\d]/g, '');
  const msg = text ? encodeURIComponent(text) : '';
  return `https://wa.me/${num}${msg ? `?text=${msg}` : ''}`;
}

export function formatRand(n) {
  return `R${Number(n || 0).toFixed(2)}`;
}
