import React, { useEffect, useState } from 'react';
import { api, formatRand } from '../../api.js';

export default function History({ onBack, onRebook }) {
  const [trips, setTrips] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);

  useEffect(() => {
    api('/customer/trips')
      .then(setTrips)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="screen">
      <div className="book-header">
        <button className="link-btn" onClick={onBack}>‹ Back</button>
        <h1>Ride history</h1>
      </div>

      {loading ? (
        <p className="hint">Loading…</p>
      ) : trips.length === 0 ? (
        <p className="hint">No rides yet. Book your first trip!</p>
      ) : (
        trips.map((t) => (
          <div key={t.id} className="card trip-history">
            <div className="route-line">
              <div className="route-row"><span className="dot pickup-dot" />{t.pickup.address || 'Pickup'}</div>
              {t.pickup.note && <div className="route-row"><span className="dot" style={{ background: 'transparent' }} />📍 <span className="hint" style={{ margin: 0 }}>{t.pickup.note}</span></div>}
              <div className="route-row"><span className="dot dest-dot" />{t.destination.address || 'Destination'}</div>
              {t.destination.note && <div className="route-row"><span className="dot" style={{ background: 'transparent' }} />📍 <span className="hint" style={{ margin: 0 }}>{t.destination.note}</span></div>}
            </div>
            <div className="history-meta">
              <span className={`badge ${t.status}`}>{t.status}</span>
              <span className="subtitle">{t.distanceKm ?? '-'} km</span>
              <span className="subtitle">{formatRand(t.finalFare ?? t.fareEstimate)}</span>
              {t.rating != null && <span className="stars">★ {t.rating}</span>}
            </div>
            <p className="hint">{timeLabel(t.timestamps?.requested)}</p>

            <div className="btn-row">
              <button className="btn small" onClick={() => setExpanded(expanded === t.id ? null : t.id)}>
                {expanded === t.id ? 'Hide receipt' : 'Receipt'}
              </button>
              {t.status === 'completed' && (
                <button className="btn small primary" onClick={() => onRebook(t)}>Book again</button>
              )}
            </div>

            {expanded === t.id && (() => {
              const total = t.finalFare ?? t.fareEstimate ?? 0;
              const fareNoTip = Math.max(0, total - (t.tipAmount || 0));
              return (
                <div className="receipt">
                  <h3>Receipt</h3>
                  <div className="receipt-row"><span>Fare</span><span>{formatRand(fareNoTip)}</span></div>
                  <div className="receipt-row"><span>Distance</span><span>{t.distanceKm ?? 0} km</span></div>
                  <div className="receipt-row"><span>Duration</span><span>{t.durationMin ?? 0} min</span></div>
                  {t.tipAmount > 0 && <div className="receipt-row"><span>Tip</span><span>{formatRand(t.tipAmount)}</span></div>}
                  <div className="receipt-row total"><span>Total</span><span>{formatRand(total)}</span></div>
                  <p className="hint">Trip {t.id} · {timeLabel(t.timestamps?.completed)}</p>
                  <button className="btn small" style={{ width: '100%', marginTop: '10px' }} onClick={() => shareReceipt(t)}>📤 Share receipt</button>
                </div>
              );
            })()}
          </div>
        ))
      )}
    </div>
  );
}

function shareReceipt(t) {
  const lines = [
    '🧾 DriveLocal receipt',
    `${t.pickup?.address || 'Pickup'} → ${t.destination?.address || 'Destination'}`,
    `Distance: ${t.distanceKm ?? '-'} km · Time: ${t.durationMin ?? '-'} min`,
    `Fare: ${formatRand(t.finalFare ?? t.fareEstimate)}`,
    ...(t.tipAmount > 0 ? [`Tip: ${formatRand(t.tipAmount)}`] : []),
    t.rating != null ? `Rating: ${t.rating}★` : '',
  ].filter(Boolean);
  const text = lines.join('\n');

  if (navigator.share) {
    navigator.share({ title: 'DriveLocal receipt', text }).catch(() => {});
  } else {
    // Fallback: WhatsApp share (no phone number -> opens the share picker).
    const msg = encodeURIComponent(text);
    const url = `https://api.whatsapp.com/send?text=${msg}`;
    window.open(url, '_blank', 'noopener');
  }
}

function timeLabel(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString();
}
