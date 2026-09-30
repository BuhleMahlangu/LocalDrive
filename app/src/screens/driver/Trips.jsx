import React, { useEffect, useState } from 'react';
import { api, formatRand } from '../../api.js';
import Skeleton from '../../components/Skeleton.jsx';
import { useI18n } from '../../i18n.jsx';

export default function Trips() {
  const { t, statusLabel } = useI18n();
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api('/driver/trips')
      .then((r) => setHistory(Array.isArray(r) ? r : []))
      .catch(() => setHistory([]))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="screen">
      <h1>{t('nav.trips')}</h1>
      {loading ? (
        <>
          <Skeleton card lines={3} />
          <Skeleton card lines={3} />
        </>
      ) : history.length === 0 ? (
        <p className="hint">{t('trips.empty')}</p>
      ) : (
        history.map((trip) => (
          <div key={trip.id} className="card trip-history">
            <div className="route-line">
              <div className="route-row"><span className="dot pickup-dot" />{trip.pickup?.address || t('common.pickup')}</div>
              {trip.pickup?.note && <div className="route-row"><span className="dot" style={{ background: 'transparent' }} />📍 <span className="hint" style={{ margin: 0 }}>{trip.pickup.note}</span></div>}
              <div className="route-row"><span className="dot dest-dot" />{trip.destination?.address || t('common.destination')}</div>
              {trip.destination?.note && <div className="route-row"><span className="dot" style={{ background: 'transparent' }} />📍 <span className="hint" style={{ margin: 0 }}>{trip.destination.note}</span></div>}
            </div>
            <div className="history-meta">
              <span className={`badge ${trip.status}`}>{statusLabel(trip.status)}</span>
              <span className="subtitle">{trip.distanceKm ?? '-'} km</span>
              <span className="subtitle">{formatRand(trip.finalFare ?? trip.fareEstimate)}</span>
              {trip.rating != null && <span className="stars">★ {trip.rating}</span>}
            </div>
            {trip.customerName && <p className="hint">{t('trips.customer')}: {trip.customerName} {trip.customerPhone ? `· ${trip.customerPhone}` : ''}</p>}
            {trip.feedbackTags?.length > 0 && (
              <p className="hint">📝 {trip.feedbackTags.join(' · ')}</p>
            )}
            {trip.tipAmount > 0 && <p className="hint">{t('common.tip')}: {formatRand(trip.tipAmount)}</p>}
            <p className="hint">{timeLabel(trip.timestamps?.requested)}</p>
          </div>
        ))
      )}
    </div>
  );
}

function timeLabel(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString();
}
