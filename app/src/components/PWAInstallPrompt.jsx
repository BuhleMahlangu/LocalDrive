import React, { useEffect, useState } from 'react';

// Gently offers to install DriveLocal as an app (PWA). Shows only when the
// browser fires beforeinstallprompt AND we haven't dismissed it yet this week.
export default function PWAInstallPrompt() {
  const [deferred, setDeferred] = useState(null);

  useEffect(() => {
    const KEY = 'drivelocal_install_dismissed';
    if (localStorage.getItem(KEY)) return;

    const handler = (e) => {
      e.preventDefault();
      setDeferred(e);
    };
    window.addEventListener('beforeinstallprompt', handler);

    // Auto-hide prompt on iOS (no beforeinstallprompt) — nothing to do there.
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  if (!deferred) return null;

  async function install() {
    if (!deferred) return;
    deferred.prompt();
    const { outcome } = await deferred.userChoice;
    if (outcome === 'accepted') setDeferred(null);
    localStorage.setItem('drivelocal_install_dismissed', '1');
    setDeferred(null);
  }

  function dismiss() {
    // Don't nag for a while after the user dismisses.
    const d = new Date().toISOString().slice(0, 10);
    localStorage.setItem('drivelocal_install_dismissed', d);
    setDeferred(null);
  }

  return (
    <div className="install-prompt">
      <div className="brand-badge">DL</div>
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
