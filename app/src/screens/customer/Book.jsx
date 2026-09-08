import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Map from '../../components/Map.jsx';
import SavedPlacesBar, { SavePlaceBar } from '../../components/SavedPlaces.jsx';
import { api, formatRand, toTel, toWhatsApp } from '../../api.js';
import geolocate from '../../lib/geolocate.js';
import decodePolyline from '../../lib/polyline.js';

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
  const [you, setYou] = useState(null); // customer's live location (red dot, for nearest-spot picking)
  const [pickupNote, setPickupNote] = useState('');
  const [destNote, setDestNote] = useState(
    presetDest?.note || (presetDest ? '' : ''),
  );
  const [estimate, setEstimate] = useState(null);
  const [route, setRoute] = useState(null);
  const [trip, setTrip] = useState(null); // route summary (distanceKm / durationMin)
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
  // Scheduling: 'now' or 'later' with a chosen datetime (min 10 min ahead).
  const [when, setWhen] = useState('now');
  const [scheduleAt, setScheduleAt] = useState(() => defaultSchedule());
  const [savedMsg, setSavedMsg] = useState(false);
  const [spots, setSpots] = useState([]);

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
        setYou({ lat, lng, accuracy });
        setLocateError(false);
      })
      .catch((err) => {
        setLocateError(true);
        setError(geoMessage(err?.message));
      })
      .finally(() => setLocating(false));
  }, []);

  // Silently try to show the red "you" dot on mount so the customer immediately
  // sees the pickup spots around them. If the browser wants a gesture first the
  // 🎯 button is the fallback (it also sets the dot).
  useEffect(() => {
    let live = true;
    geolocate()
      .then(({ lat, lng, accuracy }) => { if (live) setYou({ lat, lng, accuracy }); })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  // Card payments only work when Yoco is configured on the server; otherwise
  // offer cash only so the customer can't pick an option that will fail later.
  useEffect(() => {
    api('/payments/config')
      .then((cfg) => setCardEnabled(!!cfg.enabled))
      .catch(() => setCardEnabled(false));
  }, []);

  // Preset pickup spots (seeded server-side for the Kriel / Thubelihle area).
  useEffect(() => {
    api('/pickup-spots')
      .then((r) => setSpots(Array.isArray(r.spots) ? r.spots : []))
      .catch(() => {});
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
      setTrip(null);
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
        setTrip({ distanceKm: res.route?.distanceKm ?? null, durationMin: res.route?.durationMin ?? null });
        if (res.route?.polyline) {
          setRoute(decodePolyline(res.route.polyline));
        } else {
          setRoute([[pickup.lat, pickup.lng], [dest.lat, dest.lng]]);
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [pickup, dest]);

  // Pick a pickup spot — used for both map-pin taps and the nearest-spot bar.
  const applySpot = useCallback((spot) => {
    const label = spot.name || spot.address || 'Pickup spot';
    setPickup({ lat: spot.lat, lng: spot.lng, address: label, note: spot.address || spot.note || null });
    setPickupNote(spot.address || spot.note || '');
    setLocateError(false);
  }, []);

  const onSpotClick = useCallback((m) => applySpot(m.spot), [applySpot]);

  // Tapping the map sets / re-adjusts whichever pin is active. This lets the
  // customer fix a wrongly-placed pickup or destination by tapping again.
  const onMapClick = useCallback((e) => {
    const { lat, lng } = e.latlng;
    // Forgiving mobile taps: when a pickup is being chosen, a tap landing on or
    // within 70 m of a preset spot selects that spot instead of dropping a raw
    // pin — so "tap the nearest green dot" always works, even if the dot is small.
    if (!pickup || activePin === 'pickup') {
      const near = nearestSpotTo(lat, lng, spots);
      if (near && near.m < 70) {
        applySpot(near.spot);
        return;
      }
    }
    if (activePin === 'pickup') {
      setPickup({ lat, lng, address: pickup?.address && !pickup.address.startsWith('Current location') ? pickup.address : 'Current location', note: pickupNote });
    } else {
      // Moving the destination: clear the stale label; the note field holds the
      // human description and confirm() fills in a sensible address.
      setDest({ lat, lng, address: '', note: destNote });
    }
  }, [activePin, pickup, pickupNote, destNote, spots, applySpot]);

  function locatePickup(e) {
    e.stopPropagation();
    doLocate();
  }

  // Fill the active pin (or destination by default) from a saved place.
  const applySavedPlace = useCallback((place) => {
    const label = place.address || place.label;
    const point = { lat: place.lat, lng: place.lng, address: label, note: place.note };
    if (activePin === 'pickup') {
      setPickup(point);
    } else {
      setDest(point);
      setDestNote(place.note || '');
    }
  }, [activePin]);

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
      scheduledAt: when === 'later' ? scheduleAt : null,
    };
    api('/customer/trips', { method: 'POST', body: payload })
      .then((res) => onRequest(res.trip))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  const markers = useMemo(() => {
    const m = [];
    if (you) m.push({ lat: you.lat, lng: you.lng, type: 'you', accuracy: you.accuracy });
    spots.forEach((s) => m.push({ lat: s.lat, lng: s.lng, type: 'spot', spot: s }));
    if (pickup) m.push({ lat: pickup.lat, lng: pickup.lng, type: 'home', accuracy: pickup.accuracy });
    if (dest) m.push({ lat: dest.lat, lng: dest.lng, type: 'dest' });
    return m;
  }, [you, spots, pickup, dest]);

  // The nearest preset pickup spot to the customer's red dot.
  const nearest = useMemo(() => {
    if (!you || !spots.length) return null;
    let best = null;
    for (const s of spots) {
      const d = metersApart(you, s);
      if (!best || d < best.m) best = { spot: s, m: d };
    }
    return best;
  }, [you, spots]);

  const fmtMeters = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);

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

          {spots.length > 0 && (
            <div className="spots-head">Pick the closest green dot on the map below</div>
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

          {!isRebook && <SavedPlacesBar onPick={applySavedPlace} active={activePin === 'pickup' ? 'as pickup' : 'as destination'} />}

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

      {you && nearest && !pickup && (
        <button type="button" className="nearest-bar" onClick={() => applySpot(nearest.spot)}>
          📍 Nearest pickup: {nearest.spot.name || nearest.spot.address || 'Pickup spot'} · {fmtMeters(nearest.m)} — use this
        </button>
      )}
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

        <Map
          center={mapCenter}
          markers={markers}
          route={route}
          onMapClick={onMapClick}
          onSpotClick={onSpotClick}
          autofitSpots={!(pickup && dest)}
        />
        {!pickup ? (
          <div className="map-overlay">
            {spots.length ? 'Tap the nearest green dot to set your pickup' : 'Tap the map to set your pickup'}
          </div>
        ) : !dest && activePin === 'destination' ? (
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
              <span className="estimate-detail">estimate · {trip?.distanceKm ?? '-'} km · {trip?.durationMin ?? '-'} min</span>
            </div>

            <div className="fare-breakdown">
              <div className="receipt-row"><span>Base fare</span><span>{formatRand(estimate.baseFare)}</span></div>
              <div className="receipt-row"><span>Distance ({trip?.distanceKm ?? '-'} km)</span><span>{formatRand(estimate.distanceCharge)}</span></div>
              <div className="receipt-row"><span>Time ({trip?.durationMin ?? '-'} min)</span><span>{formatRand(estimate.durationCharge)}</span></div>
              <div className="receipt-row total"><span>Total</span><span>{formatRand(estimate.total)}</span></div>
            </div>

            <div className="schedule-row">
              <button type="button" className={`schedule-chip ${when === 'now' ? 'on' : ''}`} onClick={() => setWhen('now')}>⚡ Now</button>
              <button type="button" className={`schedule-chip ${when === 'later' ? 'on' : ''}`} onClick={() => setWhen('later')}>📅 Schedule</button>
            </div>
            {when === 'later' && (
              <div className="schedule-datetime">
                <input type="datetime-local" value={scheduleAt} min={defaultSchedule()} onChange={(e) => setScheduleAt(e.target.value)} />
              </div>
            )}

            <div className="pay-choice">
              <button type="button" className={paymentMethod === 'cash' ? 'pay-opt active' : 'pay-opt'} onClick={() => setPaymentMethod('cash')}>💵 Cash</button>
              {cardEnabled && (
                <button type="button" className={paymentMethod === 'card' ? 'pay-opt active' : 'pay-opt'} onClick={() => setPaymentMethod('card')}>💳 Card</button>
              )}
            </div>

            <SavePlaceBar
              point={dest}
              onSaved={() => { setSavedMsg(true); setTimeout(() => setSavedMsg(false), 2500); }}
            />
            {savedMsg && <p className="success" style={{ margin: '6px 0 0' }}>Saved to your places ✨</p>}

            <button className="btn primary" onClick={confirm} disabled={loading || !dest || (when === 'later' && !scheduleAt)}>
              {loading ? 'Booking…' : when === 'later' ? `Schedule ride · pay by ${paymentMethod}` : `Confirm · pay by ${paymentMethod}`}
            </button>
          </div>
        ) : (
          <p className="hint">{loading ? 'Calculating fare…' : 'Set a destination to see your fare'}</p>
        )}
      </div>
    </div>
  );
}

function defaultSchedule() {
  const d = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function metersApart(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la = (a.lat * Math.PI) / 180;
  const lb = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function nearestSpotTo(lat, lng, spots) {
  let best = null;
  for (const s of spots) {
    const d = metersApart({ lat, lng }, s);
    if (!best || d < best.m) best = { spot: s, m: d };
  }
  return best;
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
