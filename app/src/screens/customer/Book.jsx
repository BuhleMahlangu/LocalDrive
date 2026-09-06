import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Map from '../../components/Map.jsx';
import { api, formatRand, toTel, toWhatsApp } from '../../api.js';
import geolocate from '../../lib/geolocate.js';

// The app serves the Kriel / Thubelihle area (Mpumalanga, South Africa), where
// many places don't have usable street names. Map centre defaults to that area
// and the flow is built around landmarks + a free-text "describe this place" note
// so the customer and driver can find each other easily.
const AREA_CENTER = { lat: -26.2155, lng: 29.2916 }; // Thubelihle, Kriel
// Live driver phone (the owner) so customers can call/WhatsApp directly.
const DRIVER_PHONE = import.meta.env.VITE_DRIVER_PHONE || '+27000000000';
const DRIVER_VEHICLE = 'Chevrolet Spark LT';
const DRIVER_PLATE = 'XX 000 XX';

// Common landmarks used to describe informal places / drop a pin quickly.
const LANDMARKS = [
  { label: 'Taxi rank', icon: '🚐' },
  { label: 'Shop', icon: '🏪' },
  { label: 'Clinic', icon: '🏥' },
  { label: 'School', icon: '🏫' },
  { label: 'Church', icon: '⛪' },
  { label: 'Corner', icon: '🔻' },
];

