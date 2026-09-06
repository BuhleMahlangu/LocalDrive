import React, { useEffect, useState } from 'react';
import { api, formatRand, toTel, toWhatsApp } from '../../api.js';
import NotificationsToggle from '../../components/NotificationsToggle.jsx';

export default function Home({ user, onBook, onResume }) {
  const [driver, setDriver] = useState(null);
  const [recentTrip, setRecentTrip] = useState(null);
  const [active, setActive] = useState(false);
  const [loading, setLoading] = useState(true);

  const supportPhone = driver?.phone || import.meta.env.VITE_DRIVER_PHONE || '+27000000000';

  useEffect(() => {
    api('/customer/driver').then(setDriver).catch(() => setDriver(null));
    api('/customer/trips').then((trips) => {
      const completed = (trips || []).find((t) => t.status === 'completed');
      setRecentTrip(completed || null);
    }).catch(() => {});
    api('/customer/trips/active').then((r) => setActive(!!r.trip)).catch(() => {});
    setLoading(false);
  }, []);

  return (
    <div className="screen">
      <h1>Hello{user.name ? `, ${user.name.split(' ')[0]}` : ''}</h1>
      <p className="subtitle">Where are we headed?</p>

      <button className="btn primary big" onClick={onBook}>🚕 Book a ride</button>

      {active && (
        <div className="card active-card">
          <h3>You have an ongoing trip</h3>
          <button className="btn primary" onClick={onResume}>Open trip</button>
        </div>
      )}

      {driver ? (
        <div className="card driver-card">
          <div className="driver-row">
            <div className="avatar">{driver.photoUrl ? <img src={driver.photoUrl} alt="" /> : (driver.name || 'D')[0]}</div>
            <div>
              <h3>{driver.name || 'Your driver'}</h3>
              <p>{driver.vehicleType || 'Vehicle'}{driver.licensePlate ? ` · ${driver.licensePlate}` : ''}</p>
              {driver.rating != null && <p className="stars">★ {driver.rating.toFixed(1)} ({driver.ratingCount})</p>}
            </div>
          </div>
          <p className="rate-line">
            Base {formatRand(driver.baseFare)} · {formatRand(driver.perKmRate)}/km
          </p>
          {driver.phone && (
            <div className="btn-row" style={{ marginTop: '10px' }}>
              <a className="btn small" href={toTel(driver.phone)}>📞 Call driver</a>
              <a className="btn small" href={toWhatsApp(driver.phone, 'Hi, I need help with my DriveLocal booking.')} target="_blank" rel="noreferrer">💬 WhatsApp</a>
            </div>
          )}
        </div>
      ) : (
        <div className="card"><p className="hint">{loading ? 'Loading driver info…' : 'Driver not found'}</p></div>
      )}

      {recentTrip && (
        <div className="card">
          <h3>Last ride</h3>
          <p>{recentTrip.pickup.address} → {recentTrip.destination.address}</p>
          <p className="subtitle">{formatRand(recentTrip.finalFare ?? recentTrip.fareEstimate)}</p>
          <button className="link-btn" onClick={onBook}>Book again</button>
        </div>
      )}

      <a className="card support-card" href={toWhatsApp(supportPhone, 'Hi DriveLocal, I need help with a ride')} target="_blank" rel="noreferrer">
        <span>🛟 Need help? Call or WhatsApp your driver</span>
        <span className="chevron">›</span>
      </a>

      <div className="card">
        <NotificationsToggle />
      </div>
    </div>
  );
}
