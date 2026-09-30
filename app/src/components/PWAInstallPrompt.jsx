import React, { useEffect, useState } from 'react';

const KEY = 'drivelocal_install_dismissed';
const NAG_DAYS = 7;

function recentlyDismissed() {
  const raw = localStorage.getItem(KEY);
  if (!raw) return false;
  // Legacy/boolean value: treated as a permanent opt-out, since a stored
  // '1' carries no date to age out.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return true;
  const then = Date.parse(`${raw}T00:00:00`);
  if (Number.isNaN(then)) return false;
  return Date.now() - then < NAG_DAYS * 24 * 60 * 60 * 1000;
}

// Gently offers to install DriveLocal as an app (PWA). Shows only when the
// browser fires beforeinstallprompt AND the user has not dismissed it in the
// last week.
export default function PWAInstallPrompt() {
  const [deferred, setDeferred] = useState(null);

  useEffect(() => {
    if (recentlyDismissed()) return undefined;

    const handler = (e) => {
      e.preventDefault();
      setDeferred(e);
    };
    window.addEventListener('beforeinstallprompt', handler);

    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  if (!deferred) return null;

  async function install() {
    if (!deferred) return;
    deferred.prompt();
    const { outcome } = await deferred.userChoice;
    // Accepted means the app is installed — never prompt again. Declining is a
    // softer signal, so it ages out after a week like a dismissal.
    if (outcome === 'accepted') localStorage.setItem(KEY, '1');
    else dismiss();
    setDeferred(null);
  }

  function dismiss() {
    localStorage.setItem(KEY, new Date().toISOString().slice(0, 10));
    setDeferred(null);
  }

  return (
    <div className="install-prompt">
      <div className="brand-badge"><img src="/pwa-192.png" alt="DriveLocal logo" /></div>
      <div className="install-body">
        <b>Install DriveLocal</b>
        Quick access, works offline, like a real app.
      </div>
      <div className="install-btns">
        <button className="btn small" onClick={install}>Install</button>
        <button className="btn small" onClick={dismiss} style={{ background: 'transparent' }}>✕</button>
      </div>
    </div>
  );
}
