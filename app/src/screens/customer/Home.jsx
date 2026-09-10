import React, { useEffect, useState } from 'react';
import { api, formatRand, toTel, toWhatsApp } from '../../api.js';
import NotificationsToggle from '../../components/NotificationsToggle.jsx';
import SavedPlacesBar from '../../components/SavedPlaces.jsx';
import Skeleton from '../../components/Skeleton.jsx';
import Icon from '../../components/Icon.jsx';
import { useI18n } from '../../i18n.jsx';

export default function Home({ user, onBook, onResume, onRebook, onPickPlace, refreshKey = 0 }) {
  const { t } = useI18n();
  const [driver, setDriver] = useState(null);
  const [recentTrip, setRecentTrip] = useState(null);
  const [upcoming, setUpcoming] = useState([]);
  const [active, setActive] = useState(null);
  const [loading, setLoading] = useState(true);
  const [driverLoading, setDriverLoading] = useState(true);
  const [recentLoading, setRecentLoading] = useState(true);

  const supportPhone = driver?.phone || import.meta.env.VITE_DRIVER_PHONE || '+27000000000';

  function loadUpcoming() {
    api('/customer/trips/upcoming').then((r) => setUpcoming(r.trips || [])).catch(() => {});
  }

  useEffect(() => {
    api('/customer/driver').then(setDriver).catch(() => setDriver(null)).finally(() => setDriverLoading(false));
    api('/customer/trips').then((trips) => {
      const completed = (trips || []).find((t) => t.status === 'completed');
      setRecentTrip(completed || null);
    }).catch(() => {}).finally(() => setRecentLoading(false));
    api('/customer/trips/active').then((r) => setActive(r.trip || null)).catch(() => {});
    loadUpcoming();
    setLoading(false);
  }, [refreshKey]);

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
          <Icon name="book" size={21} /> {t('home.book')}
        </button>
        <p className="hint" style={{ margin: '10px 0 0' }}>Live GPS · cash or card · no street names needed</p>
      </div>

      {active && (
        <div className="card active-card">
          <h3>You have an ongoing trip</h3>
          <button className="btn primary" onClick={() => onResume(active)}>Open trip</button>
        </div>
      )}

      {upcoming.length > 0 && (
        <div className="card upcoming-card">
          <h3>🗓️ Upcoming scheduled ride</h3>
          {upcoming.map((t) => (
            <div key={t.id}>
              <span className="upcoming-time">🕐 {formatScheduled(t.scheduledAt)}</span>
              <p className="hint" style={{ margin: '4px 0' }}>
                {t.pickup?.address || t('book.pickupLabel').split(' — ')[0]} → {t.destination?.address || 'Destination'}
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
        <h3>{t('home.savedPlaces')}</h3>
        {loading ? (
          <Skeleton lines={1} style={{ marginTop: 8 }} />
        ) : (
          <SavedPlacesBar onPick={onPickPlace} />
        )}
        {!loading && !recentTrip && (
          <p className="hint" style={{ margin: '8px 0 0' }}>{t('home.tapToBook')}</p>
        )}
      </div>

      {driverLoading ? (
        <Skeleton card avatar lines={3} />
      ) : driver ? (
        <div className="card driver-card">
          <div className="driver-row">
            <div className="avatar">{driver.photoUrl ? <img src={driver.photoUrl} alt="" /> : (driver.name || 'D')[0]}</div>
            <div>
              <h3>{driver.name || t('home.yourDriver')}</h3>
              <p>{driver.vehicleType || 'Vehicle'}{driver.licensePlate ? ` · ${driver.licensePlate}` : ''}</p>
              {driver.rating != null && <p className="stars">★ {driver.rating.toFixed(1)} ({driver.ratingCount})</p>}
            </div>
          </div>
          <p className="rate-line">
            {t('home.base')} {formatRand(driver.baseFare)} · {formatRand(driver.perKmRate)}/km
          </p>
          <p className="hint">{t('home.onlineCheck')}</p>
          {driver.phone && (
            <div className="btn-row" style={{ marginTop: '10px' }}>
              <a className="btn small" href={toTel(driver.phone)}>{t('home.callDriver')}</a>
              <a className="btn small" href={toWhatsApp(driver.phone, 'Hi, I need help with my DriveLocal booking.')} target="_blank" rel="noreferrer">💬 WhatsApp</a>
            </div>
          )}
        </div>
      ) : (
        <div className="card"><p className="hint">{t('home.notFound')}</p></div>
      )}

      {recentLoading ? (
        <Skeleton card lines={2} />
      ) : recentTrip && (
        <div className="card">
          <h3>{t('home.lastRide')}</h3>
          <p>{recentTrip.pickup.address} → {recentTrip.destination.address}</p>
          <p className="subtitle">{formatRand(recentTrip.finalFare ?? recentTrip.fareEstimate)}</p>
          <button className="link-btn" onClick={() => onRebook(recentTrip)}>{t('home.bookAgain')}</button>
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
