import React, { useEffect, useState } from 'react';
import { api, formatRand } from '../../api.js';

// Business/admin settings for the owner driver. Pricing lives in Profile; this
// screen covers platform commissions and the automatic offline idle timer.
export default function Admin() {
  const [settings, setSettings] = useState(null);
  const [fee, setFee] = useState('');
  const [graceMs, setGraceMs] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api('/driver/settings')
      .then((r) => {
        const s = r.settings || {};
        setSettings(s);
        setFee(String(s.platform_fee_percent ?? configDefaultFee));
        setGraceMs(String(Math.round((s.auto_offline_grace_ms ?? 600000) / 60000)));
      })
      .catch(() => setError('Could not load settings'));
  }, []);

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const res = await api('/driver/settings', {
        method: 'PUT',
        body: {
          platform_fee_percent: Number(fee),
          auto_offline_grace_ms: Number(graceMs) * 60 * 1000,
        },
      });
      setSettings(res.settings);
      setMessage('Settings saved');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const feeNum = Number(fee);
  const exampleFare = 100;
  const platformShare = settings == null ? null : feeNum >= 0 ? ((feeNum / 100) * exampleFare).toFixed(2) : null;

  return (
    <div className="screen">
      <h1>⚙️ Admin settings</h1>
      <p className="subtitle">Business rules that apply to every new request.</p>

      <form className="card form-card" onSubmit={save}>
        <div className="field">
          <span className="field-label">Platform fee (%)</span>
          <input
            type="number" min="0" max="100" step="0.5"
            value={fee}
            onChange={(e) => setFee(e.target.value)}
            placeholder={String(configDefaultFee)}
          />
          <p className="hint">
            Fee (commission) deducted from each trip's fare before your payout. For a {formatRand(exampleFare)} trip this is {platformShare != null ? formatRand(Number(platformShare)) : '—'}.
          </p>
        </div>

        <div className="field">
          <span className="field-label">Go offline after (minutes)</span>
          <input
            type="number" min="1" max="60"
            value={graceMs}
            onChange={(e) => setGraceMs(e.target.value)}
          />
          <p className="hint">If no trip arrives within this time, the app stops showing you online automatically.</p>
        </div>

        <div className="btn-row" style={{ marginTop: '6px' }}>
          <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</button>
        </div>
        {message && <p className="success">{message}</p>}
        {error && <p className="error">{error}</p>}
      </form>

      <div className="card">
        <h3>How payouts work</h3>
        <p className="hint" style={{ margin: '6px 0 0' }}>
          Cash trips pay the full fare upfront; your fee is tracked on the trip. Card trips settle the full fare, then your share is paid to your bank on schedule.
        </p>
      </div>
    </div>
  );
}

const configDefaultFee = 10;