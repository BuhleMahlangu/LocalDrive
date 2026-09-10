import React, { useEffect, useState } from 'react';
import { api, formatRand } from '../../api.js';
import Skeleton from '../../components/Skeleton.jsx';

export default function Trips() {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api('/driver/trips')
      .then((t) => setHistory(Array.isArray(t) ? t : []))
      .catch(() => setHistory([]))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="screen">
      <h1>Trip history</h1>
      {loading ? (
        <>
          <Skeleton card lines={3} />
          <Skeleton card lines={3} />
        </>
      ) : history.length === 0 ? (
        <p className="hint">No trips yet.</p>
      ) : (
        history.map((t) => (
          <div key={t.id} className="card trip-history">
            <div className="route-line">
              <div className="route-row"><span className="dot pickup-dot" />{t.pickup?.address || 'Pickup'}</div>
              {t.pickup?.note && <div className="route-row"><span className="dot" style={{ background: 'transparent' }} />📍 <span className="hint" style={{ margin: 0 }}>{t.pickup.note}</span></div>}
              <div className="route-row"><span className="dot dest-dot" />{t.destination?.address || 'Destination'}</div>
              {t.destination?.note && <div className="route-row"><span className="dot" style={{ background: 'transparent' }} />📍 <span className="hint" style={{ margin: 0 }}>{t.destination.note}</span></div>}
            </div>
            <div className="history-meta">
              <span className={`badge ${t.status}`}>{t.status}</span>
              <span className="subtitle">{t.distanceKm ?? '-'} km</span>
              <span className="subtitle">{formatRand(t.finalFare ?? t.fareEstimate)}</span>
              {t.rating != null && <span className="stars">★ {t.rating}</span>}
            </div>
            {t.customerName && <p className="hint">Customer: {t.customerName} {t.customerPhone ? `· ${t.customerPhone}` : ''}</p>}
            {t.feedbackTags?.length > 0 && (
              <p className="hint">📝 {t.feedbackTags.join(' · ')}</p>
            )}
            {t.tipAmount > 0 && <p className="hint">Tip: {formatRand(t.tipAmount)}</p>}
            <p className="hint">{timeLabel(t.timestamps?.requested)}</p>
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
