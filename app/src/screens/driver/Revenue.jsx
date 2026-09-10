import React, { useEffect, useState } from 'react';
import { api } from '../../api.js';

// Revenue toolbox for the owner: promo code management, a referral invite link,
// and a placeholder for the upcoming "local business ads" feature.

export default function Revenue() {
  const [promos, setPromos] = useState([]);
  const [openDisputes, setOpenDisputes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  // New-promo form state.
  const [code, setCode] = useState('');
  const [discount, setDiscount] = useState('10');
  const [maxUses, setMaxUses] = useState('50');
  const [saving, setSaving] = useState(false);
  const [resolveId, setResolveId] = useState(null);

  const load = () => {
    api('/driver/promos').then((r) => setPromos(Array.isArray(r.promos) ? r.promos : [])).catch(() => {});
    api('/driver/disputes')
      .then((r) => {
        const list = Array.isArray(r.disputes) ? r.disputes : [];
        setOpenDisputes(list);
      })
      .catch(() => {});
  };

  useEffect(() => { load(); setLoading(false); }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(''), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  async function createPromo(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const r = await api('/driver/promos', {
        method: 'POST',
        body: { code, discountPercent: parseFloat(discount), maxUses: parseInt(maxUses, 10) },
      });
      setPromos((cur) => [r.promo, ...cur]);
      setCode('');
      setToast(`Promo ${r.promo.code} created`);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function resolveDispute(disputeId) {
    if (resolveId) return;
    setResolveId(disputeId);
    try {
      await api(`/driver/disputes/${disputeId}/resolve`, { method: 'POST', body: { resolution: 'Resolved by owner' } });
      load();
      setToast('Dispute resolved');
    } catch (e) {
      setError(e.message);
    } finally {
      setResolveId(null);
    }
  }

  function shareReferral() {
    const text = '🚗 Ride with DriveLocal — first ride discount! Install the app and book a safe local ride.';
    const url = `${window.location.origin}${window.location.pathname}`;
    navigator.clipboard?.writeText(`${text} ${url}`).then(() => {
      setToast('Referral link copied — share it with friends');
    }).catch(() => {
      window.open(`https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`, '_blank');
    });
  }

  return (
    <div className="screen">
      {toast && <div className="toast">{toast}</div>}
      <h1>💰 Revenue</h1>
      {error && <p className="error">{error}</p>}

      <div className="card">
        <h3>📣 Refer friends</h3>
        <p className="hint">Share your app link — every new customer who books is free word-of-mouth for your area.</p>
        <button className="btn primary" onClick={shareReferral}>Share referral link</button>
      </div>

      <div className="card">
        <h3>🏪 Local business ads</h3>
        <p className="hint">
          Coming soon: promote local Kriel & Thubelihle businesses (spaza shops, mechanics, salons)
          on the landing page for a small monthly fee. This is where your second income line will live.
        </p>
        <p className="hint" style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>
          Interested? Keep an eye here or contact your developer to set it up.
        </p>
      </div>

      <div className="card">
        <h3>🎟️ Promo codes</h3>
        <p className="hint">Create a code to give new customers a discount on their first ride.</p>
        <form onSubmit={createPromo}>
          <div className="grid-2">
            <label className="field">
              <span className="field-label">Code (e.g. WELCOME20)</span>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="FRIEND10"
                style={{ textTransform: 'uppercase' }}
                maxLength={20}
                required
              />
            </label>
            <label className="field">
              <span className="field-label">Discount %</span>
              <input type="number" value={discount} onChange={(e) => setDiscount(e.target.value)} min="1" max="100" required />
            </label>
          </div>
          <label className="field">
            <span className="field-label">Max uses</span>
            <input type="number" value={maxUses} onChange={(e) => setMaxUses(e.target.value)} min="1" required />
          </label>
          <button className="btn primary" type="submit" disabled={saving || !code}>
            {saving ? '…' : 'Create promo'}
          </button>
        </form>

        {promos.length > 0 && (
          <div className="promo-list">
            {promos.map((p) => (
              <div key={p.id} className="promo-row">
                <span className="promo-code">{p.code}</span>
                <span className="promo-meta">−{p.discount_percent}%</span>
                <span className="promo-meta">{p.used_count}/{p.max_uses} used</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {openDisputes.length > 0 && (
        <div className="card">
          <h3>⚠️ Open fare disputes</h3>
          <p className="hint">Customers flagged a fare on these completed trips.</p>
          {openDisputes.map((d) => (
            <div key={d.id} className="dispute-row">
              <p className="hint">{d.reason}</p>
              <button className="btn small" onClick={() => resolveDispute(d.id)} disabled={resolveId === d.id}>
                {resolveId === d.id ? '…' : 'Mark resolved'}
              </button>
            </div>
          ))}
        </div>
      )}

      {!loading && openDisputes.length === 0 && promos.length === 0 && (
        <p className="hint">No promos or disputes yet.</p>
      )}
    </div>
  );
}