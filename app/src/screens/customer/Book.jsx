import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Map from '../../components/Map.jsx';
import SavedPlacesBar, { SavePlaceBar } from '../../components/SavedPlaces.jsx';
import { api, apiUpload, formatRand, toTel, toWhatsApp, validateSaId } from '../../api.js';
import geolocate from '../../lib/geolocate.js';
import decodePolyline from '../../lib/polyline.js';
import { nearestPoint } from '../../lib/geo.js';
import { getOrFetch } from '../../lib/offlineCache.js';
import { useI18n } from '../../i18n.jsx';
import { useServiceArea } from '../../lib/serviceArea.js';

// How long a pin must sit still before we price the trip. Long enough that
// fine-tuning a pin costs one request, short enough to feel instant.
const ESTIMATE_DEBOUNCE_MS = 400;

// Common landmarks used to describe informal places / drop a pin quickly.
const LANDMARKS = [
  { label: 'Taxi rank', icon: '🚐' },
  { label: 'Shop', icon: '🏪' },
  { label: 'Clinic', icon: '🏥' },
  { label: 'School', icon: '🏫' },
  { label: 'Church', icon: '⛪' },
  { label: 'Corner', icon: '🔻' },
];

// `visible` is false while the customer sits on another tab. The shell keeps
// this screen mounted to avoid refetching, but a hidden Leaflet map is still a
// live map: it keeps pulling tiles and its controls stay in the DOM, so the
// booking map and the live-trip map end up both active. Only build it when it
// can actually be seen.
export default function Book({ onBack, onRequest, presetDest, visible = true }) {
  const { t } = useI18n();
  const serviceArea = useServiceArea();
  const [pickup, setPickup] = useState(null);
  const [dest, setDest] = useState(presetDest || null);
  const [you, setYou] = useState(null); // customer's live location (red dot, for nearest-spot picking)
  const [pickupNote, setPickupNote] = useState('');
  const [passengerName, setPassengerName] = useState('');
  const [passengerPhone, setPassengerPhone] = useState('');
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
  const [driverInfo, setDriverInfo] = useState(null);
  // Which pin a map tap should set / re-adjust: 'pickup' or 'destination'.
  const [activePin, setActivePin] = useState('destination');
  // Scheduling: 'now' or 'later' with a chosen datetime (min 10 min ahead).
  const [when, setWhen] = useState('now');
  const [scheduleAt, setScheduleAt] = useState(() => defaultSchedule());
  const [savedMsg, setSavedMsg] = useState(false);
  const [spots, setSpots] = useState([]);
  // Confirmation summary shown before the request is actually sent.
  const [showConfirm, setShowConfirm] = useState(false);
  const [modalError, setModalError] = useState('');
  // Recent destinations (one-tap rebook of a previous destination).
  const [recentDests, setRecentDests] = useState([]);
  // Promo code support.
  const [promoCode, setPromoCode] = useState('');
  const [promoApplied, setPromoApplied] = useState(null);
  const [promoError, setPromoError] = useState('');
  // Identity documents gate: booking is blocked until the customer uploads an
  // ID copy + selfie. The server's `required` flag is the policy (admins pass).
  const [identity, setIdentity] = useState(null);
  const [showVerify, setShowVerify] = useState(false);
  const [verifyIdNumber, setVerifyIdNumber] = useState('');
  const [verifyIdCopy, setVerifyIdCopy] = useState(null);
  const [verifySelfie, setVerifySelfie] = useState(null);
  const [verifyError, setVerifyError] = useState('');
  const [verifyBusy, setVerifyBusy] = useState(false);
  const needsVerify = !!identity?.required;

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

  // Identity documents gate: (re)fetch whenever this screen is shown, not just
  // on first mount — the shell keeps Book mounted in the background, so a
  // verification done while it sat hidden must be picked up before the booking
  // button renders (same for an admin clearing documents in the meantime).
  useEffect(() => {
    if (!visible) return;
    api('/customer/identity').then(setIdentity).catch(() => {});
  }, [visible]);

  // Fetch the driver's public details (vehicle, plate, phone) from the API
  // instead of using hardcoded values. Cache offline so the booking screen
  // still works on a patchy connection.
  useEffect(() => {
    getOrFetch('driver', () => api('/customer/driver'))
      .then(setDriverInfo)
      .catch(() => {});
  }, []);

  // Preset pickup spots (owner-managed in Admin → Spots).
  // Also cached offline-first, but the cached copy must not pin the list: spots
  // an admin adds later have to reach the customer without a re-login.
  useEffect(() => {
    const apply = (r) => setSpots(Array.isArray(r.spots) ? r.spots : []);
    getOrFetch('pickup-spots', () => api('/pickup-spots').then((r) => ({ spots: Array.isArray(r.spots) ? r.spots : [] })), apply)
      .then(apply)
      .catch(() => {});
  }, []);

  // Recent destinations for one-tap rebook.
  useEffect(() => {
    api('/customer/recent-destinations')
      .then((r) => setRecentDests(Array.isArray(r.destinations) ? r.destinations : []))
      .catch(() => {});
  }, []);

  // Apply / validate a promo code when the user types it.
  function applyPromo() {
    const code = promoCode.trim().toUpperCase();
    if (!code) {
      setPromoApplied(null);
      setPromoError('');
      return;
    }
    // Local-only validation like "is it a code-shaped string?" — the server
    // is the authority, so we optimistically tag the estimate and let the
    // booking POST confirm/reject the code.
    setPromoApplied({ code, percent: 10 });
    setPromoError('');
    setEstimate((prev) => {
      if (prev && prev.discount) return prev;
      return prev;
    });
  }

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
  //
  // Adjusting a pin fires this on every tap, and each run is a round trip to
  // the routing provider. Two problems that caused: the requests raced, so a
  // slow earlier response could land last and paint a route for a pin the
  // customer had already moved off; and a customer nudging the pin around
  // generated a burst of billable API calls. So: wait for the pin to settle,
  // and cancel anything still in flight when it moves again.
  useEffect(() => {
    if (!pickup || !dest) {
      setEstimate(null);
      setRoute(null);
      setTrip(null);
      return undefined;
    }
    const from = { lat: pickup.lat, lng: pickup.lng };
    const to = { lat: dest.lat, lng: dest.lng };
    const promo = promoApplied?.code || null;
    const controller = new AbortController();
    let cancelled = false;

    setLoading(true);
    setError('');

    const timer = setTimeout(() => {
      api('/customer/estimate', {
        method: 'POST',
        body: { pickup, destination: dest, promoCode: promo },
        signal: controller.signal,
      })
        .then((res) => {
          if (cancelled) return;
          setEstimate(res.estimate);
          setTrip({ distanceKm: res.route?.distanceKm ?? null, durationMin: res.route?.durationMin ?? null });
          if (res.route?.polyline) {
            setRoute(decodePolyline(res.route.polyline));
          } else {
            setRoute([[from.lat, from.lng], [to.lat, to.lng]]);
          }
        })
        .catch((err) => {
          // An abort is us changing our mind about the pins, not a failure.
          if (cancelled || err?.name === 'AbortError') return;
          setError(err.message);
        })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, ESTIMATE_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [pickup, dest, promoApplied?.code]);

  // A preset spot as the pickup — map-pin taps and the nearest-spot bar.
  const applySpotAsPickup = useCallback((spot) => {
    const label = spot.name || spot.address || 'Pickup spot';
    setPickup({ lat: spot.lat, lng: spot.lng, address: label, note: spot.address || spot.note || null });
    setPickupNote(spot.address || spot.note || '');
    setLocateError(false);
  }, []);

  // The same spot as the drop-off. These presets serve both ends of the trip.
  const applySpotAsDest = useCallback((spot) => {
    const label = spot.name || spot.address || 'Destination spot';
    setDest({ lat: spot.lat, lng: spot.lng, address: label, note: spot.address || spot.note || null });
    setDestNote(spot.address || spot.note || '');
  }, []);

  // Tapping a green dot fills whichever pin is currently active. The first spot
  // a customer picks is always their pickup — there is no drop-off to choose
  // until a pickup exists, and the overlay tells them to start there.
  const applySpot = useCallback((spot) => {
    if (activePin === 'destination' && pickup) return applySpotAsDest(spot);
    return applySpotAsPickup(spot);
  }, [activePin, pickup, applySpotAsDest, applySpotAsPickup]);

  // Map gives us the pinned object directly (spot, or the marker descriptor when
  // there is no stored spot), so unwrap .spot defensively and fall back to the
  // object itself.
  const onSpotClick = useCallback((m) => applySpot(m.spot || m), [applySpot]);

  // Tapping the map sets / re-adjusts whichever pin is active. This lets the
  // customer fix a wrongly-placed pickup or destination by tapping again.
  const onMapClick = useCallback((e) => {
    const { lat, lng } = e.latlng;
    // Forgiving mobile taps: a tap landing on or within 70 m of a preset spot
    // selects that spot instead of dropping a raw pin — so "tap the nearest
    // green dot" always works, even if the dot is small. This applies to
    // whichever pin is active, since the same spots serve pickup and drop-off.
    const near = nearestSpotTo(lat, lng, spots);
    if (near && near.m < 70) {
      applySpot(near.spot);
      return;
    }
    // Until the pickup exists, a raw tap is the pickup — otherwise the customer
    // would set a drop-off with nothing to be dropped off from.
    if (activePin === 'pickup' || !pickup) {
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
    // Safety gate: never open the review modal without documents on file.
    if (needsVerify) { setShowVerify(true); return; }
    setModalError('');
    setShowConfirm(true);
  }

  function onVerifyFile(setter) {
    return (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) setter(f);
    };
  }

  // Upload the ID copy + selfie to unlock booking (multipart, like Apply.jsx).
  async function submitVerify(e) {
    e.preventDefault();
    setVerifyError('');
    if (!validateSaId(verifyIdNumber)) {
      setVerifyError(t('book.verifyIdInvalid'));
      return;
    }
    if (!verifyIdCopy || !verifySelfie) {
      setVerifyError(t('book.verifyFilesRequired'));
      return;
    }
    setVerifyBusy(true);
    try {
      const fd = new FormData();
      fd.append('idNumber', verifyIdNumber.trim());
      fd.append('idCopy', verifyIdCopy);
      fd.append('selfie', verifySelfie);
      const res = await apiUpload('/customer/identity', fd);
      setIdentity(res);
      setShowVerify(false);
      setError('');
    } catch (err) {
      setVerifyError(err.message);
    } finally {
      setVerifyBusy(false);
    }
  }

  // Actually send the request. Kept separate from confirm() so the summary modal
  // is the gate: once the customer taps "Confirm booking" this is posted.
  function submit() {
    if (!pickup || !dest) return;
    setLoading(true);
    setModalError('');
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
      passengerName: passengerName.trim() || null,
      passengerPhone: passengerPhone.trim() || null,
      // datetime-local gives a naive local wall-clock string ("2026-10-07T14:00").
      // The scheduler runs on UTC, so pin it to an exact instant (with the
      // browser's timezone) before sending — otherwise SAST rides release 2h late.
      scheduledAt: when === 'later' && scheduleAt
        ? (() => {
            const d = new Date(scheduleAt);
            return Number.isNaN(d.getTime()) ? null : d.toISOString();
          })()
        : null,
      promoCode: promoApplied?.code || null,
    };
    api('/customer/trips', { method: 'POST', body: payload })
      .then((res) => { flushPending(); setShowConfirm(false); onRequest(res.trip); })
      .catch((err) => {
        // The gate can flip under us — show the verify panel instead of a
        // dead-end modal error.
        if (err.code === 'DOCUMENTS_REQUIRED') {
          setShowConfirm(false);
          setShowVerify(true);
          setError(err.message);
          api('/customer/identity').then(setIdentity).catch(() => {});
          return;
        }
        // Network / offline: save the booking locally and retry automatically
        // when connectivity returns — keeps us usable on rural, low-signal roads
        // where global apps fall over.
        if (!err.status && /fetch|network|offline/i.test(err.message || '')) {
          try {
            const key = 'drivelocal_pending_bookings';
            const queued = JSON.parse(localStorage.getItem(key) || '[]');
            queued.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), payload, savedAt: Date.now() });
            localStorage.setItem(key, JSON.stringify(queued));
            setShowConfirm(false);
            setModalError('No connection. Your booking was saved and will be sent automatically when you are back online.');
            return;
          } catch {
            // fall through to normal error
          }
        }
        setModalError(err.message);
      })
      .finally(() => setLoading(false));
  }

  // Send any bookings that were queued while offline.
  function flushPending() {
    const key = 'drivelocal_pending_bookings';
    let queued = [];
    try { queued = JSON.parse(localStorage.getItem(key) || '[]'); } catch { queued = []; }
    if (!queued.length) return;
    const [item, ...rest] = queued;
    api('/customer/trips', { method: 'POST', body: item.payload })
      .then((res) => {
        try { localStorage.setItem(key, JSON.stringify(rest)); } catch { /* ignore */ }
        if (res?.trip) {
          // Best-effort: surface nothing, just keep queue moving.
        }
      })
      .catch(() => {
        // Keep queued item for a later retry.
      })
      .finally(() => {
        // Retry the rest on next online tick.
      });
  }

  useEffect(() => {
    const handler = () => flushPending();
    window.addEventListener('online', handler);
    if (navigator.onLine) flushPending();
    return () => window.removeEventListener('online', handler);
  }, []);

  const markers = useMemo(() => {
    const m = [];
    if (you) m.push({ lat: you.lat, lng: you.lng, type: 'you', accuracy: you.accuracy });
    spots.forEach((s) => m.push({ lat: s.lat, lng: s.lng, type: 'spot', name: s.name, spot: s }));
    if (pickup) m.push({ lat: pickup.lat, lng: pickup.lng, type: 'home', accuracy: pickup.accuracy });
    if (dest) m.push({ lat: dest.lat, lng: dest.lng, type: 'dest' });
    return m;
  }, [you, spots, pickup, dest]);

  // The nearest preset pickup spot to the customer's red dot.
  const nearest = useMemo(() => {
    const best = you ? nearestPoint(you, spots) : null;
    return best ? { spot: best.point, m: best.m } : null;
  }, [you, spots]);

  const fmtMeters = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);

  // Centre the map on the configured service area so the customer sees the
  // surroundings when placing pins. If the owner hasn't set one (or the device
  // location is known and there's no area), fall back sensibly. Autofit frames
  // the route once both pins are down.
  const hasArea = serviceArea.lat != null && serviceArea.lng != null;
  const mapCenter = hasArea
    ? [serviceArea.lat, serviceArea.lng]
    : you
      ? [you.lat, you.lng]
      : null;
  // Bound the view generously around the service area radius so the map can't be
  // panned off into the ocean (wasted tiles). Only when an area is configured.
  const mapBounds = hasArea
    ? (() => {
        const d = Math.max(0.05, (serviceArea.radiusKm || 30) / 111);
        return [
          [serviceArea.lat - d, serviceArea.lng - d],
          [serviceArea.lat + d, serviceArea.lng + d],
        ];
      })()
    : null;

  const gpsPin = (p) => `${Number(p.lat).toFixed(6)},${Number(p.lng).toFixed(6)}`;

  return (
    <div className="screen book-screen">
      <div className="book-header">
        <button className="link-btn" onClick={onBack}>{t('common.back')}</button>
        <h1>{t('book.title')}</h1>
      </div>

      <div className="no-street-hint">{t('book.noStreets')}</div>

      <div className="book-form">
      <div className="card">
        <label className="field">
          <span className="field-label">{t('book.pickupLabel')}</span>
          <div className="field-row">
            <input
              value={pickup?.address || ''}
              placeholder={locating ? t('book.locating') : t('book.pickupPlaceholder')}
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
            aria-label="Pickup directions"
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
          <span className="field-label">{t('book.destLabel')}</span>
          <input
            value={dest?.address || ''}
            placeholder={isRebook ? t('book.destRebook') : t('book.destPlaceholder')}
            readOnly
          />

          {!isRebook && recentDests.length > 0 && (
            <div className="recent-dests">
              <span className="spots-head">Recent — tap to re-use</span>
              <div className="recent-row">
                {recentDests.slice(0, 4).map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className="recent-chip"
                    onClick={() => {
                      setDest({ lat: r.destLat, lng: r.destLng, address: r.destAddress || 'Destination', note: r.destNote });
                      setDestNote(r.destNote || '');
                    }}
                  >
                    🔁 {r.destAddress || `(${r.destLat.toFixed(4)}, ${r.destLng.toFixed(4)})`}
                  </button>
                ))}
              </div>
            </div>
          )}

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
            aria-label={t('book.destNotePh')}
            placeholder={t('book.destNotePh')}
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
        <h3>🚗 Your driver: {driverInfo?.vehicleType || 'Your driver'}</h3>
        <p className="hint" style={{ margin: '4px 0 8px' }}>Registration {driverInfo?.licensePlate || '—'} · Your trusted DriveLocal driver</p>
        <div className="btn-row">
          {driverInfo?.phone && <a className="btn small" href={toTel(driverInfo.phone)}>📞 Call {driverInfo.phone}</a>}
          {driverInfo?.phone && <a className="btn small" href={toWhatsApp(driverInfo.phone, 'Hi, I need help with my DriveLocal booking.')} target="_blank" rel="noreferrer">💬 WhatsApp</a>}
        </div>
      </div>

      {you && nearest && !pickup && (
        <button type="button" className="nearest-bar" onClick={() => applySpotAsPickup(nearest.spot)}>
          📍 Nearest pickup: {nearest.spot.name || nearest.spot.address || 'Pickup spot'} · {fmtMeters(nearest.m)} — use this
        </button>
      )}
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

        {visible && (
          <Map
            center={mapCenter}
            markers={markers}
            route={route}
            onMapClick={onMapClick}
            onSpotClick={onSpotClick}
            autofitSpots={!(pickup && dest)}
            maxBounds={mapBounds}
          />
        )}
        {!pickup ? (
          <div className="map-overlay">
            {spots.length ? 'Tap the nearest green dot to set your pickup' : 'Tap the map to set your pickup'}
          </div>
        ) : !dest && activePin === 'destination' ? (
          <div className="map-overlay">
            {spots.length ? 'Tap a green dot to drop off there, or tap the map for any other point' : 'Tap the map to drop your destination pin'}
          </div>
        ) : activePin === 'pickup' ? (
          <div className="map-overlay">
            {spots.length ? 'Tap a green dot to set / fix your pickup' : 'Tap the map to set / fix your pickup spot'}
          </div>
        ) : (
          <div className="map-status">Tap the map to move the {activePin === 'pickup' ? 'pickup' : 'destination'} pin</div>
        )}
      </div>

      <div className="estimate-bar">
        {error && <p className="error">{error}</p>}
        {needsVerify && (
          <div className="verify-panel">
            {showVerify ? (
              <form onSubmit={submitVerify}>
                <h3>🛡 {t('book.verifyTitle')}</h3>
                <p className="hint">{t('book.verifyHint')}</p>
                <div className="field">
                  <span className="field-label">{t('book.verifyIdNumber')}</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={13}
                    value={verifyIdNumber}
                    onChange={(e) => setVerifyIdNumber(e.target.value)}
                    placeholder="e.g. 9001015800088"
                  />
                </div>
                <div className="field">
                  <span className="field-label">{t('book.verifyIdCopy')}</span>
                  <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={onVerifyFile(setVerifyIdCopy)} />
                </div>
                <div className="field">
                  <span className="field-label">{t('book.verifySelfie')}</span>
                  <input type="file" accept="image/jpeg,image/png,image/webp" onChange={onVerifyFile(setVerifySelfie)} />
                  <p className="hint">{t('book.verifySelfieHint')}</p>
                </div>
                {verifyError && <p className="error">{verifyError}</p>}
                <div className="btn-row" style={{ marginTop: '6px' }}>
                  <button type="button" className="btn" onClick={() => { setShowVerify(false); setVerifyError(''); }} disabled={verifyBusy}>{t('common.back')}</button>
                  <button type="submit" className="btn primary" disabled={verifyBusy}>{verifyBusy ? '…' : t('book.verifySubmit')}</button>
                </div>
              </form>
            ) : (
              <>
                <h3>🛡 {t('book.verifyTitle')}</h3>
                <p className="hint">{t('book.verifyHint')}</p>
                <button type="button" className="btn primary" onClick={() => setShowVerify(true)}>{t('book.verifyCta')}</button>
              </>
            )}
          </div>
        )}
        {estimate ? (
          <div className="estimate-inner">
            <div>
              <span className="estimate-amount">{formatRand(estimate.total)}</span>
              <span className="estimate-detail">estimate · {trip?.distanceKm ?? '-'} km · {trip?.durationMin ?? '-'} min</span>
            </div>

            {estimate?.discount > 0 && (
              <div className="promo-badge">🎉 Promo applied — you save {formatRand(estimate.discount)}</div>
            )}

            <div className="field">
              <span className="field-label">Promo code (optional)</span>
              <div className="field-row">
                <input
                  value={promoCode}
                  onChange={(e) => { setPromoCode(e.target.value); setPromoError(''); }}
                  placeholder="e.g. WELCOME10"
                  aria-label="Promo code"
                  style={{ textTransform: 'uppercase' }}
                />
                <button type="button" className="btn small" onClick={applyPromo} disabled={!promoCode.trim()}>
                  {promoApplied ? 'Applied ✓' : 'Apply'}
                </button>
              </div>
              {promoApplied && <p className="success" style={{ margin: '4px 0 0' }}>{promoApplied.code} applied</p>}
              {promoError && <p className="error" style={{ margin: '4px 0 0' }}>{promoError}</p>}
            </div>

            <div className="fare-breakdown">
              <div className="receipt-row"><span>Base fare</span><span>{formatRand(estimate.baseFare)}</span></div>
              <div className="receipt-row"><span>Distance ({trip?.distanceKm ?? '-'} km)</span><span>{formatRand(estimate.distanceCharge)}</span></div>
              <div className="receipt-row"><span>Time ({trip?.durationMin ?? '-'} min)</span><span>{formatRand(estimate.durationCharge)}</span></div>
              {estimate.discount > 0 && (
                <div className="receipt-row promo-row"><span>Promo ({estimate.promoCode})</span><span>−{formatRand(estimate.discount)}</span></div>
              )}
              <div className="receipt-row total"><span>Total</span><span>{formatRand(estimate.total)}</span></div>
            </div>

            <div className="schedule-row">
              <button type="button" className={`schedule-chip ${when === 'now' ? 'on' : ''}`} onClick={() => setWhen('now')}>{t('book.now')}</button>
              <button type="button" className={`schedule-chip ${when === 'later' ? 'on' : ''}`} onClick={() => setWhen('later')}>{t('book.schedule')}</button>
            </div>
            {when === 'later' && (
              <div className="schedule-datetime">
                <input type="datetime-local" value={scheduleAt} min={defaultSchedule()} onChange={(e) => setScheduleAt(e.target.value)} />
              </div>
            )}

            <details className="passenger-details" style={{ margin: '8px 0' }}>
              <summary className="hint" style={{ cursor: 'pointer' }}>Booking for someone else? (optional)</summary>
              <label style={{ display: 'block', marginTop: '8px' }}>
                Passenger name
                <input type="text" value={passengerName} onChange={(e) => setPassengerName(e.target.value)} placeholder="Thandi" />
              </label>
              <label style={{ display: 'block' }}>
                Passenger phone
                <input type="tel" value={passengerPhone} onChange={(e) => setPassengerPhone(e.target.value)} placeholder="+27..." />
              </label>
            </details>

            <div className="pay-choice">
              <button type="button" className={paymentMethod === 'cash' ? 'pay-opt active' : 'pay-opt'} onClick={() => setPaymentMethod('cash')}>{t('book.payCash')}</button>
              {cardEnabled && (
                <button type="button" className={paymentMethod === 'card' ? 'pay-opt active' : 'pay-opt'} onClick={() => setPaymentMethod('card')}>{t('book.payCard')}</button>
              )}
            </div>

            <SavePlaceBar
              point={dest}
              onSaved={() => { setSavedMsg(true); setTimeout(() => setSavedMsg(false), 2500); }}
            />
            {savedMsg && <p className="success" style={{ margin: '6px 0 0' }}>Saved to your places ✨</p>}

            <button className="btn primary" onClick={confirm} disabled={loading || needsVerify || !dest || (when === 'later' && !scheduleAt) || !estimate}>
              {loading ? '…' : when === 'later' ? t('book.scheduleRide') : t('book.review')}
            </button>
          </div>
        ) : (
          <p className="hint">{loading ? t('book.calculating') : t('book.setDest')}</p>
        )}
      </div>

      {showConfirm && estimate && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="book-confirm-title">
          <div className="modal-card">
            <div className="book-header">
              <h2 id="book-confirm-title">{t('book.review')}</h2>
            </div>

            <div className="route-line">
              <div className="route-row"><span className="dot pickup-dot" />{pickup.address || 'Pickup'}</div>
              {pickupNote && <div className="route-row"><span className="dot" style={{ background: 'transparent' }} />📍 <span className="hint" style={{ margin: 0 }}>{pickupNote}</span></div>}
              <div className="route-row"><span className="dot dest-dot" />{dest.address || 'Destination'}</div>
              {destNote && <div className="route-row"><span className="dot" style={{ background: 'transparent' }} />📍 <span className="hint" style={{ margin: 0 }}>{destNote}</span></div>}
            </div>

            <div className="receipt-row total" style={{ marginTop: '8px' }}>
              <span>Estimated fare (no surge)</span><span>{formatRand(estimate.total)}</span>
            </div>
            <p className="hint">{trip?.distanceKm ?? '-'} km · {trip?.durationMin ?? '-'} min</p>

            <div className="summary-grid">
              <div className="stat-tile"><span className="stat-num">{when === 'later' ? '📅' : '⚡'}</span><span className="stat-label">{when === 'later' ? new Date(scheduleAt).toLocaleString() : 'Now'}</span></div>
              <div className="stat-tile"><span className="stat-num">{paymentMethod === 'card' ? '💳' : '💵'}</span><span className="stat-label">Pay by {paymentMethod}</span></div>
            </div>

            {modalError && <p className="error">{modalError}</p>}
            <p className="hint" style={{ margin: '8px 0 0' }}>
              No connection? You can still request a ride by
              {' '}
              <a href={toWhatsApp(import.meta.env.VITE_DRIVER_PHONE || '+27000000000', `DriveLocal booking: pickup ${pickup?.address || 'TBA'} -> destination ${dest?.address || 'TBA'}`)} target="_blank" rel="noreferrer">
                WhatsApp
              </a>
              {' '}and we will lock it in when we reconnect.
            </p>

            <div className="btn-row" style={{ marginTop: '14px' }}>
              <button className="btn" onClick={() => setShowConfirm(false)} disabled={loading}>{t('common.back')}</button>
              <button className="btn primary big" onClick={submit} disabled={loading}>
                {loading ? '…' : t('trip.cta')}
              </button>
            </div>
            <p className="hint overlay-tip">Total is an estimate — driver confirms the exact fare on the trip.</p>
          </div>
        </div>
      )}
    </div>
  );
}

function defaultSchedule() {
  const d = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function nearestSpotTo(lat, lng, spots) {
  const best = nearestPoint({ lat, lng }, spots);
  return best ? { spot: best.point, m: best.m } : null;
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
