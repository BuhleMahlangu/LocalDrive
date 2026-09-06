import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Map from '../../components/Map.jsx';
import { api, connectSocket, formatRand, toTel, toWhatsApp } from '../../api.js';

export default function Dashboard({ user, onUserUpdate }) {
  const [online, setOnline] = useState(!!user.isOnline);
  const [pending, setPending] = useState(null);
  const [active, setActive] = useState(null);
  const [earnings, setEarnings] = useState(null);
  const [driverLoc, setDriverLoc] = useState(null);
  const [countdown, setCountdown] = useState(10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const socketRef = useRef(null);
  const locInterval = useRef(null);
  const countdownTimer = useRef(null);
  const handledRef = useRef(new Set());
  const pendingIdRef = useRef(null);

  const publishLocation = useCallback((socket) => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const payload = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
        if (socket) socket.emit('driver:location', payload);
        setDriverLoc({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 6000 },
    );
  }, []);

  const refresh = useCallback(() => {
    api('/driver/active-trip').then((r) => setActive(r.trip)).catch(() => {});
    api('/driver/pending-trip').then((r) => {
      const t = r.trip;
      if (t && !handledRef.current.has(t.id)) {
        setPending(t);
        pendingIdRef.current = t.id;
      } else if (!t) {
        setPending(null);
      }
    }).catch(() => {});
    api('/driver/earnings').then(setEarnings).catch(() => {});
  }, []);

  // Socket lifecycle
  useEffect(() => {
    const socket = connectSocket();
    socketRef.current = socket;
    socket.on('connect', () => { if (online) publishLocation(socket); });
    socket.on('trip:request', (data) => {
      if (data?.trip) {
        if (handledRef.current.has(data.trip.id)) return;
        setPending(data.trip);
        pendingIdRef.current = data.trip.id;
        setToast('New booking request received!');
      }
    });
    socket.on('trip:updated', (data) => {
      if (!data?.trip) return;
      const t = data.trip;
      if (t.driverId === user.id) {
        setActive(['accepted', 'ongoing'].includes(t.status) ? t : null);
        refresh();
      }
    });
    return () => { socket.disconnect(); socketRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Location loop when online
  useEffect(() => {
    if (!online) { clearInterval(locInterval.current); return; }
    publishLocation(socketRef.current);
    locInterval.current = setInterval(() => publishLocation(socketRef.current), 3000);
    return () => clearInterval(locInterval.current);
  }, [online, publishLocation]);

  // Poll for state changes
  useEffect(() => {
    refresh();
    const poll = setInterval(refresh, 5000);
    return () => clearInterval(poll);
  }, [refresh]);

  async function autoDecline(tripId) {
    if (!tripId || handledRef.current.has(tripId)) return;
    handledRef.current.add(tripId);
    setPending(null);
    pendingIdRef.current = null;
    setToast('Booking request expired');
    try {
      await api(`/driver/trips/${tripId}/decline`, { method: 'POST', body: { reason: 'Auto-declined (no response)' } });
    } catch {
      /* ignore */
    }
  }

  // 10s auto-decline for unanswered requests
  useEffect(() => {
    if (countdownTimer.current) clearInterval(countdownTimer.current);
    countdownTimer.current = null;
    if (pending?.status === 'requested') {
      pendingIdRef.current = pending.id;
      setCountdown(10);
      countdownTimer.current = setInterval(() => {
        setCountdown((c) => {
          if (c <= 1) {
            clearInterval(countdownTimer.current);
            countdownTimer.current = null;
            autoDecline(pendingIdRef.current);
            return 0;
          }
          return c - 1;
        });
      }, 1000);
    } else {
      setCountdown(10);
    }
    return () => { if (countdownTimer.current) clearInterval(countdownTimer.current); countdownTimer.current = null; };
  }, [pending?.id, pending?.status]);

  async function toggleOnline() {
    const next = !online;
    setBusy(true);
    setError('');
    try {
      const updated = await api('/driver/online', { method: 'POST', body: { isOnline: next } });
      setOnline(!!updated.isOnline);
      onUserUpdate(updated);
      if (socketRef.current) socketRef.current.emit('driver:online', next);
      if (next) { publishLocation(socketRef.current); setToast('You are now online'); }
      else setToast('You are offline');
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function act(action, extra = {}) {
    if (!active) return;
    setBusy(true);
    setError('');
    try {
      const res = await api(`/driver/trips/${active.id}/${action}`, { method: 'POST', body: extra });
      if (res.trip) {
        setActive(['ongoing', 'accepted'].includes(res.trip.status) ? res.trip : null);
        if (res.trip.status === 'completed') setToast('Trip completed!');
      }
      refresh();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function respond(action) {
    if (!pending) return;
    handledRef.current.add(pending.id);
    setBusy(true);
    setError('');
    try {
      const res = await api(`/driver/trips/${pending.id}/${action}`, { method: 'POST' });
      if (res.trip && action === 'accept') setActive(res.trip);
      setPending(null);
      pendingIdRef.current = null;
      refresh();
      setToast(action === 'accept' ? 'Trip accepted' : 'Declined');
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  const mapMarkers = useMemo(() => {
    const m = [];
    if (driverLoc) m.push({ lat: driverLoc.lat, lng: driverLoc.lng, type: 'driver' });
    if (active?.pickup) m.push({ lat: active.pickup.lat, lng: active.pickup.lng, type: 'home' });
    if (active?.destination) m.push({ lat: active.destination.lat, lng: active.destination.lng, type: 'dest' });
    return m;
  }, [driverLoc, active]);

  const mapRoute = useMemo(() => {
    if (active?.pickup && active?.destination) {
      return [[active.pickup.lat, active.pickup.lng], [active.destination.lat, active.destination.lng]];
    }
    return null;
  }, [active]);

  return (
    <div className="screen">
      {toast && <div className="toast">{toast}</div>}
      {error && <p className="error">{error}</p>}

      <div className="online-panel">
        <div className="online-info">
          <h2>You are {online ? 'online' : 'offline'}</h2>
          <p className="subtitle">{online ? 'Customers can see you and book rides' : 'Customers will see "driver unavailable"'}</p>
        </div>
        <label className="switch">
          <input type="checkbox" checked={online} onChange={toggleOnline} disabled={busy} />
          <span className="slider" />
        </label>
      </div>

      {pending && (
        <div className="card request-card">
          <div className="request-head">
            <h2>New booking request</h2>
            <span className="countdown-chip">{countdown}s</span>
          </div>
          <div className="route-line">
            <div className="route-row"><span className="dot pickup-dot" />{pending.pickup?.address || 'Pickup'}</div>
            {pending.pickup?.note && (
              <div className="route-row"><span className="dot" style={{ background: 'transparent' }} />📍 <span className="hint" style={{ margin: 0 }}>{pending.pickup.note}</span></div>
            )}
            <div className="route-row"><span className="dot dest-dot" />{pending.destination?.address || 'Destination'}</div>
            {pending.destination?.note && (
              <div className="route-row"><span className="dot" style={{ background: 'transparent' }} />📍 <span className="hint" style={{ margin: 0 }}>{pending.destination.note}</span></div>
            )}
          </div>
          <p className="hint">{pending.distanceKm ?? '?'} km · est. {formatRand(pending.fareEstimate)}</p>
          {pending.customerName && <p className="hint">Customer: {pending.customerName} · {pending.customerPhone || ''}</p>}
          <div className="btn-row">
            <button className="btn" onClick={() => respond('decline')} disabled={busy}>Decline</button>
            <button className="btn primary" onClick={() => respond('accept')} disabled={busy}>Accept</button>
          </div>
        </div>
      )}

      <div className="map-wrap">
        <Map center={driverLoc || [-26.2155, 29.2916]} markers={mapMarkers} route={mapRoute} />
        <div className="map-status">{online ? '● Live' : '○ Offline'}</div>
      </div>

      {!online && (
        <div className="card hint-card">
          <p>Go online to start receiving booking requests.</p>
        </div>
      )}

      {active && (
        <div className="card active-trip">
          <h3>Active trip</h3>
          <div className="route-line">
            <div className="route-row"><span className="dot pickup-dot" />{active.pickup?.address}</div>
            {active.pickup?.note && <div className="route-row"><span className="dot" style={{ background: 'transparent' }} />📍 <span className="hint" style={{ margin: 0 }}>{active.pickup.note}</span></div>}
            <div className="route-row"><span className="dot dest-dot" />{active.destination?.address}</div>
            {active.destination?.note && <div className="route-row"><span className="dot" style={{ background: 'transparent' }} />📍 <span className="hint" style={{ margin: 0 }}>{active.destination.note}</span></div>}
          </div>
          <p className={`badge ${active.status}`}>{active.status}</p>
          {active.customerName && <p className="hint">Customer: {active.customerName} · {active.customerPhone || ''}</p>}
          {active.customerPhone && (
            <div className="btn-row">
              <a className="btn" href={toTel(active.customerPhone)}>📞 Call</a>
              <a className="btn" href={toWhatsApp(active.customerPhone, 'Hi, I am your DriveLocal driver.')} target="_blank" rel="noreferrer">💬 WhatsApp</a>
            </div>
          )}
          {active.status === 'accepted' && (
            <button className="btn primary" onClick={() => act('start')} disabled={busy}>🚗 Arrived at pickup · Start trip</button>
          )}
          {active.status === 'ongoing' && (
            <button className="btn primary" onClick={() => act('complete', {})} disabled={busy}>✅ Complete trip</button>
          )}
        </div>
      )}

      {earnings && (
        <div className="card earnings">
          <h3>Earnings</h3>
          <div className="earn-row">
            <div className="earn-box"><span className="earn-num">{formatRand(earnings.today)}</span><span className="earn-label">Today</span></div>
            <div className="earn-box"><span className="earn-num">{formatRand(earnings.total)}</span><span className="earn-label">Total</span></div>
            <div className="earn-box"><span className="earn-num">{earnings.completedTrips}</span><span className="earn-label">Trips</span></div>
          </div>
        </div>
      )}
    </div>
  );
}
