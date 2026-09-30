import React, { useEffect, useMemo, useRef, useState } from 'react';
import Map from '../../components/Map.jsx';
import { api, formatRand } from '../../api.js';
import decodePolyline from '../../lib/polyline.js';
import { etaMinutes } from '../../lib/geo.js';

// Public, no-login page for a shared trip link (/trip/:id). Polls the public
// endpoint so friends/family can watch the driver live on the map.
export default function TripTracker({ tripId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [fatal, setFatal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [following, setFollowing] = useState(true);
  // Drives the "reconnecting" strip; separate from `error`, which is fatal.
  const [stale, setStale] = useState(false);
  // Read inside the poll loop to decide whether an error is worth showing;
  // a ref keeps the effect from re-subscribing on every data update. Synced in
  // an effect (never during render) so React can discard speculative renders.
  const dataRef = useRef(null);
  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  useEffect(() => {
    let live = true;
    let timer = null;
    let stopped = false;
    // Consecutive failures, used to back off so a long outage does not hammer
    // the API on every tick.
    let failures = 0;

    // Returns true when polling should continue, false once it has stopped.
    async function poll() {
      try {
        const d = await api(`/public/trips/${tripId}/live`, {});
        if (!live) return false;
        setData(d);
        setError('');
        setStale(false);
        setFatal(false);
        setLoading(false);
        failures = 0;
        return true;
      } catch (e) {
        if (!live) return false;
        // A 4xx means the link itself is wrong (bad/expired trip), so retrying
        // cannot help. Network failures and 5xx are transient: keep polling
        // with a backoff instead of permanently abandoning the tracker.
        const status = e?.status;
        const transient = !status || status >= 500;
        if (!transient) {
          setFatal(true);
          setError(e.message || 'Trip not found');
          setLoading(false);
          stopped = true;
          return false;
        }
        failures += 1;
        setStale(true);
        if (!dataRef.current) {
          setError(e.message || 'Connection problem');
          setLoading(false);
        }
        return true;
      }
    }

    // setTimeout chaining (not setInterval) so a slow request can never overlap
    // the next tick, and so backoff is expressible.
    const schedule = (ms) => {
      if (!live || stopped) return;
      timer = setTimeout(async () => {
        const keepGoing = await poll();
        // A fatal 4xx must not reschedule itself, otherwise the tracker retries
        // a permanently broken link every tick forever.
        if (live && keepGoing) schedule(failures > 0 ? Math.min(15000, 4000 * failures) : 4000);
      }, ms);
    };

    poll().then((keepGoing) => {
      if (live && keepGoing) schedule(4000);
    });
    return () => { live = false; clearTimeout(timer); };
  }, [tripId]);

  const markers = useMemo(() => {
    if (!data) return [];
    const m = [];
    if (data.driverLoc) {
      m.push({
        lat: data.driverLoc.lat,
        lng: data.driverLoc.lng,
        type: 'driver',
        heading: data.driverLoc.heading ?? null,
      });
    }
    if (data.pickup) m.push({ lat: data.pickup.lat, lng: data.pickup.lng, type: 'home' });
    if (data.destination) m.push({ lat: data.destination.lat, lng: data.destination.lng, type: 'dest' });
    return m;
  }, [data]);

  const route = useMemo(() => (data?.polyline ? decodePolyline(data.polyline) : null), [data]);

  const etaMin = useMemo(() => {
    if (!data?.driverLoc || !data?.pickup || data.status !== 'accepted') return null;
    return etaMinutes(data.driverLoc, data.pickup);
  }, [data]);

  // There is nobody left to follow once the trip ends or is called off.
  const followDriver = data?.driverLoc && ['accepted', 'ongoing'].includes(data.status) ? 'driver' : null;

  if (loading && !data && !fatal) {
    return (
      <div className="screen center">
        <p className="hint">Loading trip tracker…</p>
      </div>
    );
  }

  // Only a 4xx (or a response we could never parse) means the trip is truly
  // unavailable. A dropped connection keeps retrying, so it must not be shown
  // as "this trip does not exist".
  if (fatal || !data) {
    return (
      <div className="screen center">
        <p className="hint">{fatal ? error || 'This trip is not available or has ended.' : 'Connecting…'}</p>
        {fatal
          ? <p className="hint" style={{ marginTop: 4 }}>Ask the person who shared it to send a fresh link.</p>
          : <p className="hint" style={{ marginTop: 4 }}>Check your connection — retrying automatically.</p>}
      </div>
    );
  }

  return (
    <div className="screen tracker-screen">
      <div className="tracker-head">
        <img src="/logo-horizontal.png" alt="DriveLocal" className="tracker-logo" />
        <span className={`badge ${data.status}`}>{data.status}</span>
      </div>

      <div className="card tracker-route">
        <div className="route-line">
          <div className="route-row"><span className="dot pickup-dot" />{data.pickup.address || 'Pickup'}</div>
          {data.pickup.note && <div className="route-row"><span className="dot" style={{ background: 'transparent' }} />📍 <span className="hint" style={{ margin: 0 }}>{data.pickup.note}</span></div>}
          <div className="route-row"><span className="dot dest-dot" />{data.destination.address || 'Destination'}</div>
          {data.destination.note && <div className="route-row"><span className="dot" style={{ background: 'transparent' }} />📍 <span className="hint" style={{ margin: 0 }}>{data.destination.note}</span></div>}
        </div>

        {data.status === 'accepted' && data.driverLoc && (
          <p className="hint">🚗 Arriving in ≈ {etaMin} min{data.driver?.vehicleType ? ` · ${data.driver.vehicleType}` : ''}</p>
        )}
        {data.status === 'ongoing' && <p className="hint">Trip in progress — tracking live{data.driver?.vehicleType ? ` · ${data.driver.vehicleType}` : ''}</p>}
        {data.status === 'requested' && <p className="hint">Waiting for the driver to accept…</p>}
        {data.status === 'completed' && <p className="hint">Trip complete · {formatRand(data.finalFare ?? data.fareEstimate)}</p>}
        {data.status === 'cancelled' && <p className="hint">This trip was cancelled.</p>}

        {data.driver?.name && <p className="hint" style={{ marginTop: 4 }}>Driver: {data.driver.name}{data.driver.licensePlate ? ` · ${data.driver.licensePlate}` : ''}</p>}
      </div>

      <div className="map-wrap tall">
        <Map
          center={data.pickup ? [data.pickup.lat, data.pickup.lng] : undefined}
          markers={markers}
          route={route}
          follow={followDriver}
          onFollowChange={setFollowing}
          locateControl
        />
        {followDriver && !following && (
          <div className="map-status">Tap 🎯 to follow the driver again</div>
        )}
        {stale && (
          <div className="map-status gps-warning" role="status">Reconnecting…</div>
        )}
      </div>

      <p className="hint tracker-foot">Live tracking · DriveLocal</p>
    </div>
  );
}