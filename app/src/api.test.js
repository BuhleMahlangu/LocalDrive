import { describe, it, expect, beforeEach } from 'vitest';
import {
  formatRand,
  isDriverUser,
  toTel,
  toWhatsApp,
  currentTheme,
  setTheme,
  applyTheme,
  getStoredUser,
  setSession,
  DRIVER_PHONE,
} from './api.js';

describe('formatRand', () => {
  it('formats ZAR amounts with two decimals', () => {
    expect(formatRand(12.5)).toBe('R12.50');
    expect(formatRand(0)).toBe('R0.00');
    expect(formatRand(1234.567)).toBe('R1234.57');
    expect(formatRand(null)).toBe('R0.00');
  });
});

describe('isDriverUser', () => {
  it('recognises a driver-role user', () => {
    expect(isDriverUser({ role: 'driver', phone: '+27000000000' })).toBe(true);
  });
  it('recognises the owner phone regardless of role', () => {
    expect(isDriverUser({ role: 'customer', phone: DRIVER_PHONE })).toBe(true);
  });
  it('rejects customers and unknowns', () => {
    expect(isDriverUser({ role: 'customer', phone: '+27730009999' })).toBe(false);
    expect(isDriverUser(null)).toBe(false);
    expect(isDriverUser(undefined)).toBe(false);
  });
});

describe('phone / whatsapp helpers', () => {
  it('toTel keeps only digits and leading plus', () => {
    expect(toTel('+27 00 000 0000')).toBe('tel:+27000000000');
    expect(toTel('0000000000')).toBe('tel:0000000000');
  });
  it('toWhatsApp builds a wa.me link and encodes the message', () => {
    expect(toWhatsApp('+27000000000', 'Hello')).toBe('https://wa.me/27000000000?text=Hello');
    expect(toWhatsApp('+27000000000', 'hi there')).toBe('https://wa.me/27000000000?text=hi%20there');
  });
});

describe('theme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('defaults to light', () => {
    expect(currentTheme()).toBe('light');
  });

  it('setTheme persists and sets the data attribute', () => {
    setTheme('dark');
    expect(currentTheme()).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('applyTheme restores the saved theme', () => {
    setTheme('dark');
    document.documentElement.setAttribute('data-theme', 'light');
    applyTheme();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});

describe('session storage', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips a user through localStorage', () => {
    const user = { id: 'u1', phone: '+27730009999', role: 'customer' };
    setSession('tok-123', user);
    expect(getStoredUser()).toEqual(user);
  });

  it('tolerates corrupted JSON', () => {
    localStorage.setItem('drivelocal_user', '{not json');
    expect(getStoredUser()).toBe(null);
  });
});