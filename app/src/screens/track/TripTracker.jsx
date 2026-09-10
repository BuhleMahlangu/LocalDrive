import React, { useEffect, useMemo, useState } from 'react';
import Map from '../../components/Map.jsx';
import { api, formatRand } from '../../api.js';
import decodePolyline from '../../lib/polyline.js';

// Public, no-login page for a shared trip link (/trip/:id). Polls the public
// endpoint so friends/family can watch the driver live on the map.
export default function TripTracker({ tripId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    async function poll() {
      try {
        const d = await api(`/public/trips/${tripId}/live`, {});
        if (live) {
          setData(d);
          setError('');
          setLoading(false);
        }
      } catch (e) {
        if (live) {
          setError(e.message || 'Trip not found');
          setLoading(false);
        }
        clearInterval(timer);
      }
    }
    poll();
    const timer = setInterval(poll, 4000);
    return () => { live = false; clearInterval(timer); };
  }, [tripId]);

  const markers = useMemo(() => {
    if (!data) return [];
    const m = [];
    if (data.driverLoc) m.push({ lat: data.driverLoc.lat, lng: data.driverLoc.lng, type: 'driver' });
    if (data.pickup) m.push({ lat: data.pickup.lat, lng: data.pickup.lng, type: 'home' });
    if (data.destination) m.push({ lat: data.destination.lat, lng: data.destination.lng, type: 'dest' });
    return m;
  }, [data]);

  const route = useMemo(() => (data?.polyline ? decodePolyline(data.polyline) : null), [data]);

  const etaMin = useMemo(() => {
    if (!data?.driverLoc || !data?.pickup || data.status !== 'accepted') return null;
    return Math.max(1, Math.round(haversineKm(data.driverLoc, data.pickup) * 2 + 5));
  }, [data]);

  if (loading && !data && !error) {
    return (
      <div className="screen center">
        <p className="hint">Loading trip tracker…</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="screen center">
        <p className="hint">This trip is not available or has ended.</p>
        <p className="hint" style={{ marginTop: 4 }}>Ask the person who shared it to send a fresh link.</p>
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
        <Map center={data.pickup ? [data.pickup.lat, data.pickup.lng] : undefined} markers={markers} route={route} />
      </div>

      <p className="hint tracker-foot">Live tracking · DriveLocal</p>
    </div>
  );
}

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}