import React, { useEffect, useState } from 'react';
import { registerPush, unregisterPush, pushSupported } from '../push.js';

export default function NotificationsToggle() {
  const [supported] = useState(() => pushSupported());
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!supported) return;
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setEnabled(!!sub))
      .catch(() => {});
  }, [supported]);

  if (!supported) {
    return <div className="notice muted">Push notifications aren’t supported in this browser.</div>;
  }

  async function toggle() {
    setBusy(true);
    if (enabled) {
      await unregisterPush();
      setEnabled(false);
    } else {
      const res = await registerPush(true);
      if (res.ok) setEnabled(true);
      else if (res.reason === 'denied') alert('Notifications are blocked in your browser. Enable them in site settings.');
      else if (res.reason === 'vapid-not-configured') alert('Push isn’t configured on the server yet.');
    }
    setBusy(false);
  }

  return (
    <label className="switch-row">
      <span>Push notifications {enabled ? 'on' : 'off'}</span>
      <button type="button" className="switch" role="switch" aria-checked={enabled} disabled={busy} onClick={toggle}>
        <span className="knob" />
      </button>
    </label>
  );
}
