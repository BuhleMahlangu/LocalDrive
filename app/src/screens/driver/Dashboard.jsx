import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Map from '../../components/Map.jsx';
import Skeleton from '../../components/Skeleton.jsx';
import Chat from '../../components/Chat.jsx';
import { api, connectSocket, formatRand, toTel, toWhatsApp } from '../../api.js';
import decodePolyline from '../../lib/polyline.js';
import { playRequestChime, playSuccessChime } from '../../lib/alert.js';
import { sendSos } from '../../lib/emergency.js';

const AREA_CENTER = [-26.2155, 29.2916];

export default function Dashboard({ user, onUserUpdate }) {
  const [online, setOnline] = useState(!!user.isOnline);
  const [pending, setPending] = useState(null);
  const [active, setActive] = useState(null);
  const [earnings, setEarnings] = useState(null);
  const [wallet, setWallet] = useState(null);
  const [scheduled, setScheduled] = useState([]);
  const [spots, setSpots] = useState([]);
  const [driverLoc, setDriverLoc] = useState(null);
  const [fetchRoute, setFetchRoute] = useState(null);
  const [countdown, setCountdown] = useState(10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  // Full-screen takeover for an incoming request so it can't be missed.
  const [showOverlay, setShowOverlay] = useState(false);
  const [spotEditor, setSpotEditor] = useState(false);
  const [addingSpot, setAddingSpot] = useState(false);
  const [movingSpotId, setMovingSpotId] = useState(null);
  const [spotHint, setSpotHint] = useState(null);
  const [spotNames, setSpotNames] = useState({});
  const socketRef = useRef(null);
  const [socket, setSocket] = useState(null);
  const watchRef = useRef(null);
  const countdownTimer = useRef(null);
  const handledRef = useRef(new Set());
  const alertedRef = useRef(new Set());
  const pendingIdRef = useRef(null);
  const driverLocRef = useRef(null);
  const activeRef = useRef(null);
  const fetchTimer = useRef(null);
  const renameTimers = useRef({});
  // Track GPS positions during an ongoing trip for actual distance calculation.
  const tripLocs = useRef([]);
  const tripStart = useRef(null);

  useEffect(() => { driverLocRef.current = driverLoc; }, [driverLoc]);
  useEffect(() => { activeRef.current = active; }, [active]);

  const publishLocation = useCallback((socket) => {
    if (!navigator.geolocation) return;
    // Already streaming fixes — nothing to do.
    if (watchRef.current != null) return;
    // watchPosition streams fixes continuously (rather than hammering
    // getCurrentPosition every 3s): fewer timeouts, lower battery, and it
    // keeps updating even on a desktop whose location drifts.
    watchRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        const payload = { lat: latitude, lng: longitude, accuracy };
        if (socket) socket.emit('driver:location', payload);
        setDriverLoc({ lat: latitude, lng: longitude });
        // Record GPS fixes during an ongoing trip for actual distance tracking.
        if (activeRef.current?.status === 'ongoing') {
          tripLocs.current.push({ lat: latitude, lng: longitude, t: Date.now() });
        }
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 },
    );
  }, []);

  const stopWatch = useCallback(() => {
    if (watchRef.current != null) {
      navigator.geolocation.clearWatch(watchRef.current);
      watchRef.current = null;
    }
  }, []);

  const surfaceRequest = useCallback((t) => {
    if (!t || handledRef.current.has(t.id)) return;
    setPending(t);
    pendingIdRef.current = t.id;
    if (!alertedRef.current.has(t.id)) {
      alertedRef.current.add(t.id);
      playRequestChime();
      setShowOverlay(true);
    }
  }, []);

  const refresh = useCallback(() => {
    api('/driver/active-trip').then((r) => setActive(r.trip)).catch(() => {});
    api('/driver/pending-trip').then((r) => {
      const t = r.trip;
      if (t) {
        surfaceRequest(t);
      } else {
        setPending(null);
      }
    }).catch(() => {});
    api('/driver/earnings').then(setEarnings).catch(() => {});
    api('/driver/wallet').then((r) => setWallet(r.wallet)).catch(() => {});
    api('/driver/scheduled-trips').then((r) => setScheduled(Array.isArray(r.trips) ? r.trips : [])).catch(() => {});
  }, [surfaceRequest]);

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
    setSocket(socket);
    socket.on('connect', () => {
      if (!online) return;
      // Re-emit the last known fix so the server records it on the new socket;
      // the watchPosition stream keeps feeding fresh ones afterwards.
      const last = driverLocRef.current;
      if (last) socket.emit('driver:location', { ...last, accuracy: last.accuracy });
      publishLocation(socket);
    });
    socket.on('trip:request', (data) => {
      if (data?.trip) {
        surfaceRequest(data.trip);
        setToast('New booking request received!');
      }
    });
    // Another driver claimed the request — clear it here so the overlay/card
    // doesn't linger after a losed accept race.
    socket.on('trip:request:taken', (data) => {
      if (!data?.tripId) return;
      handledRef.current.add(data.tripId);
      if (pendingIdRef.current === data.tripId) {
        setPending(null);
        pendingIdRef.current = null;
      }
      setShowOverlay(false);
      refresh();
    });
    socket.on('trip:scheduled', () => {
      api('/driver/scheduled-trips').then((r) => setScheduled(Array.isArray(r.trips) ? r.trips : [])).catch(() => {});
      setToast('A customer pre-booked a ride for later 🗓️');
    });
    socket.on('trip:updated', (data) => {
      if (!data?.trip) return;
      const t = data.trip;
      if (t.driverId !== user.id) return;
      setActive((prev) => {
        if (['accepted', 'ongoing'].includes(t.status)) return t;
        if (prev && t.id === prev.id) return null;
        return prev;
      });
      refresh();
    });
    return () => { socket.disconnect(); socketRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Start/stop the location stream when going online/offline.
  useEffect(() => {
    if (!online) {
      stopWatch();
      return;
    }
    publishLocation(socketRef.current);
    return () => stopWatch();
  }, [online, publishLocation, stopWatch]);

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

  // Reset GPS trip tracking when a trip transitions to ongoing.
  useEffect(() => {
    if (active?.status === 'ongoing') {
      tripLocs.current = [];
      tripStart.current = Date.now();
    }
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
    setShowOverlay(false);
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
      let body = extra;
      if (action === 'complete') {
        // Calculate actual distance and duration from tracked GPS fixes.
        let actualDistanceKm = 0;
        for (let i = 1; i < tripLocs.current.length; i++) {
          actualDistanceKm += haversine(tripLocs.current[i - 1], tripLocs.current[i]);
        }
        const actualDurationMin = tripStart.current
          ? Math.round((Date.now() - tripStart.current) / 60000)
          : undefined;
        body = {
          ...extra,
          actualDistanceKm: actualDistanceKm > 0 ? Math.round(actualDistanceKm * 100) / 100 : undefined,
          actualDurationMin,
        };
        tripLocs.current = [];
        tripStart.current = null;
      }
      const res = await api(`/driver/trips/${active.id}/${action}`, { method: 'POST', body });
      if (res.trip) {
        setActive(['ongoing', 'accepted'].includes(res.trip.status) ? res.trip : null);
        if (res.trip.status === 'completed') setToast('Trip completed!');
      }
      refresh();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function cancelTrip() {
    if (!active || !['accepted', 'ongoing'].includes(active.status)) return;
    setBusy(true);
    setError('');
    try {
      const res = await api(`/driver/trips/${active.id}/cancel`, { method: 'POST', body: { reason: 'Cancelled by driver' } });
      if (res.trip) {
        setActive(null);
        setToast('Trip cancelled');
      }
      refresh();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function sos() {
    if (!active) return;
    setError('');
    try {
      // Records the alert against this trip and pings the platform owner
      // (real-time + SMS) — the customer-facing flow shares WhatsApp too.
      await sendSos({ tripId: active.id, note: '🚨 SOS — the driver needs help right now!' });
      setToast('SOS sent to the platform owner');
    } catch (e) { setError(e.message); }
  }

  async function respond(action) {
    if (!pending) return;
    handledRef.current.add(pending.id);
    setBusy(true);
    setError('');
    setShowOverlay(false);
    try {
      const res = await api(`/driver/trips/${pending.id}/${action}`, { method: 'POST' });
      if (res.trip && action === 'accept') {
        setActive(res.trip);
        playSuccessChime();
      }
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
      // Activating a scheduled ride claims it for this driver (multi-driver
      // platform) — it becomes an accepted in-progress trip right away.
      const res = await api(`/driver/trips/${t.id}/activate`, { method: 'POST' });
      if (res.trip && res.trip.status === 'accepted') {
        setActive(res.trip);
        setToast('Scheduled ride claimed — start when the customer is in ✔');
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

      {showOverlay && pending && (
        <div className="request-overlay">
          <div className="overlay-card">
            <div className="overlay-head">
              <h2>🔔 New booking request</h2>
              <span className="countdown-chip big-chip">{countdown}s</span>
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
            {pending.customerName && <p className="hint">Customer: {pending.customerName}{pending.customerPhone ? ` · ${pending.customerPhone}` : ''}</p>}
            {pending.customerPhone && (
              <div className="btn-row">
                <a className="btn small" href={toTel(pending.customerPhone)}>📞 Call</a>
                <a className="btn small" href={toWhatsApp(pending.customerPhone, 'Hi, I am your DriveLocal driver on the way.')} target="_blank" rel="noreferrer">💬 WhatsApp</a>
              </div>
            )}
            <div className="btn-row overlay-actions">
              <button className="btn" onClick={() => respond('decline')} disabled={busy}>Decline</button>
              <button className="btn primary big" onClick={() => respond('accept')} disabled={busy}>Accept ride</button>
            </div>
            <p className="hint overlay-tip">Auto-declines in {countdown}s if you don't respond</p>
          </div>
        </div>
      )}

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
          {active.status === 'accepted' && !active.arrivedAt && (
            <button className="btn primary" onClick={() => act('arrive')} disabled={busy}>🛑 I've arrived at pickup</button>
          )}
          {active.status === 'accepted' && active.arrivedAt && (
            <button className="btn primary" onClick={() => act('start')} disabled={busy}>🚗 Customer in · Start trip</button>
          )}
          {active.status === 'ongoing' && (
            <button className="btn primary" onClick={() => act('complete', {})} disabled={busy}>✅ Complete trip</button>
          )}
          {(active.status === 'accepted' || active.status === 'ongoing') && (
            <Chat tripId={active.id} socket={socket} label="💬 Message your customer" />
          )}
          {(active.status === 'accepted' || active.status === 'ongoing') && (
            <button className="btn danger" onClick={cancelTrip} disabled={busy} style={{ marginTop: '6px' }}>Cancel trip</button>
          )}
          {(active.status === 'accepted' || active.status === 'ongoing') && (
            <button className="sos-btn" onClick={sos} disabled={busy} title="Emergency — notifies the platform owner immediately">🆘 SOS</button>
          )}
        </div>
      )}

      {earnings ? (
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
      ) : (
        <Skeleton card lines={4} />
      )}

      {wallet && (
        <div className="card earnings">
          <h3>Wallet</h3>
          <div className="earn-row">
            <div className="earn-box"><span className="earn-num">{formatRand((wallet.availableCents || 0) / 100)}</span><span className="earn-label">Ready to withdraw</span></div>
            <div className="earn-box"><span className="earn-num">{formatRand((wallet.owedCents || 0) / 100)}</span><span className="earn-label">Owed to platform</span></div>
          </div>
          <p className="hint">Card trips pay into this wallet; cash trips add a platform fee you owe. Payouts are coming soon.</p>
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

function haversine(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la = (a.lat * Math.PI) / 180;
  const lb = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
