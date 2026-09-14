import React, { useEffect, useState } from 'react';
import { api, apiDownload, formatRand } from '../../api.js';

// Platform owner console. Two tabs:
//  - Settings: platform commission + the automatic offline idle timer.
//  - Drivers:  vet and approve/reject driver applications.
export default function Admin() {
  const [tab, setTab] = useState('drivers');

  return (
    <div className="screen">
      <h1>Admin</h1>
      <div className="btn-row" style={{ marginBottom: '10px' }}>
        <button className={`btn small ${tab === 'drivers' ? 'driver' : ''}`} onClick={() => setTab('drivers')}>Drivers</button>
        <button className={`btn small ${tab === 'settings' ? 'driver' : ''}`} onClick={() => setTab('settings')}>Settings</button>
      </div>
      {tab === 'drivers' ? <DriversTab /> : <SettingsTab />}
    </div>
  );
}

function DriversTab() {
  const [drivers, setDrivers] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [rejectingId, setRejectingId] = useState(null);
  const [reason, setReason] = useState('');

  async function load() {
    try {
      const res = await api('/admin/drivers');
      setDrivers(res.drivers || []);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, []);

  async function act(id, action, reason) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (action === 'approve') {
        await api(`/admin/drivers/${id}/approve`, { method: 'POST' });
        setMessage('Driver approved — they can now go online.');
      } else {
        await api(`/admin/drivers/${id}/reject`, { method: 'POST', body: { reason } });
        setMessage('Application rejected.');
      }
      await load();
      setRejectingId(null);
      setReason('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!drivers) return <p className="hint">Loading drivers…</p>;

  const order = { pending: 0, rejected: 1, approved: 2 };
  const sorted = [...drivers].sort((a, b) => (order[a.user.driverStatus] ?? 9) - (order[b.user.driverStatus] ?? 9) || a.user.createdAt.localeCompare(b.user.createdAt));
  const pending = sorted.filter((d) => d.user.driverStatus === 'pending');

  const statusLabel = (s) => (
    s === 'approved' ? 'Approved' : s === 'rejected' ? 'Rejected' : s === 'pending' ? 'Pending review' : s || 'Approved'
  );

  return (
    <>
      {message && <p className="success">{message}</p>}
      {error && <p className="error">{error}</p>}

      {pending.length > 0 && <p className="hint" style={{ fontWeight: 650 }}>{pending.length} driver{pending.length !== 1 ? 's' : ''} waiting for review.</p>}

      {sorted.length === 0 && <p className="hint">No drivers yet.</p>}

      {sorted.map((d) => {
        const u = d.user;
        const app = d.application;
        const isPending = u.driverStatus === 'pending';
        const isRejected = u.driverStatus === 'rejected';
        const isOwner = u.role === 'admin';
        return (
          <div className="card driver-card" key={u.id}>
            <div className="field-row" style={{ justifyContent: 'space-between' }}>
              <div>
                <strong>{u.name || 'Unnamed driver'}{isOwner ? ' (you)' : ''}</strong>
                <p className="hint" style={{ margin: '2px 0 0' }}>{u.phone}</p>
              </div>
              <span className={`badge ${u.driverStatus === 'approved' ? 'completed' : u.driverStatus === 'pending' ? 'requested' : 'cancelled'}`}>{statusLabel(u.driverStatus)}</span>
            </div>

            {app?.idNumber && <p className="hint" style={{ margin: '6px 0' }}>ID: {app.idNumber}</p>}
            {isRejected && u.rejectionReason && <p className="hint" style={{ margin: '4px 0' }}>Reason: {u.rejectionReason}</p>}

            {app && (
              <div className="field-row" style={{ flexWrap: 'wrap' }}>
                {app.idCopyUrl && <DocLink url={app.idCopyUrl} label="ID copy" />}
                {app.selfieUrl && <DocLink url={app.selfieUrl} label="Photo" />}
                {app.proofOfResidenceUrl && <DocLink url={app.proofOfResidenceUrl} label="Proof of residence" />}
              </div>
            )}

            {(isPending || isRejected) && (
              <div style={{ marginTop: '8px' }}>
                <div className="btn-row">
                  <button className="btn small primary" disabled={busy} onClick={() => act(u.id, 'approve')}>Approve</button>
                  {rejectingId === u.id ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <input style={{ minWidth: 140 }} type="text" placeholder="Reason shown to driver" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
                      <button className="btn small danger" disabled={busy} onClick={() => { act(u.id, 'reject', reason.trim() || 'Not approved'); setRejectingId(null); }}>Confirm</button>
                      <button className="btn small" onClick={() => { setRejectingId(null); setReason(''); }}>Cancel</button>
                    </span>
                  ) : (
                    <button className="btn small danger" disabled={busy} onClick={() => { setRejectingId(u.id); setReason(''); }}>Reject</button>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

function DocLink({ url, label }) {
  const [err, setErr] = useState('');
  return (
    <a
      className="link-btn"
      href={url}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setErr('');
        apiDownload(url).catch((x) => setErr(x.message));
      }}
    >
      {label}
      {err && <em style={{ color: 'var(--danger)' }}> ({err})</em>}
    </a>
  );
}

function SettingsTab() {
  const [fee, setFee] = useState('');
  const [graceMs, setGraceMs] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api('/driver/settings')
      .then((r) => {
        const s = r.settings || {};
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
      await api('/driver/settings', {
        method: 'PUT',
        body: {
          platform_fee_percent: Number(fee),
          auto_offline_grace_ms: Number(graceMs) * 60 * 1000,
        },
      });
      setMessage('Settings saved');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const feeNum = Number(fee);
  const exampleFare = 100;
  const platformShare = feeNum >= 0 ? ((feeNum / 100) * exampleFare).toFixed(2) : null;

  return (
    <>
      <p className="subtitle">Business rules applied to every ride.</p>

      <form className="card form-card" onSubmit={save}>
        <div className="field">
          <span className="field-label">Platform commission (%)</span>
          <input
            type="number" min="0" max="100" step="0.5"
            value={fee}
            onChange={(e) => setFee(e.target.value)}
            placeholder={String(configDefaultFee)}
          />
          <p className="hint">
            Commission the platform keeps from each trip (after Yoco's card fee). For a {formatRand(exampleFare)} trip this is {platformShare != null ? formatRand(Number(platformShare)) : '—'}.
          </p>
        </div>

        <div className="field">
          <span className="field-label">Go offline after (minutes)</span>
          <input
            type="number" min="1" max="60"
            value={graceMs}
            onChange={(e) => setGraceMs(e.target.value)}
          />
          <p className="hint">If no trip arrives within this time, a driver shows offline automatically.</p>
        </div>

        <div className="btn-row" style={{ marginTop: '6px' }}>
          <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</button>
        </div>
        {message && <p className="success">{message}</p>}
        {error && <p className="error">{error}</p>}
      </form>
    </>
  );
}

const configDefaultFee = 10;