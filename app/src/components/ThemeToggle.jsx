import React, { useState } from 'react';
import { currentTheme, setTheme } from '../api.js';
import Icon from './Icon.jsx';

export default function ThemeToggle() {
  const [dark, setDark] = useState(() => currentTheme() === 'dark');

  function toggle() {
    const next = !dark;
    setDark(next);
    setTheme(next ? 'dark' : 'light');
  }

  return (
    <button type="button" className="theme-toggle" onClick={toggle} title={dark ? 'Switch to light mode' : 'Switch to dark mode'}>
      <Icon name={dark ? 'sun' : 'moon'} size={15} />
      {dark ? 'Light' : 'Dark'}
    </button>
  );
}
