import React, { useEffect, useState } from 'react';
import { api, formatRand } from '../../api.js';
import NotificationsToggle from '../../components/NotificationsToggle.jsx';

export default function Profile({ user, onUserUpdate }) {
  const [form, setForm] = useState({
    name: user.name || '',
    email: user.email || '',
    vehicleType: user.vehicleType || '',
    licensePlate: user.licensePlate || '',
    serviceRadiusKm: user.serviceRadiusKm != null ? user.serviceRadiusKm : 50,
    baseFare: user.baseFare != null ? user.baseFare : 25,
    perKmRate: user.perKmRate != null ? user.perKmRate : 12,
    perMinRate: user.perMinRate != null ? user.perMinRate : 2.5,
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  // Payout + bank account state.
  const [bank, setBank] = useState({ accountHolder: '', bankName: '', accountNumber: '', accountType: 'current', branchCode: '' });
  const [bankMsg, setBankMsg] = useState('');
  const [bankErr, setBankErr] = useState('');
  const [bankBusy, setBankBusy] = useState(false);
  const [wallet, setWallet] = useState(null);
  const [payouts, setPayouts] = useState([]);
  const [payoutAmount, setPayoutAmount] = useState('');
  const [payoutNote, setPayoutNote] = useState('');
  const [payoutMsg, setPayoutMsg] = useState('');
  const [payoutErr, setPayoutErr] = useState('');
  const [payoutBusy, setPayoutBusy] = useState(false);

  useEffect(() => {
    api('/driver/bank-account').then((r) => {
      if (r.account) setBank((b) => ({ ...b, ...bankFromAccount(r.account) }));
    }).catch(() => {});
    api('/driver/wallet').then((r) => setWallet(r.wallet)).catch(() => {});
    api('/driver/payouts').then((r) => setPayouts(r.payouts || [])).catch(() => {});
  }, []);

  function bankFromAccount(a) {
    return {
      accountHolder: a.accountHolder || '',
      bankName: a.bankName || '',
      accountNumber: a.accountNumberMasked ? '' : (a.accountNumber || ''),
      accountType: a.accountType || 'current',
      branchCode: a.branchCode || '',
    };
  }

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function saveBank(e) {
    e.preventDefault();
    setBankBusy(true);
    setBankMsg('');
    setBankErr('');
    try {
      await api('/driver/bank-account', { method: 'PUT', body: bank });
      setBankMsg('Bank account saved');
      api('/driver/bank-account').then((r) => setBank((b) => ({ ...b, ...bankFromAccount(r.account) }))).catch(() => {});
    } catch (err) {
      setBankErr(err.message);
    } finally {
      setBankBusy(false);
    }
  }

  async function requestPayout(e) {
    e.preventDefault();
    setPayoutBusy(true);
    setPayoutMsg('');
    setPayoutErr('');
    try {
      const amountCents = Math.round(Number(payoutAmount) * 100);
      await api('/driver/payouts', { method: 'POST', body: { amountCents, note: payoutNote } });
      setPayoutMsg('Payout request submitted');
      setPayoutAmount('');
      setPayoutNote('');
      const [w, p] = await Promise.all([api('/driver/wallet').catch(() => ({ wallet })), api('/driver/payouts').catch(() => ({ payouts }))]);
      if (w.wallet) setWallet(w.wallet);
      setPayouts(p.payouts || []);
    } catch (err) {
      setPayoutErr(err.message);
    } finally {
      setPayoutBusy(false);
    }
  }

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const updated = await api('/driver/profile', {
        method: 'PUT',
        body: {
          name: form.name || undefined,
          email: form.email || undefined,
          vehicleType: form.vehicleType || undefined,
          licensePlate: form.licensePlate || undefined,
          serviceRadiusKm: Number(form.serviceRadiusKm),
          baseFare: Number(form.baseFare),
          perKmRate: Number(form.perKmRate),
          perMinRate: Number(form.perMinRate),
        },
      });
      onUserUpdate(updated);
      setMessage('Profile saved');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen">
      <h1>Driver profile</h1>
      <p className="subtitle">These details are shown to your customers and used for pricing.</p>

      <form className="card form-card" onSubmit={save}>
        <label>Name
          <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Thabo" />
        </label>
        <label>Email (receipts)
          <input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} placeholder="you@email.com" />
        </label>
        <label>Vehicle type
          <input value={form.vehicleType} onChange={(e) => set('vehicleType', e.target.value)} placeholder="Toyota Corolla" />
        </label>
        <label>License plate
          <input value={form.licensePlate} onChange={(e) => set('licensePlate', e.target.value)} placeholder="CA 12-345-GP" />
        </label>

        <div className="field">
          <span className="field-label">Service radius (km) — max pickup distance</span>
          <input type="number" min="1" max="200" value={form.serviceRadiusKm} onChange={(e) => set('serviceRadiusKm', e.target.value)} />
        </div>

        <h3 className="section-title">Pricing (ZAR)</h3>
        <div className="grid-2">
          <div className="field">
            <span className="field-label">Base fare (R)</span>
            <input type="number" min="0" step="0.5" value={form.baseFare} onChange={(e) => set('baseFare', e.target.value)} />
          </div>
          <div className="field">
            <span className="field-label">Per km (R)</span>
            <input type="number" min="0" step="0.5" value={form.perKmRate} onChange={(e) => set('perKmRate', e.target.value)} />
          </div>
          <div className="field">
            <span className="field-label">Per min (R)</span>
            <input type="number" min="0" step="0.1" value={form.perMinRate} onChange={(e) => set('perMinRate', e.target.value)} />
          </div>
        </div>

        <div className="rate-preview">
          Example: 10 km / 25 min = {formatRand((form.baseFare || 0) + (form.perKmRate || 0) * 10 + (form.perMinRate || 0) * 25)}
        </div>

        <label>Phone (fixed)
          <input value={user.phone} readOnly />
        </label>
        {user.rating != null && (
          <p className="hint">⭐ Rating {user.rating.toFixed(1)} ({user.ratingCount} trips)</p>
        )}

        <h3 className="section-title">Payout bank account</h3>
        <form className="card form-card" onSubmit={saveBank}>
          <label>Account holder
            <input value={bank.accountHolder} onChange={(e) => setBank((b) => ({ ...b, accountHolder: e.target.value }))} required />
          </label>
          <label>Bank
            <input value={bank.bankName} onChange={(e) => setBank((b) => ({ ...b, bankName: e.target.value }))} required />
          </label>
          <label>Account number
            <input value={bank.accountNumber} onChange={(e) => setBank((b) => ({ ...b, accountNumber: e.target.value }))} required placeholder="Only last 4 digits shown after save" />
          </label>
          <label>Account type
            <select value={bank.accountType} onChange={(e) => setBank((b) => ({ ...b, accountType: e.target.value }))}>
              <option value="current">Current</option>
              <option value="savings">Savings</option>
            </select>
          </label>
          <label>Branch code (optional)
            <input value={bank.branchCode} onChange={(e) => setBank((b) => ({ ...b, branchCode: e.target.value }))} />
          </label>
          {bankMsg && <p className="success">{bankMsg}</p>}
          {bankErr && <p className="error">{bankErr}</p>}
          <button className="btn" disabled={bankBusy}>{bankBusy ? 'Saving…' : 'Save bank account'}</button>
        </form>

        <h3 className="section-title">Request payout</h3>
        <div className="card">
          <p className="hint">Available balance: {formatRand((wallet?.availableCents || 0) / 100)}</p>
          <form className="form-card" onSubmit={requestPayout}>
            <label>Amount (R)
              <input type="number" min="1" step="0.01" value={payoutAmount} onChange={(e) => setPayoutAmount(e.target.value)} required />
            </label>
            <label>Note (optional)
              <input value={payoutNote} onChange={(e) => setPayoutNote(e.target.value)} />
            </label>
            {payoutMsg && <p className="success">{payoutMsg}</p>}
            {payoutErr && <p className="error">{payoutErr}</p>}
            <button className="btn primary" disabled={payoutBusy}>{payoutBusy ? 'Submitting…' : 'Request payout'}</button>
          </form>
          {payouts.length > 0 && (
            <div style={{ marginTop: '12px' }}>
              <h4>Recent payouts</h4>
              <ul className="list-compact">
                {payouts.slice(0, 8).map((p) => (
                  <li key={p.id}>{new Date(p.createdAt).toLocaleDateString()} — {formatRand(p.amountCents / 100)} · <strong>{p.status}</strong></li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <h3 className="section-title">Notifications</h3>
        <NotificationsToggle />

        {message && <p className="success">{message}</p>}
        {error && <p className="error">{error}</p>}
        <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save profile'}</button>
      </form>
    </div>
  );
}
