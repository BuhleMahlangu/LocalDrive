import React, { useEffect, useId, useState } from 'react';
import { registerPush, unregisterPush, pushSupported } from '../push.js';

export default function NotificationsToggle() {
  const [supported] = useState(() => pushSupported());
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const labelId = useId();

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
    <div className="switch-row">
      <span id={labelId}>Push notifications {enabled ? 'on' : 'off'}</span>
      {/* A <label> cannot target a <button>, so associate via aria-labelledby.
          The span carries the state wording the button's own label would miss. */}
      <button
        type="button"
        className="switch"
        role="switch"
        aria-checked={enabled}
        aria-labelledby={labelId}
        disabled={busy}
        onClick={toggle}
      >
        <span className="knob" />
      </button>
    </div>
  );
}