export default function Book({ onBack, onRequest, presetDest }) {
  const [pickup, setPickup] = useState(null);
  const [dest, setDest] = useState(presetDest || null);
  const [pickupNote, setPickupNote] = useState('');
  const [destNote, setDestNote] = useState(
    presetDest?.note || (presetDest ? '' : ''),
  );
  const [estimate, setEstimate] = useState(null);
  const [route, setRoute] = useState(null);
  const [loading, setLoading] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState(false);
  const [error, setError] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [cardEnabled, setCardEnabled] = useState(false);
  const [pickupLandmark, setPickupLandmark] = useState(null);
  const [destLandmark, setDestLandmark] = useState(null);
  // Which pin a map tap should set / re-adjust: 'pickup' or 'destination'.
  const [activePin, setActivePin] = useState('destination');

  // For re-booking, show a hint that the destination is pre-set.
  const isRebook = !!presetDest && !!dest;

  // We intentionally do NOT auto-request location on mount. Browsers require a
  // user gesture to show the location permission prompt for the first time; an
  // on-load getCurrentPosition is silently skipped or denied. So the pickup
  // stays empty until the customer taps the 🎯 button (or drops a pin), at which
  // point we take a precise, verified burst of fixes.
  const doLocate = useCallback(() => {
    setLocating(true);
    setError('');
    geolocate()
      .then(({ lat, lng, accuracy }) => {
        setPickup({ lat, lng, accuracy, address: 'Current location', note: '' });
        setLocateError(false);
      })
      .catch((err) => {
        setLocateError(true);
        setError(geoMessage(err?.message));
      })
      .finally(() => setLocating(false));
  }, []);

  // Card payments only work when Yoco is configured on the server; otherwise
  // offer cash only so the customer can't pick an option that will fail later.
  useEffect(() => {
    api('/payments/config')
      .then((cfg) => setCardEnabled(!!cfg.enabled))
      .catch(() => setCardEnabled(false));
  }, []);

  // When a landmark is chosen, use it as the human description. If a pin isn't
  // placed yet we only fill in the description — we do NOT drop a pin for the
  // customer, because any guessed spot (e.g. the map centre) would be wrong and
  // skew the fare and the pickup. The customer places the pin by tapping the map.
  const applyLandmark = useCallback((type, lm) => {
    const label = `${lm.icon} ${lm.label}`;
    if (type === 'pickup') {
      setPickupLandmark(lm.label);
      setPickupNote((n) => n || label);
      setPickup((p) => (p ? { ...p, address: label } : p));
    } else {
      setDestLandmark(lm.label);
      setDestNote((n) => n || label);
      setDest((d) => (d ? { ...d, address: label } : d));
    }
  }, []);

  // Recompute estimate + route when both points exist / change.
  useEffect(() => {
    if (!pickup || !dest) {
      setEstimate(null);
      setRoute(null);
      return;
    }
    setLoading(true);
    setError('');
    api('/customer/estimate', {
      method: 'POST',
      body: {
        pickup,
        destination: dest,
      },
    })
      .then((res) => {
        setEstimate(res.estimate);
        if (res.route?.polyline) {
          setRoute(decodePolyline(res.route.polyline));
        } else {
          setRoute([[pickup.lat, pickup.lng], [dest.lat, dest.lng]]);
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [pickup, dest]);

  // Tapping the map sets / re-adjusts whichever pin is active. This lets the
  // customer fix a wrongly-placed pickup or destination by tapping again.
  const onMapClick = useCallback((e) => {
    const { lat, lng } = e.latlng;
    if (activePin === 'pickup') {
      setPickup({ lat, lng, address: pickup?.address && !pickup.address.startsWith('Current location') ? pickup.address : 'Current location', note: pickupNote });
    } else {
      // Moving the destination: clear the stale label; the note field holds the
      // human description and confirm() fills in a sensible address.
      setDest({ lat, lng, address: '', note: destNote });
    }
  }, [activePin, pickup, pickupNote, destNote]);

  function locatePickup(e) {
    e.stopPropagation();
    doLocate();
  }

  function confirm() {
    if (!pickup || !dest) return;
    setLoading(true);
    setError('');
    const payload = {
      pickup: {
        ...pickup,
        address: pickup.address || 'Pickup',
        note: pickupNote.trim() || pickup.address || null,
      },
      destination: {
        ...dest,
        address: dest.address || 'Destination',
        note: destNote.trim() || dest.address || null,
      },
      priceModel: 'distance_time',
      paymentMethod,
    };
    api('/customer/trips', { method: 'POST', body: payload })
      .then((res) => onRequest(res.trip))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  const markers = useMemo(() => {
    const m = [];
    if (pickup) m.push({ lat: pickup.lat, lng: pickup.lng, type: 'home', accuracy: pickup.accuracy });
    if (dest) m.push({ lat: dest.lat, lng: dest.lng, type: 'dest' });
    return m;
  }, [pickup, dest]);

  // Keep the map centred on the whole Kriel / Thubelihle service area so the
  // customer can see the surroundings when placing pins. Autofit frames the
  // route once both pins are down.
  const mapCenter = [AREA_CENTER.lat, AREA_CENTER.lng];

  const gpsPin = (p) => `${Number(p.lat).toFixed(6)},${Number(p.lng).toFixed(6)}`;

  return (
    <div className="screen">
      <div className="book-header">
        <button className="link-btn" onClick={onBack}>‹ Back</button>
        <h1>Book a ride</h1>
      </div>

      <div className="no-street-hint">
        No street names? No problem. Drop a pin and <b>describe the spot</b> below so
        your driver can find it exactly.
      </div>

      <div className="card">
        <label className="field">
          <span className="field-label">Pickup — where the driver picks you up</span>
          <div className="field-row">
            <input
              value={pickup?.address || ''}
              placeholder={locating ? 'Detecting location…' : 'Tap 🎯 or the map to set pickup'}
              readOnly
            />
            <button type="button" className="btn small" onClick={locatePickup} title="Use my current location">🎯</button>
          </div>
          {locateError && !locating && (
            <p className="hint" style={{ margin: '4px 0 0' }}>Tap the map to drop a pin for your pickup instead.</p>
          )}
          {!locateError && pickup?.accuracy != null && (
            <p className="hint" style={{ margin: '4px 0 0' }}>
              {locating ? 'Finding precise location…' : `GPS accuracy ±${Math.round(pickup.accuracy)} m${pickup.accuracy > 40 ? ' — tap the map to fine-tune' : ''}`}
            </p>
          )}

          <div className="landmark-row">
            {LANDMARKS.map((lm) => (
              <button
                key={lm.label}
                type="button"
                className={`landmark-chip ${pickupLandmark === lm.label ? 'on' : ''}`}
                onClick={() => applyLandmark('pickup', lm)}
              >
                {lm.icon} {lm.label}
              </button>
            ))}
          </div>

          <textarea
            className="place-note"
            rows={2}
            placeholder="Describe how to find this spot (e.g. opposite the red shop, next to the big tree, near the water tank)…"
            value={pickupNote}
            onChange={(e) => setPickupNote(e.target.value)}
          />
          {pickup && (
            <div className="gps-link-row">
              <input readOnly value={gpsPin(pickup)} />
              <a
                className="btn small"
                href={`https://www.google.com/maps?q=${pickup.lat},${pickup.lng}`}
                target="_blank"
                rel="noreferrer"
              >📍 Map</a>
            </div>
          )}
        </label>
      </div>

      <div className="card">
        <label className="field">
          <span className="field-label">
            Destination — where you're going
            {dest && !isRebook ? ' · tap map to move pin' : ''}
            {isRebook ? ' · from last ride' : ''}
          </span>
          <input
            value={dest?.address || ''}
            placeholder={isRebook ? 'Destination set — tap map fine to adjust' : 'Tap the map to set your destination'}
            readOnly
          />

          <div className="landmark-row">
            {LANDMARKS.map((lm) => (
              <button
                key={lm.label}
                type="button"
                className={`landmark-chip ${destLandmark === lm.label ? 'on' : ''}`}
                onClick={() => applyLandmark('dest', lm)}
              >
                {lm.icon} {lm.label}
              </button>
            ))}
          </div>

          <textarea
            className="place-note"
            rows={2}
            placeholder="Describe the destination (e.g. the house with the white gate, opposite the tavern)…"
            value={destNote}
            onChange={(e) => setDestNote(e.target.value)}
          />
          {dest && (
            <div className="gps-link-row">
              <input readOnly value={gpsPin(dest)} />
              <a
                className="btn small"
                href={`https://www.google.com/maps?q=${dest.lat},${dest.lng}`}
                target="_blank"
                rel="noreferrer"
              >📍 Map</a>
            </div>
          )}
        </label>
      </div>

      <div className="card" style={{ margin: '14px 0' }}>
        <h3>🚗 Your driver: {DRIVER_VEHICLE}</h3>
        <p className="hint" style={{ margin: '4px 0 8px' }}>Registration {DRIVER_PLATE} · Your trusted DriveLocal driver</p>
        <div className="btn-row">
          <a className="btn small" href={toTel(DRIVER_PHONE)}>📞 Call {DRIVER_PHONE}</a>
          <a className="btn small" href={toWhatsApp(DRIVER_PHONE, 'Hi, I need help with my DriveLocal booking.')} target="_blank" rel="noreferrer">💬 WhatsApp</a>
        </div>
      </div>

      <div className="map-wrap">
        {/* Pin flow: choose which pin the next tap places / re-adjusts. */}
        <div className="pin-mode">
          <button
            type="button"
            className={`pin-mode-btn ${activePin === 'pickup' ? 'on pickup' : ''}`}
            onClick={(e) => { e.stopPropagation(); setActivePin('pickup'); }}
          >
            📍 Pickup {pickup ? '· tap map to adjust' : ''}
          </button>
          <button
            type="button"
            className={`pin-mode-btn ${activePin === 'destination' ? 'on dest' : ''}`}
            onClick={(e) => { e.stopPropagation(); setActivePin('destination'); }}
          >
            🎯 Destination {dest ? '· tap map to adjust' : ''}
          </button>
        </div>

        <Map center={mapCenter} markers={markers} route={route} onMapClick={onMapClick} />
        {!dest && activePin === 'destination' ? (
          <div className="map-overlay">Tap the map to drop your destination pin</div>
        ) : activePin === 'pickup' ? (
          <div className="map-overlay">Tap the map to set / fix your pickup spot</div>
        ) : (
          <div className="map-status">Tap the map to move the {activePin === 'pickup' ? 'pickup' : 'destination'} pin</div>
        )}
      </div>

      <div className="estimate-bar">
        {error && <p className="error">{error}</p>}
        {estimate ? (
          <div className="estimate-inner">
            <div>
              <span className="estimate-amount">{formatRand(estimate.total)}</span>
              <span className="estimate-detail">estimate · {estimate.distanceCharge} km charge</span>
            </div>
            <div className="pay-choice">
              <button type="button" className={paymentMethod === 'cash' ? 'pay-opt active' : 'pay-opt'} onClick={() => setPaymentMethod('cash')}>💵 Cash</button>
              {cardEnabled && (
                <button type="button" className={paymentMethod === 'card' ? 'pay-opt active' : 'pay-opt'} onClick={() => setPaymentMethod('card')}>💳 Card</button>
              )}
            </div>
            <button className="btn primary" onClick={confirm} disabled={loading || !dest}>
              {loading ? 'Booking…' : `Confirm · pay by ${paymentMethod}`}
            </button>
          </div>
        ) : (
          <p className="hint">{loading ? 'Calculating fare…' : 'Set a destination to see your fare'}</p>
        )}
      </div>
    </div>
  );
}

function geoMessage(code) {
  switch (code) {
    case 'geolocation-unsupported':
      return 'Location needs a secure connection (HTTPS or localhost) — tap the map to set your pickup instead.';
    case 'permission-denied':
      return 'Location is blocked. Allow Location for this site, then tap 🎯 again — or tap the map to set your pickup.';
    case 'position-unavailable':
      return 'Your location is currently unavailable. Tap the map to set where you are instead.';
    case 'position-timeout':
      return 'Your location is taking too long to load. Tap the map to set where you are instead.';
    case 'low-accuracy':
      return 'Could not pinpoint you precisely. Tap the map to set where you are instead.';
    default:
      // Preflight "blocked" reasons are already descriptive — pass them through.
      return code || 'Could not get your location — tap the map to set where you are instead.';
  }
}

function decodePolyline(encoded) {
  if (!encoded) return null;
  const points = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = (result & 1) ? ~(result >> 1) : (result >> 1);
    lat += dlat;
    shift = 0; result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = (result & 1) ? ~(result >> 1) : (result >> 1);
    lng += dlng;
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}
