import React, { useState } from 'react';
import { currentTheme, setTheme } from '../api.js';

export default function ThemeToggle() {
  const [dark, setDark] = useState(() => currentTheme() === 'dark');

  function toggle() {
    const next = !dark;
    setDark(next);
    setTheme(next ? 'dark' : 'light');
  }

  return (
    <button type="button" className="theme-toggle" onClick={toggle} title={dark ? 'Switch to light mode' : 'Switch to dark mode'}>
      {dark ? '☀️ Light' : '🌙 Dark'}
    </button>
  );
}
