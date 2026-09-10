import React, { useEffect, useState } from 'react';
import { api, formatRand } from '../../api.js';
import Skeleton from '../../components/Skeleton.jsx';
import { useI18n } from '../../i18n.jsx';

export default function History({ onBack, onRebook }) {
  const { t } = useI18n();
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
        <button className="link-btn" onClick={onBack}>{t('common.back')}</button>
        <h1>{t('history.title')}</h1>
      </div>

      {loading ? (
        <>
          <Skeleton card lines={3} />
          <Skeleton card lines={3} />
          <Skeleton card lines={3} />
        </>
      ) : trips.length === 0 ? (
        <p className="hint">{t('history.empty')}</p>
      ) : (
        trips.map((tr) => (
          <div key={tr.id} className="card trip-history">
            <div className="route-line">
              <div className="route-row"><span className="dot pickup-dot" />{tr.pickup.address || 'Pickup'}</div>
              {tr.pickup.note && <div className="route-row"><span className="dot" style={{ background: 'transparent' }} />📍 <span className="hint" style={{ margin: 0 }}>{tr.pickup.note}</span></div>}
              <div className="route-row"><span className="dot dest-dot" />{tr.destination.address || 'Destination'}</div>
              {tr.destination.note && <div className="route-row"><span className="dot" style={{ background: 'transparent' }} />📍 <span className="hint" style={{ margin: 0 }}>{tr.destination.note}</span></div>}
            </div>
            <div className="history-meta">
              <span className={`badge ${tr.status}`}>{tr.status}</span>
              <span className="subtitle">{tr.distanceKm ?? '-'} km</span>
              <span className="subtitle">{formatRand(tr.finalFare ?? tr.fareEstimate)}</span>
              {tr.rating != null && <span className="stars">★ {tr.rating}</span>}
            </div>
            <p className="hint">{timeLabel(tr.timestamps?.requested)}</p>

            <div className="btn-row">
              <button className="btn small" onClick={() => setExpanded(expanded === tr.id ? null : tr.id)}>
                {expanded === tr.id ? 'Hide receipt' : 'Receipt'}
              </button>
              {tr.status === 'completed' && (
                <button className="btn small primary" onClick={() => onRebook(tr)}>{t('home.bookAgain')}</button>
              )}
            </div>

            {expanded === tr.id && (() => {
              const total = tr.finalFare ?? tr.fareEstimate ?? 0;
              const fareNoTip = Math.max(0, total - (tr.tipAmount || 0));
              return (
                <div className="receipt">
                  <h3>Receipt</h3>
                  <div className="receipt-row"><span>Fare</span><span>{formatRand(fareNoTip)}</span></div>
                  <div className="receipt-row"><span>Distance</span><span>{tr.distanceKm ?? 0} km</span></div>
                  <div className="receipt-row"><span>Duration</span><span>{tr.durationMin ?? 0} min</span></div>
                  {tr.tipAmount > 0 && <div className="receipt-row"><span>Tip</span><span>{formatRand(tr.tipAmount)}</span></div>}
                  <div className="receipt-row total"><span>Total</span><span>{formatRand(total)}</span></div>
                  <p className="hint">Trip {tr.id} · {timeLabel(tr.timestamps?.completed)}</p>
                  <button className="btn small" style={{ width: '100%', marginTop: '10px' }} onClick={() => shareReceipt(tr)}>📤 Share receipt</button>
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
