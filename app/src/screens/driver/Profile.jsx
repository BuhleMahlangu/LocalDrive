import React, { useState } from 'react';
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

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
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

        <h3 className="section-title">Notifications</h3>
        <NotificationsToggle />

        {message && <p className="success">{message}</p>}
        {error && <p className="error">{error}</p>}
        <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save profile'}</button>
      </form>
    </div>
  );
}
