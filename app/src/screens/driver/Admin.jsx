import React, { useEffect, useRef, useState } from 'react';
import { api, apiDownload, formatRand } from '../../api.js';
import Map from '../../components/Map.jsx';
import decodePolyline from '../../lib/polyline.js';

// Platform owner console. Four tabs:
//  - Drivers:  vet and approve/reject driver applications.
//  - Records:  trip audit trail — search any rider/driver by name so the owner
//              can reconstruct "who was with whom, when, and where".
//  - Spots:    the preset pickup spots every customer and driver sees on the map.
//  - Settings: platform commission + the automatic offline idle timer.
export default function Admin() {
  const [tab, setTab] = useState('drivers');

  return (
    <div className="screen">
      <h1>Admin</h1>
      <div className="btn-row" style={{ marginBottom: '10px' }}>
        <button className={`btn small ${tab === 'drivers' ? 'driver' : ''}`} onClick={() => setTab('drivers')}>Drivers</button>
        <button className={`btn small ${tab === 'records' ? 'driver' : ''}`} onClick={() => setTab('records')}>Records</button>
        <button className={`btn small ${tab === 'spots' ? 'driver' : ''}`} onClick={() => setTab('spots')}>Spots</button>
        <button className={`btn small ${tab === 'settings' ? 'driver' : ''}`} onClick={() => setTab('settings')}>Settings</button>
      </div>
      {tab === 'drivers' ? <DriversTab /> : tab === 'records' ? <RecordsTab /> : tab === 'spots' ? <SpotsTab /> : <SettingsTab />}
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
      } else if (action === 'unsuspend') {
        await api(`/admin/drivers/${id}/unsuspend`, { method: 'POST' });
        setMessage('Driver re-activated — they can go online again.');
      } else if (action === 'suspend') {
        await api(`/admin/drivers/${id}/suspend`, { method: 'POST' });
        setMessage('Driver suspended — forced offline and blocked from taking rides.');
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

  const order = { pending: 0, rejected: 1, approved: 2, suspended: 3 };
  const sorted = [...drivers].sort((a, b) => (order[a.user.driverStatus] ?? 9) - (order[b.user.driverStatus] ?? 9) || a.user.createdAt.localeCompare(b.user.createdAt));
  const pending = sorted.filter((d) => d.user.driverStatus === 'pending');

  const statusLabel = (s) => (
    s === 'approved' ? 'Approved' : s === 'rejected' ? 'Rejected' : s === 'pending' ? 'Pending review' : s === 'suspended' ? 'Suspended' : s || 'Approved'
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
        const isSuspended = u.driverStatus === 'suspended';
        const isOperational = u.driverStatus === 'approved' || u.driverStatus == null;
        const isOwner = u.role === 'admin';
        const badgeClass = u.driverStatus === 'approved' || u.driverStatus == null ? 'completed'
          : u.driverStatus === 'pending' ? 'requested'
            : u.driverStatus === 'suspended' ? 'suspended' : 'cancelled';
        return (
          <div className="card driver-card" key={u.id}>
            <div className="field-row" style={{ justifyContent: 'space-between' }}>
              <div>
                <strong>{u.name || 'Unnamed driver'}{isOwner ? ' (you)' : ''}</strong>
                <p className="hint" style={{ margin: '2px 0 0' }}>{u.phone}</p>
              </div>
              <span className={`badge ${badgeClass}`}>{statusLabel(u.driverStatus)}</span>
            </div>

            {app?.idNumber && <p className="hint" style={{ margin: '6px 0' }}>ID: {app.idNumber}</p>}
            {(isRejected || isSuspended) && u.rejectionReason && <p className="hint" style={{ margin: '4px 0' }}>Reason: {u.rejectionReason}</p>}

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

            {/* Approved or suspended: the owner can pull a driver off the road. */}
            {(isOperational || isSuspended) && !isOwner && (
              <div className="btn-row" style={{ marginTop: '8px' }}>
                {isOperational ? (
                  <button className="btn small danger" disabled={busy} onClick={() => act(u.id, 'suspend')}>Suspend driver</button>
                ) : (
                  <button className="btn small primary" disabled={busy} onClick={() => act(u.id, 'unsuspend')}>Re-activate driver</button>
                )}
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

// Admin-managed preset pickup spots. Every customer (Book screen) and driver
// (Dashboard map) sees these as pins. CRUD is admin-only; drivers view them
// read-only and customers just pick the nearest one.
function SpotsTab() {
  const [spots, setSpots] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [movingId, setMovingId] = useState(null);
  const [hint, setHint] = useState(null);
  const [names, setNames] = useState({});
  const renameTimers = useRef({});

  async function load() {
    try {
      const res = await api('/admin/spots');
      setSpots(Array.isArray(res.spots) ? res.spots : []);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, []);

  function rename(id, name) {
    setNames((d) => ({ ...d, [id]: name }));
    clearTimeout(renameTimers.current[id]);
    renameTimers.current[id] = setTimeout(() => {
      api(`/admin/spots/${id}`, { method: 'PUT', body: { name } })
        .catch((err) => setError(err.message));
    }, 700);
  }

  function flushRename(id, name) {
    const current = names[id];
    if (current != null && current !== name) {
      api(`/admin/spots/${id}`, { method: 'PUT', body: { name: current } }).catch((err) => setError(err.message));
    }
    setNames((d) => { const next = { ...d }; delete next[id]; return next; });
  }

  async function addSpot(e) {
    const { lat, lng } = e.latlng;
    setBusy(true);
    setError('');
    try {
      await api('/admin/spots', { method: 'POST', body: { name: 'New pickup spot', lat, lng } });
      setHint(null);
      setAdding(false);
      await load();
      setMessage('Pickup spot added — type a name for it below.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function moveSpot(e) {
    const { lat, lng } = e.latlng;
    const id = movingId;
    setBusy(true);
    setError('');
    try {
      await api(`/admin/spots/${id}`, { method: 'PUT', body: { lat, lng } });
      setMovingId(null);
      setHint(null);
      await load();
      setMessage('Pickup spot moved.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteSpot(id) {
    setBusy(true);
    setError('');
    try {
      await api(`/admin/spots/${id}`, { method: 'DELETE' });
      await load();
      setMessage('Pickup spot deleted.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function onMapClick(e) {
    if (adding) addSpot(e);
    else if (movingId) moveSpot(e);
  }

  const markers = (spots || []).map((s) => ({
    lat: s.lat,
    lng: s.lng,
    type: 'spot',
    name: s.name,
    spot: s,
  }));

  return (
    <>
      <p className="subtitle">
        Preset pickup spots are shown as pins to every customer (Book screen) and driver.
        Tap <b>Add spot</b> then the map to drop a new one; <b>Move</b> and the map to
        reposition; type to rename; ✕ deletes.
      </p>
      {message && <p className="success">{message}</p>}
      {error && <p className="error">{error}</p>}

      <div className="map-wrap" style={{ height: '320px', marginBottom: '12px' }}>
        <Map markers={markers} onMapClick={onMapClick} autofitSpots />
      </div>

      <div className="btn-row" style={{ marginBottom: '6px' }}>
        <button className="btn small primary" disabled={busy || adding || movingId != null} onClick={() => { setAdding(true); setMovingId(null); setHint('Tap the map where the new pickup spot is — then give it a name below.'); setMessage(''); setError(''); }}>
          ＋ Add spot
        </button>
        {(adding || movingId != null) && (
          <button className="btn small" onClick={() => { setAdding(false); setMovingId(null); setHint(null); }}>Cancel</button>
        )}
      </div>
      {hint && <p className="hint" style={{ margin: '6px 0', color: 'var(--primary)' }}>{hint}</p>}

      {!spots && <p className="hint">Loading spots…</p>}
      {spots && spots.length === 0 && <p className="hint">No pickup spots yet — tap “Add spot” then the map.</p>}

      {spots && spots.map((s) => (
        <div className="card spots-editor" key={s.id} style={{ padding: '8px 12px', marginTop: '8px' }}>
          <div className="spot-row">
            <input
              className="spot-name"
              value={names[s.id] ?? s.name}
              onChange={(e) => rename(s.id, e.target.value)}
              onBlur={(e) => flushRename(s.id, e.target.value)}
              title="Rename"
            />
            <span className="spot-coords">{s.lat.toFixed(4)}, {s.lng.toFixed(4)}</span>
            <button
              className="btn small"
              disabled={busy || adding || movingId != null}
              onClick={() => { setAdding(false); setMovingId(s.id); setHint(`Tap the map where “${names[s.id] ?? s.name}” should be.`); setMessage(''); setError(''); }}
            >Move</button>
            <button className="btn small danger" title="Delete" disabled={busy} onClick={() => deleteSpot(s.id)}>✕</button>
          </div>
        </div>
      ))}
    </>
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

// Search the full trip ledger by customer name/phone OR driver name/phone.
// Each card expands into the complete audit record (route map, timestamps,
// payment, and the in-trip message thread); a CSV export hands the current
// results to whatever authority you need to assist.
function RecordsTab() {
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState('');
  const [trips, setTrips] = useState(null);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState(null);
  const [openTrip, setOpenTrip] = useState(null);
  const [detailBusy, setDetailBusy] = useState(false);

  async function doSearch(e) {
    if (e) e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set('q', q.trim());
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      if (status) params.set('status', status);
      const res = await api(`/admin/trips/search?${params.toString()}`);
      setTrips(res.trips || []);
      setSearched(true);
      setOpenId(null);
      setOpenTrip(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleDetail(trip) {
    if (openId === trip.id) {
      setOpenId(null);
      setOpenTrip(null);
      return;
    }
    setOpenId(trip.id);
    setDetailBusy(true);
    setError('');
    try {
      const res = await api(`/admin/trips/${trip.id}`);
      setOpenTrip(res.trip || null);
    } catch (err) {
      setError(err.message);
      setOpenId(null);
    } finally {
      setDetailBusy(false);
    }
  }

  function exportCsv() {
    if (!trips || trips.length === 0) return;
    const cols = ['Trip ID', 'Requested (UTC)', 'Status', 'Customer name', 'Customer phone', 'Driver name', 'Driver phone', 'Pickup address', 'Pickup lat', 'Pickup lng', 'Drop-off address', 'Drop-off lat', 'Drop-off lng', 'Distance km', 'Fare (ZAR)', 'Payment method', 'Cancel reason'];
    const rows = trips.map((t) => [
      t.id,
      t.timestamps.requested,
      t.status,
      t.customer?.name || '',
      t.customer?.phone || '',
      t.driver?.name || '',
      t.driver?.phone || '',
      t.pickup?.address || '',
      t.pickup?.lat ?? '',
      t.pickup?.lng ?? '',
      t.destination?.address || '',
      t.destination?.lat ?? '',
      t.destination?.lng ?? '',
      t.distanceKm ?? '',
      t.finalFare ?? t.fareEstimate ?? '',
      t.paymentMethod || '',
      t.cancelReason || '',
    ]);
    const esc = (cell) => `"${String(cell).replace(/"/g, '""')}"`;
    const csv = `\uFEFF${[cols, ...rows].map((r) => r.map(esc).join(',')).join('\n')}`;
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `drivelocal-trips-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      {error && <p className="error">{error}</p>}

      <form className="card form-card" onSubmit={doSearch}>
        <div className="field">
          <span className="field-label">Name or phone</span>
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="e.g. Naledi or +2773…"
            style={{ width: '100%' }}
          />
          <p className="hint">Matches the customer OR the driver — every trip either was part of is returned (including trips that never started).</p>
        </div>

        <div className="field-row" style={{ flexWrap: 'wrap' }}>
          <div className="field" style={{ flex: 1, minWidth: 130 }}>
            <span className="field-label">From</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 130 }}>
            <span className="field-label">To</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <span className="field-label">Status</span>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Any</option>
              <option value="requested">Waiting for driver</option>
              <option value="accepted">Driver en route</option>
              <option value="ongoing">In progress</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
              <option value="scheduled">Scheduled (booked)</option>
            </select>
          </div>
        </div>

        <div className="btn-row" style={{ marginTop: '6px' }}>
          <button className="btn primary" disabled={busy}>{busy ? 'Searching…' : 'Search trips'}</button>
          {trips && trips.length > 0 && (
            <button type="button" className="btn" onClick={exportCsv}>⬇ Export CSV</button>
          )}
        </div>
      </form>

      {searched && trips.length === 0 && (
        <p className="hint" style={{ marginTop: '14px' }}>No trips match that search. Try a different name, phone, or wider date range.</p>
      )}

      {trips && trips.map((t) => (
        <div className="card driver-card" key={t.id} style={{ marginTop: '10px' }}>
          <div className="field-row" style={{ justifyContent: 'space-between', cursor: 'pointer' }} onClick={() => toggleDetail(t)}>
            <div>
              <strong>
                {t.customer?.name || 'Unknown rider'}
                {t.driver ? <> ↔ {t.driver.name || 'Unnamed driver'}</> : <> <span className="hint">— no driver yet</span></>}
              </strong>
              <p className="hint" style={{ margin: '2px 0 0' }}>
                {t.customer?.phone || '—'}
                {t.driver ? ` · ${t.driver.phone || '—'}` : ''} · {fmt(t.timestamps.requested)}
              </p>
            </div>
            <span className={`badge ${tripBadgeClass(t.status)}`}>{tripStatusLabel(t.status)}</span>
          </div>

          <div className="route-line" style={{ marginTop: '8px' }}>
            <div className="route-row"><span className="dot pickup-dot" />{t.pickup.address || 'Pickup'}</div>
            <div className="route-row"><span className="dot dest-dot" />{t.destination.address || 'Destination'}</div>
          </div>
          <p className="hint" style={{ margin: '4px 0 0' }}>
            {t.distanceKm ?? '-'} km · {t.finalFare != null ? formatRand(t.finalFare) : formatRand(t.fareEstimate)} · {t.paymentMethod === 'card' ? '💳 card' : '💵 cash'}
            {t.cancelReason ? ` · Cancelled: ${t.cancelReason}` : ''}
          </p>

          {openId === t.id && (
            <div style={{ marginTop: '12px' }}>
              {detailBusy ? <p className="hint">Loading full record…</p> : openTrip ? <TripAudit trip={openTrip} /> : null}
            </div>
          )}
        </div>
      ))}
    </>
  );
}

// The full audit record for one trip: route on a map, every event timestamp,
// payment details, and the message thread (customer on the left, driver right).
function TripAudit({ trip }) {
  const markers = [];
  const route = [];
  if (trip.pickup?.lat != null && trip.pickup?.lng != null) {
    markers.push({ type: 'home', lat: trip.pickup.lat, lng: trip.pickup.lng, title: 'Pickup' });
  }
  if (trip.destination?.lat != null && trip.destination?.lng != null) {
    markers.push({ type: 'dest', lat: trip.destination.lat, lng: trip.destination.lng, title: 'Drop-off' });
  }
  if (trip.driverLastLocation?.lat != null && trip.driverLastLocation?.lng != null) {
    markers.push({ type: 'driver', lat: trip.driverLastLocation.lat, lng: trip.driverLastLocation.lng, title: 'Driver last fix' });
  }
  if (trip.routePolyline) {
    const decoded = decodePolyline(trip.routePolyline);
    if (decoded && decoded.length >= 2) route.push(...decoded);
  }

  const stamps = [
    ['Requested', trip.timestamps.requested],
    ['Accepted', trip.timestamps.accepted],
    ['Started', trip.timestamps.started],
    ['Completed', trip.timestamps.completed],
    ['Cancelled', trip.timestamps.cancelled],
  ].filter(([, v]) => v);

  const pay = trip.payment;
  const sosAlerts = trip.sosAlerts || [];

  return (
    <div>
      {(markers.length > 0 || route.length >= 2) && (
        <div className="map-wrap" style={{ height: '200px', marginBottom: '12px' }}>
          <Map markers={markers} route={route.length >= 2 ? route : null} />
        </div>
      )}

      <div className="field-row" style={{ flexWrap: 'wrap', gap: 6 }}>
        <span className="badge completed">Customer: {trip.customer?.name || 'Unknown'} · {trip.customer?.phone || '—'}</span>
        <span className="badge ongoing">Driver: {trip.driver?.name || 'None'} · {trip.driver?.phone || '—'}</span>
      </div>

      <p className="hint" style={{ margin: '8px 0 4px' }}>Coordinates</p>
      <p className="hint" style={{ margin: '0 0 8px', fontSize: '0.8rem' }}>
        Pickup {trip.pickup?.lat?.toFixed(5)}, {trip.pickup?.lng?.toFixed(5)}
        {'  ·  '}Drop-off {trip.destination?.lat?.toFixed(5)}, {trip.destination?.lng?.toFixed(5)}
        {trip.driverLastLocation?.lat != null && (
          <>  ·  {'📍'} Driver last fix {trip.driverLastLocation.lat.toFixed(5)}, {trip.driverLastLocation.lng.toFixed(5)} @ {fmt(trip.driverLastLocation.timestamp)}</>
        )}
      </p>

      <div className="field-row" style={{ flexWrap: 'wrap' }}>
        {stamps.map(([label, value]) => (
          <div className="stat-tile" key={label} style={{ padding: '10px' }}>
            <span className="stat-num" style={{ fontSize: '0.82rem' }}>{fmt(value)}</span>
            <span className="stat-label">{label}</span>
          </div>
        ))}
      </div>

      {sosAlerts.length > 0 && (
        <div className="card" style={{ marginTop: '10px', padding: '10px', background: 'var(--danger-soft)', border: '1px solid var(--danger)' }}>
          <p className="hint" style={{ margin: '0 0 4px' }}>
            🆘 Emergency alerts ({sosAlerts.length}) — raised{' '}
            {sosAlerts.every((a) => a.userRole === 'driver') ? 'by the driver' : sosAlerts.every((a) => a.userRole === 'customer') ? 'by the customer' : 'by both the driver and customer'}
          </p>
          {sosAlerts.map((a) => (
            <div key={a.id} style={{ padding: '6px 0', borderTop: '1px solid var(--danger-soft)' }}>
              <strong>{a.userRole === 'driver' ? '🚗' : '🧑'} {a.userName || a.userPhone || 'Unknown'}</strong>
              <span className="hint" style={{ marginLeft: 8 }}>· {fmt(a.createdAt)}</span>
              {a.note && <p style={{ margin: '2px 0 0' }}>{a.note}</p>}
              {a.lat != null && <p className="hint" style={{ margin: '2px 0 0' }}>At {a.lat.toFixed(5)}, {a.lng.toFixed(5)}</p>}
            </div>
          ))}
        </div>
      )}

      {pay && (
        <div className="card" style={{ marginTop: '10px', padding: '10px' }}>
          <p className="hint" style={{ margin: '0 0 4px' }}>Payment</p>
          <p style={{ margin: 0 }}>
            {pay.provider === 'yoco-mock' || !pay.provider ? 'Card (test)' : pay.provider} · {formatRand(pay.amountCents / 100)} · {pay.status}
            {pay.paymentIntentId ? ` · intent ${pay.paymentIntentId}` : ''}
          </p>
          <p className="hint" style={{ margin: '4px 0 0' }}>
            Driver payout {formatRand(pay.driverPayoutCents / 100)} · platform fee {formatRand(pay.platformFeeCents / 100)}
          </p>
        </div>
      )}

      <div className="chat-wrap" style={{ marginTop: '12px' }}>
        <div className="chat-header"><span>Message thread ({trip.messages.length})</span></div>
        <div className="chat-list" style={{ maxHeight: 260 }}>
          {trip.messages.length === 0 && <p className="hint">No messages exchanged during this trip.</p>}
          {trip.messages.map((m) => (
            <div key={m.id} className={`chat-bubble ${m.sender?.role === 'driver' ? 'mine' : 'theirs'}`}>
              <span className="chat-bubble-body">{m.body}</span>
              <span className="chat-bubble-time">
                {m.sender?.role === 'driver' ? '🚗 ' : '🧑 '}{m.sender?.name || '?'} · {new Date(m.createdAt).toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function tripStatusLabel(s) {
  const map = { requested: 'Waiting', accepted: 'En route to you', ongoing: 'In trip', completed: 'Completed', cancelled: 'Cancelled', scheduled: 'Scheduled' };
  return map[s] || s || '—';
}

function tripBadgeClass(s) {
  return ['requested', 'accepted', 'ongoing', 'completed', 'cancelled'].includes(s) ? s : 'requested';
}

function fmt(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const configDefaultFee = 10;