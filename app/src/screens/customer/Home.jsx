import React, { useEffect, useState } from 'react';
import { api, formatRand, toTel, toWhatsApp } from '../../api.js';
import NotificationsToggle from '../../components/NotificationsToggle.jsx';
import SavedPlacesBar from '../../components/SavedPlaces.jsx';
import Icon from '../../components/Icon.jsx';

export default function Home({ user, onBook, onResume, onRebook, onPickPlace }) {
  const [driver, setDriver] = useState(null);
  const [recentTrip, setRecentTrip] = useState(null);
  const [upcoming, setUpcoming] = useState([]);
  const [active, setActive] = useState(false);
  const [loading, setLoading] = useState(true);

  const supportPhone = driver?.phone || import.meta.env.VITE_DRIVER_PHONE || '+27000000000';

  function loadUpcoming() {
    api('/customer/trips/upcoming').then((r) => setUpcoming(r.trips || [])).catch(() => {});
  }

  useEffect(() => {
    api('/customer/driver').then(setDriver).catch(() => setDriver(null));
    api('/customer/trips').then((trips) => {
      const completed = (trips || []).find((t) => t.status === 'completed');
      setRecentTrip(completed || null);
    }).catch(() => {});
    api('/customer/trips/active').then((r) => setActive(!!r.trip)).catch(() => {});
    loadUpcoming();
    setLoading(false);
  }, []);

  async function cancelScheduled(t) {
    if (t && !window.confirm('Cancel this scheduled ride?')) return;
    try {
      await api(`/customer/trips/${t.id}/cancel`, { method: 'POST', body: { reason: 'Customer cancelled scheduled ride' } });
      loadUpcoming();
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="screen">
      <div className="card book-hero">
        <h1>Hello{user.name ? `, ${user.name.split(' ')[0]}` : ''} 👋</h1>
        <p className="subtitle">Where are we headed today?</p>
        <button className="btn primary big" onClick={onBook}>
          <Icon name="book" size={21} /> Book a ride
        </button>
        <p className="hint" style={{ margin: '10px 0 0' }}>Live GPS · cash or card · no street names needed</p>
      </div>

      {active && (
        <div className="card active-card">
          <h3>You have an ongoing trip</h3>
          <button className="btn primary" onClick={onResume}>Open trip</button>
        </div>
      )}

      {upcoming.length > 0 && (
        <div className="card upcoming-card">
          <h3>🗓️ Upcoming scheduled ride</h3>
          {upcoming.map((t) => (
            <div key={t.id}>
              <span className="upcoming-time">🕐 {formatScheduled(t.scheduledAt)}</span>
              <p className="hint" style={{ margin: '4px 0' }}>
                {t.pickup?.address || 'Pickup'} → {t.destination?.address || 'Destination'}
              </p>
              <div className="btn-row">
                <button className="btn small" onClick={() => onRebook(t)}>View details</button>
                <button className="btn small" onClick={() => cancelScheduled(t)}>Cancel ride</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h3>Saved places</h3>
        <SavedPlacesBar onPick={onPickPlace} />
        {!loading && !recentTrip && (
          <p className="hint" style={{ margin: '8px 0 0' }}>Tap “Book a ride” to add your home, work and regular spots.</p>
        )}
      </div>

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
          <p className="hint">Are we online right now? Check via booking.</p>
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
          <button className="link-btn" onClick={() => onRebook(recentTrip)}>Book again</button>
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

function formatScheduled(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
