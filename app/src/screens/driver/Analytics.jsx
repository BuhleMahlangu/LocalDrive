import React, { useEffect, useState } from 'react';
import { api, formatRand } from '../../api.js';
import Skeleton from '../../components/Skeleton.jsx';

// Driver-side analytics: daily earnings trend, busiest hours, acceptance rate
// and cancellation health. Pure read-only insights pulled from the trips table.

export default function Analytics() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/driver/analytics')
      .then(setData)
      .catch((e) => setError(e.message || 'Could not load analytics'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="screen"><Skeleton card lines={5} /></div>;

  if (error || !data) {
    return (
      <div className="screen">
        <div className="card"><p className="error">{error || 'No analytics available yet'}</p></div>
      </div>
    );
  }

  const maxEarnings = Math.max(...data.dailyEarnings.map((d) => d.earnings), 1);
  const maxHours = Math.max(...data.busiestHours.map((h) => h.count), 1);

  return (
    <div className="screen">
      <h1>📊 Analytics</h1>

      <div className="card">
        <h3>Earnings — last 7 days</h3>
        <div className="bar-chart">
          {data.dailyEarnings.map((d) => (
            <div key={d.date} className="bar-col">
              <div className="bar-track">
                <div
                  className="bar-fill"
                  style={{ height: `${Math.max(4, (d.earnings / maxEarnings) * 100)}%` }}
                  title={`${formatRand(d.earnings)} — ${d.count} trips`}
                />
              </div>
              <span className="bar-label">{d.label}</span>
              <span className="bar-value">{formatRand(d.earnings)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h3>Busiest hours</h3>
        <p className="hint">When your requests come in — useful for deciding when to go online.</p>
        {data.busiestHours.length === 0 ? (
          <p className="hint">No trip data yet.</p>
        ) : (
          <div className="hour-list">
            {data.busiestHours.map((h) => (
              <div key={h.hour} className="hour-row">
                <span className="hour-label">{fmtHour(h.hour)}</span>
                <div className="hour-meter">
                  <div className="bar-fill hour-fill" style={{ width: `${Math.max(6, (h.count / maxHours) * 100)}%` }} />
                </div>
                <span className="hour-count">{h.count}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="stats-grid">
        <div className="stat-tile"><span className="stat-num">{data.totalTrips}</span><span className="stat-label">All trips</span></div>
        <div className="stat-tile"><span className="stat-num">{data.completedTrips}</span><span className="stat-label">Completed</span></div>
        <div className="stat-tile"><span className="stat-num">{data.acceptanceRate}%</span><span className="stat-label">Acceptance</span></div>
        <div className="stat-tile"><span className="stat-num">{data.avgWaitMin} min</span><span className="stat-label">Avg accept time</span></div>
        <div className="stat-tile"><span className="stat-num">{data.cancelledByCustomer}</span><span className="stat-label">You cancelled</span></div>
        <div className="stat-tile"><span className="stat-num">{data.cancelledByDriver}</span><span className="stat-label">Customer cancelled</span></div>
      </div>

      <div className="card">
        <p className="hint">
          💡 Tip: a high “customer cancelled” count usually means pickups in awkward spots —
          try nudging preset pickup points to better landmarks.
        </p>
      </div>
    </div>
  );
}

function fmtHour(h) {
  const d = new Date();
  d.setHours(h, 0, 0, 0);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}