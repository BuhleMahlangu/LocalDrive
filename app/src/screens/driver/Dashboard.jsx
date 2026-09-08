import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Map from '../../components/Map.jsx';
import { api, connectSocket, formatRand, toTel, toWhatsApp } from '../../api.js';
import decodePolyline from '../../lib/polyline.js';

const AREA_CENTER = [-26.2155, 29.2916];

export default function Dashboard({ user, onUserUpdate }) {
  const [online, setOnline] = useState(!!user.isOnline);
  const [pending, setPending] = useState(null);
  const [active, setActive] = useState(null);
  const [earnings, setEarnings] = useState(null);
  const [scheduled, setScheduled] = useState([]);
  const [spots, setSpots] = useState([]);
  const [driverLoc, setDriverLoc] = useState(null);
  const [fetchRoute, setFetchRoute] = useState(null);
  const [countdown, setCountdown] = useState(10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [spotEditor, setSpotEditor] = useState(false);
  const [addingSpot, setAddingSpot] = useState(false);
  const [movingSpotId, setMovingSpotId] = useState(null);
  const [spotHint, setSpotHint] = useState(null);
  const [spotNames, setSpotNames] = useState({});
  const socketRef = useRef(null);
  const locInterval = useRef(null);
  const countdownTimer = useRef(null);
  const handledRef = useRef(new Set());
  const pendingIdRef = useRef(null);
  const driverLocRef = useRef(null);
  const activeRef = useRef(null);
  const fetchTimer = useRef(null);
  const renameTimers = useRef({});

  useEffect(() => { driverLocRef.current = driverLoc; }, [driverLoc]);
  useEffect(() => { activeRef.current = active; }, [active]);

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
    api('/driver/scheduled-trips').then((r) => setScheduled(Array.isArray(r.trips) ? r.trips : [])).catch(() => {});
  }, []);

  // Preset pickup spots for the service area — drawn as pins for orientation.
  const refreshSpots = useCallback(() => {
    api('/driver/spots')
      .then((r) => {
        const list = Array.isArray(r.spots) ? r.spots : [];
        setSpots(list);
        setSpotNames((d) => {
          const next = { ...d };
          list.forEach((s) => { if (!next[s.id]) next[s.id] = s.name; });
          return next;
        });
      })
      .catch(() => {});
  }, []);

  useEffect(() => { refreshSpots(); }, [refreshSpots]);

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
    socket.on('trip:scheduled', () => {
      api('/driver/scheduled-trips').then((r) => setScheduled(Array.isArray(r.trips) ? r.trips : [])).catch(() => {});
      setToast('A customer pre-booked a ride for later 🗓️');
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

  // Live "fetch the customer" route (driver -> pickup) while the trip is accepted.
  useEffect(() => {
    async function doFetch() {
      const trip = activeRef.current;
      const loc = driverLocRef.current;
      if (!trip || trip.status !== 'accepted' || !loc || !trip.pickup) return;
      try {
        const r = await api('/driver/route', {
          method: 'POST',
          body: {
            from: { lat: loc.lat, lng: loc.lng },
            to: { lat: trip.pickup.lat, lng: trip.pickup.lng },
          },
        });
        setFetchRoute(r.polyline ? decodePolyline(r.polyline) : [[loc.lat, loc.lng], [trip.pickup.lat, trip.pickup.lng]]);
      } catch {
        // keep the last route if a refresh fails
      }
    }

    if (active?.status === 'accepted') {
      doFetch();
      fetchTimer.current = setInterval(doFetch, 15000);
      return () => {
        clearInterval(fetchTimer.current);
        fetchTimer.current = null;
        setFetchRoute(null);
      };
    }
    setFetchRoute(null);
    return undefined;
  }, [active?.id, active?.status]);

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

  async function activateScheduled(t) {
    setBusy(true);
    setError('');
    try {
      const res = await api(`/driver/trips/${t.id}/activate`, { method: 'POST' });
      if (res.trip && res.trip.status === 'requested') {
        setPending(res.trip);
        pendingIdRef.current = res.trip.id;
        setToast('Scheduled ride is now active — accept it below ✔');
      }
      refresh();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  // ---- Pickup-spot editor ----
  function renameSpot(id, name) {
    setSpotNames((d) => ({ ...d, [id]: name }));
    clearTimeout(renameTimers.current[id]);
    renameTimers.current[id] = setTimeout(() => {
      api(`/driver/spots/${id}`, { method: 'PUT', body: { name } }).catch(() => {});
    }, 700);
  }

  function deleteSpot(id) {
    api(`/driver/spots/${id}`, { method: 'DELETE' })
      .then(() => { refreshSpots(); setToast('Pickup spot deleted'); })
      .catch(() => {});
  }

  function onSpotMapClick(e) {
    if (!spotEditor) return;
    const { lat, lng } = e.latlng;
    if (movingSpotId) {
      api(`/driver/spots/${movingSpotId}`, { method: 'PUT', body: { lat, lng } })
        .then(() => {
          refreshSpots();
          setMovingSpotId(null);
          setSpotHint(null);
          setToast('Pickup spot moved ✔');
        })
        .catch(() => {});
    } else if (addingSpot) {
      api('/driver/spots', { method: 'POST', body: { name: 'New pickup spot', lat, lng } })
        .then(() => {
          refreshSpots();
          setSpotHint(null);
          setToast('Pickup spot added — type a name for it below');
        })
        .catch(() => {});
    }
  }

  function closeSpotEditor() {
    setSpotEditor(false);
    setAddingSpot(false);
    setMovingSpotId(null);
    setSpotHint(null);
    refreshSpots();
  }

  const mapTrip = active || pending;

  const mapMarkers = useMemo(() => {
    const m = [];
    if (driverLoc) m.push({ lat: driverLoc.lat, lng: driverLoc.lng, type: 'driver' });
    spots.forEach((s) => m.push({ lat: s.lat, lng: s.lng, type: 'spot', name: s.name }));
    if (mapTrip?.pickup) m.push({ lat: mapTrip.pickup.lat, lng: mapTrip.pickup.lng, type: 'home' });
    if (mapTrip?.destination) m.push({ lat: mapTrip.destination.lat, lng: mapTrip.destination.lng, type: 'dest' });
    return m;
  }, [driverLoc, mapTrip, spots]);

  // Pickup -> destination, drawn from the real stored polyline when available.
  const driveRoute = useMemo(() => {
    if (!mapTrip?.pickup || !mapTrip?.destination) return null;
    if (mapTrip.routePolyline) return decodePolyline(mapTrip.routePolyline);
    return [[mapTrip.pickup.lat, mapTrip.pickup.lng], [mapTrip.destination.lat, mapTrip.destination.lng]];
  }, [mapTrip]);

  const mapRoutes = useMemo(() => {
    const list = [];
    if (driveRoute) list.push({ points: driveRoute, color: '#3b82f6' });
    if (fetchRoute) list.push({ points: fetchRoute, color: '#22c55e', dashed: true });
    return list;
  }, [driveRoute, fetchRoute]);

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

      <button className="chip-btn spots-toggle" onClick={() => { if (spotEditor) closeSpotEditor(); else setSpotEditor(true); }}>
        📍 {spotEditor ? 'Close spot editor' : 'Manage pickup spots'}
      </button>

      {spotEditor && (
        <div className="card spots-editor">
          <p className="hint">
            Tap <b>Add spot</b> then the map to drop a new pickup point, or tap <b>Move</b> and
            tap the map to set an exact position. Type or tap to rename; ✕ deletes.
          </p>
          {spotHint && <p className="hint" style={{ margin: '6px 0', color: 'var(--primary)' }}>{spotHint}</p>}
          <div className="btn-row">
            <button className="btn small" disabled={addingSpot} onClick={() => { setAddingSpot(true); setMovingSpotId(null); setSpotHint('Tap the map where the new pickup spot is'); }}>
              ＋ Add spot
            </button>
            {(addingSpot || movingSpotId) && (
              <button className="btn small" onClick={() => { setAddingSpot(false); setMovingSpotId(null); setSpotHint(null); }}>Cancel</button>
            )}
          </div>
          {spots.map((s) => (
            <div key={s.id} className="spot-row">
              <input
                className="spot-name"
                value={spotNames[s.id] ?? s.name}
                onChange={(e) => renameSpot(s.id, e.target.value)}
                title="Rename"
              />
              <span className="spot-coords">{s.lat.toFixed(4)}, {s.lng.toFixed(4)}</span>
              <button className="btn small" onClick={() => { setAddingSpot(false); setMovingSpotId(s.id); setSpotHint(`Tap the map to move “${s.name}” precisely`); }}>Move</button>
              <button className="btn small danger" title="Delete" onClick={() => deleteSpot(s.id)}>✕</button>
            </div>
          ))}
        </div>
      )}

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

      {scheduled.length > 0 && (
        <div className="card upcoming-card">
          <h3>🗓️ Upcoming scheduled rides</h3>
          {scheduled.map((t) => (
            <div key={t.id} style={{ margin: '8px 0', paddingTop: '8px', borderTop: '1px dashed var(--border)' }}>
              <span className="upcoming-time">🕐 {formatScheduled(t.scheduledAt)}</span>
              <div className="route-line" style={{ margin: '4px 0' }}>
                <div className="route-row"><span className="dot pickup-dot" />{t.pickup?.address || 'Pickup'}</div>
                <div className="route-row"><span className="dot dest-dot" />{t.destination?.address || 'Destination'}</div>
              </div>
              {t.customerName && <p className="hint">Customer: {t.customerName} · {t.customerPhone || ''}</p>}
              <p className="hint">{t.distanceKm ?? '?'} km · est. {formatRand(t.fareEstimate)}</p>
              <button
                className="activate-btn"
                disabled={busy}
                onClick={() => activateScheduled(t)}
              >
                🚀 Start now
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="map-wrap">
        <Map
          center={AREA_CENTER}
          markers={mapMarkers}
          routes={mapRoutes}
          autofit={!!(mapTrip?.pickup && mapTrip?.destination)}
          onMapClick={spotEditor ? onSpotMapClick : undefined}
        />
        <div className="map-status">{online ? '● Live' : '○ Offline'}</div>
        {spots.length > 0 && !spotEditor && (
          <div className="map-legend"><span className="legend-dot" /> Pickup spots</div>
        )}
        {spotEditor && (
          <div className="map-status edit-flag">{addingSpot ? 'Tap the map to drop a new spot' : movingSpotId ? 'Tap the map where the spot should be' : 'Add / move / rename spots'}</div>
        )}
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
          <div className="take-home">
            <span className="estimate-amount">{formatRand(earnings.total)}</span>
            <span className="estimate-detail">all-time take-home · {earnings.completedTrips} trips</span>
          </div>
          <div className="earn-row">
            <div className="earn-box"><span className="earn-num">{formatRand(earnings.today)}</span><span className="earn-label">Today</span></div>
            <div className="earn-box"><span className="earn-num">{formatRand(earnings.week)}</span><span className="earn-label">This week</span></div>
            <div className="earn-box"><span className="earn-num">{formatRand(earnings.averageFare)}</span><span className="earn-label">Avg / trip</span></div>
          </div>
          <div className="stats-grid" style={{ marginTop: '10px' }}>
            <div className="stat-tile"><span className="stat-num">{formatRand(earnings.tipsTotal)}</span><span className="stat-label">Tips</span></div>
            <div className="stat-tile"><span className="stat-num">{earnings.averageRating != null ? `★ ${earnings.averageRating.toFixed(1)}` : '—'}</span><span className="stat-label">Avg rating</span></div>
            <div className="stat-tile"><span className="stat-num">{earnings.weeklyTrips ?? earnings.completedTrips}</span><span className="stat-label">Rides this week</span></div>
            <div className="stat-tile"><span className="stat-num">{scheduled.length}</span><span className="stat-label">Upcoming</span></div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatScheduled(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
