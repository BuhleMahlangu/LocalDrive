import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function Landing({ onChoose }) {
  const [online, setOnline] = useState(null); // null = unknown
  const [driver, setDriver] = useState(null);

  useEffect(() => {
    api('/customer/driver/availability').then((r) => setOnline(!!r.isOnline)).catch(() => setOnline(null));
    api('/customer/driver').then(setDriver).catch(() => setDriver(null));
  }, []);

  return (
    <div className="login-screen landing-screen">
      <div className="brand-hero">
        <div className="brand-badge">DL</div>
        <h1>DriveLocal</h1>
        <p>Thubelihle & Kriel's friendly local ride — book in seconds.</p>
      </div>

      <div className="card landing-card">
        {online != null && (
          <div className={`online-strip ${online ? 'up' : ''}`}>
            {online
              ? `🟢 ${driver?.name || 'Your driver'} is online right now`
              : '🛑 Driver is offline — you can still schedule a ride ahead'}
          </div>
        )}

        <button type="button" className="btn primary big" onClick={() => onChoose('customer')}>
          🚕 Book a ride
        </button>
        <p className="hint">Live GPS tracking · cash or card · no street names needed.</p>

        <div className="landing-divider">or</div>

        <button type="button" className="btn driver big" onClick={() => onChoose('driver')}>
          🚗 I'm the driver
        </button>
        <p className="hint">Driver login — accept requests and manage trips.</p>
      </div>
    </div>
  );
}