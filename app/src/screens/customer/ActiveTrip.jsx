import React, { useEffect, useMemo, useRef, useState } from 'react';
import Map from '../../components/Map.jsx';
import { api, connectSocket, formatRand, toTel, toWhatsApp } from '../../api.js';
import { playRequestChime, playSuccessChime } from '../../lib/alert.js';
import { getEmergencyContact, setEmergencyContact, sendSos } from '../../lib/emergency.js';
import { useI18n } from '../../i18n.jsx';

const FEEDBACK_TAGS = ['Friendly', 'Punctual', 'Clean car', 'Safe driving', 'Great music', 'Smooth ride', 'Helpful'];

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
// Straight-line time estimate to the pickup, matching the fare model
// (2 min/km + 5 min) so the ETA tracks the driver live as they approach.
function etaMin(loc, pickup) {
  if (!loc || !pickup) return null;
  return Math.max(1, Math.round(haversineKm(loc.lat, loc.lng, pickup.lat, pickup.lng) * 2 + 5));
} 

export default function ActiveTrip({ initial, onExit, onNewBooking }) {
  const { t } = useI18n();
  const [trip, setTrip] = useState(initial);
  const [driver, setDriver] = useState(null);
  const [driverLoc, setDriverLoc] = useState(null);
  const [route, setRoute] = useState(null);
  const [stars, setStars] = useState(0);
  const [tip, setTip] = useState(0);
  const [fbtags, setFbTags] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [payment, setPayment] = useState(null);
  const [refunding, setRefunding] = useState(false);
  const socketRef = useRef(null);
  const chimePlayedRef = useRef(false);
  const arrivedChimeRef = useRef(false);
  // SOS modal state.
  const [sosOpen, setSosOpen] = useState(false);
  const [sosContact, setSosContact] = useState(() => getEmergencyContact());
  const [sosName, setSosName] = useState('');
  const [sosPhone, setSosPhone] = useState('');
  const [sosError, setSosError] = useState('');
  const [confirmingFare, setConfirmingFare] = useState(false);

  useEffect(() => {
    api('/customer/driver').then(setDriver).catch(() => {});
    api('/customer/trips/active').then((r) => r.trip && setTrip(r.trip)).catch(() => {});

    const socket = connectSocket();
    socketRef.current = socket;
    socket.on('trip:updated', (data) => data?.trip && setTrip(data.trip));
    socket.on('trip:accepted', (data) => {
      if (data?.trip) {
        setTrip(data.trip);
        if (!chimePlayedRef.current) {
          chimePlayedRef.current = true;
          playSuccessChime();
        }
      }
    });
    socket.on('trip:arrived', (data) => {
      if (data?.trip) {
        setTrip(data.trip);
        if (!arrivedChimeRef.current) {
          arrivedChimeRef.current = true;
          playRequestChime();
        }
      }
    });
    socket.on('trip:location', (data) => {
      if (data?.tripId === trip?.id) setDriverLoc({ lat: data.lat, lng: data.lng });
    });
    socket.on('payment:updated', (data) => {
      if (data?.tripId === trip?.id && data?.payment) setPayment(data.payment);
      if (data?.trip) setTrip(data.trip);
    });
    return () => socket.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Payment status for the fare card — only relevant once the trip is complete.
  useEffect(() => {
    if (trip?.id && trip.status === 'completed') {
      api(`/payments/status?tripId=${trip.id}`).then((r) => r.payment && setPayment(r.payment)).catch(() => {});
    }
  }, [trip?.id, trip.status]);

  // Auto-hide transient toasts.
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(''), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (trip?.pickup && trip?.destination) {
      setRoute([[trip.pickup.lat, trip.pickup.lng], [trip.destination.lat, trip.destination.lng]]);
    }
  }, [trip?.pickup, trip?.destination]);

  function cancel() {
    if (!trip || !['requested', 'accepted'].includes(trip.status)) return;
    setBusy(true);
    setError('');
    api(`/customer/trips/${trip.id}/cancel`, { method: 'POST', body: { reason: 'Customer cancelled' } })
      .then(() => onExit())
      .catch((err) => setError(err.message))
      .finally(() => setBusy(false));
  }

  function confirmCancel() {
    if (!trip || !['requested', 'accepted'].includes(trip.status)) return;
    const message = trip.status === 'accepted'
      ? 'Cancel this trip? Your driver is on the way.'
      : 'Cancel this trip?';
    if (window.confirm(message)) cancel();
  }

  function submitRating() {
    if (!trip || stars < 1) return;
    setBusy(true);
    setError('');
    api(`/customer/trips/${trip.id}/rate`, { method: 'POST', body: { stars, tipAmount: tip, feedbackTags: fbtags } })
      .then((res) => setTrip(res.trip))
      .catch((err) => setError(err.message))
      .finally(() => setBusy(false));
  }

  function requestRefund() {
    setRefunding(true);
    setError('');
    api(`/payments/refund`, { method: 'POST', body: { tripId: trip.id } })
      .then((res) => { setPayment(res.payment); setTrip(res.trip); })
      .catch((err) => setError(err.message))
      .finally(() => setRefunding(false));
  }

  // Share the live trip tracker link via the native share sheet, falling back
  // to a WhatsApp message + clipboard copy.
  async function shareTrip() {
    if (!trip) return;
    const url = `${window.location.origin}/trip/${trip.id}`;
    const text = `🚗 Follow my DriveLocal trip live: ${url}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'DriveLocal trip', text, url });
        return;
      } catch { /* user cancelled or unsupported — fall through */ }
    }
    try { await navigator.clipboard.writeText(text); setToast('Trip link copied — paste it anywhere'); }
    catch { /* clipboard blocked */ }
    window.open(`https://wa.me/?text=${encodeURIComponent(`${text}\n\nI sent this so you can follow my ride.`)}`, '_blank');
  }

  function confirmFare() {
    if (!trip) return;
    setConfirmingFare(true);
    setError('');
    api(`/customer/trips/${trip.id}/fare-confirm`, { method: 'POST' })
      .then((res) => res.trip && setTrip(res.trip))
      .catch((err) => setError(err.message))
      .finally(() => setConfirmingFare(false));
  }

  async function triggerSos() {
    const contact = sosContact && sosContact.phone ? sosContact : null;
    if (!contact) {
      setSosError('');
      setSosOpen(true);
      return;
    }
    setSosError('');
    try {
      await sendSos({ contact, note: '🚨 SOS — I need help right now!' });
    } catch (err) { setSosError(err.message); }
  }

  async function saveSosContact(e) {
    e.preventDefault();
    try {
      setSosError('');
      const saved = setEmergencyContact({ name: sosName, phone: sosPhone });
      setSosContact(saved);
      setSosOpen(false);
      await sendSos({ contact: saved, note: '🚨 SOS — I need help right now!' });
    } catch (err) { setSosError(err.message); }
  }

  const markers = useMemo(() => {
    const m = [];
    if (driverLoc) m.push({ lat: driverLoc.lat, lng: driverLoc.lng, type: 'driver' });
    if (trip?.pickup) m.push({ lat: trip.pickup.lat, lng: trip.pickup.lng, type: 'home' });
    if (trip?.destination) m.push({ lat: trip.destination.lat, lng: trip.destination.lng, type: 'dest' });
    return m;
  }, [driverLoc, trip]);

  if (!trip) {
    return (
      <div className="screen center">
        <p className="hint">{t('common.loading')}</p>
      </div>
    );
  }

  const status = trip.status;
  const rated = status === 'completed' && trip.rating != null;

  return (
    <div className="screen">
      {toast && <div className="toast">{toast}</div>}
      <div className="book-header">
        <button className="link-btn" onClick={onExit} disabled={busy}>
          {t('common.back')}
        </button>
        <h1>{t(`trip.${status}`)}</h1>
        {(status === 'accepted' || status === 'ongoing') && (
          <button className="sos-btn" onClick={triggerSos} title="Send your location to a trusted contact">🆘 SOS</button>
        )}
      </div>

      <div className="map-wrap tall">
        <Map center={driverLoc || (trip.pickup && [trip.pickup.lat, trip.pickup.lng])} markers={markers} route={route} />
      </div>

      <div className="card trip-card">
        <div className="route-line">
          <div className="route-row"><span className="dot pickup-dot" />{trip.pickup.address || 'Pickup'}</div>
          {trip.pickup.note && <div className="route-row"><span className="dot" style={{ background: 'transparent' }} />📍 <span className="hint" style={{ margin: 0 }}>{trip.pickup.note}</span></div>}
          <div className="route-row"><span className="dot dest-dot" />{trip.destination.address || 'Destination'}</div>
          {trip.destination.note && <div className="route-row"><span className="dot" style={{ background: 'transparent' }} />📍 <span className="hint" style={{ margin: 0 }}>{trip.destination.note}</span></div>}
        </div>
        <p className="hint">{trip.distanceKm ?? '-'} km · est. {formatRand(trip.fareEstimate)}</p>

        {(status === 'accepted' || status === 'ongoing') && driver && (
          <div className="driver-row contact-row">
            <div className="avatar">{(driver.name || 'D')[0]}</div>
            <div className="driver-detail">
              <h3>{driver.name || 'Your driver'}</h3>
              <p>{driver.vehicleType}{driver.licensePlate ? ` · ${driver.licensePlate}` : ''}</p>
            </div>
            {driver.phone && (
              <div className="btn-row contact-btns">
                <a className="btn small" href={toTel(driver.phone)}>📞 Call</a>
                <a className="btn small" href={toWhatsApp(driver.phone, 'Hi, I am your DriveLocal passenger.')} target="_blank" rel="noreferrer">💬</a>
              </div>
            )}
          </div>
        )}

        {status === 'requested' && (
          <p className="hint">{t('trip.waiting')}</p>
        )}
        {status === 'accepted' && (
          <p className="hint">
            {trip.arrivedAt ? t('trip.here') : t('trip.onWay')}
          </p>
        )}
        {status === 'ongoing' && <p className="hint">{t('trip.inProgress')}</p>}

        {status === 'accepted' && trip.pickup && (
          <div className="eta-row">
            <span className="eta-chip">
              🚗 {trip.arrivedAt
                ? t('trip.driverArrived')
                : driverLoc
                  ? t('trip.arrivingIn', { min: etaMin(driverLoc, trip.pickup) })
                  : t('trip.tracking')}
            </span>
          </div>
        )}

        {(status === 'accepted' || status === 'ongoing') && (
          <button className="link-btn" onClick={shareTrip} style={{ alignSelf: 'flex-start' }}>{t('trip.share')}</button>
        )}

        {(status === 'requested' || status === 'accepted') && (
          <button className="btn danger" onClick={confirmCancel} disabled={busy} style={{ alignSelf: 'flex-start', marginTop: '6px' }}>{t('trip.cancel')}</button>
        )}

        {status === 'completed' && (
          <div className="complete-box">
            <div className="fare-summary">
              <div>
                <span className="fare-label">Estimated fare</span>
                <span className="fare-line strikethrough">{formatRand(trip.fareEstimate)}</span>
              </div>
              <div>
                <span className="fare-label">Final fare</span>
                <span className="fare-line">{formatRand(trip.finalFare)}</span>
              </div>
            </div>
            <p className="subtitle">{trip.distanceKm} km · {trip.durationMin} min</p>
            {trip.tipAmount > 0 && <p className="subtitle">including {formatRand(trip.tipAmount)} tip</p>}

            {trip.paymentMethod === 'card' && (
              <CardPay trip={trip} payment={payment} onPaid={setTrip} onPayment={setPayment} onRefund={requestRefund} refunding={refunding} />
            )}

            {trip.paymentMethod === 'cash' && (
              <div className={`pay-state ${payment?.status === 'succeeded' ? 'ok' : ''}`}>
                {payment?.status === 'succeeded'
                  ? 'Paid — cash collected by driver'
                  : 'Cash payment due to driver'}
              </div>
            )}

            {!rated ? (
              trip.fareConfirmedAt ? (
                <div className="rate-box">
                <p>{t('trip.rateTitle')}</p>
                <div className="stars-row">
                  {[1,2,3,4,5].map((n) => (
                    <button key={n} className={`star ${stars >= n ? 'on' : ''}`} onClick={() => setStars(n)}>★</button>
                  ))}
                </div>
                <div className="field">
                  <span className="field-label">How was the ride? (optional)</span>
                  <div className="fb-tags">
                    {FEEDBACK_TAGS.map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        className={`fb-tag ${fbtags.includes(tag) ? 'on' : ''}`}
                        onClick={() => setFbTags((cur) => (cur.includes(tag) ? cur.filter((x) => x !== tag) : [...cur, tag]))}
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="field">
                  <span className="field-label">{t('trip.tipLabel')}</span>
                  <div className="tips-row">
                    {[0,10,20,50].map((v) => (
                      <button key={v} className={`tip-chip ${tip === v ? 'on' : ''}`} onClick={() => setTip(v)}>{v === 0 ? t('trip.noTip') : formatRand(v)}</button>
                    ))}
                  </div>
                </div>
                {error && <p className="error">{error}</p>}
                <button className="btn primary" onClick={submitRating} disabled={stars < 1 || busy}>{busy ? '…' : t('trip.rateBtn')}</button>
                <button className="link-btn" onClick={onNewBooking}>{t('trip.bookAnother')}</button>
              </div>
              ) : (
                <div className="fare-confirm-box">
                  <p>{t('trip.fareDriver')}: <b>{formatRand(trip.finalFare)}</b></p>
                  <p className="hint">{t('trip.confirmFareHint')}</p>
                  {error && <p className="error">{error}</p>}
                  <button className="btn primary" onClick={confirmFare} disabled={confirmingFare}>
                    {confirmingFare ? '…' : t('trip.confirmFare')}
                  </button>
                </div>
              )
            ) : (
              <div className="done-box">
                <p>{t('trip.thanksRated', { stars: trip.rating })}</p>
                {trip.feedbackTags?.length > 0 && (
                  <p className="hint">📝 {trip.feedbackTags.join(' · ')}</p>
                )}
                <button className="btn primary" onClick={onNewBooking}>{t('trip.bookAnother')}</button>
                <button className="link-btn" onClick={onExit}>{t('trip.home')}</button>
              </div>
            )}
          </div>
        )}
      </div>

      {sosOpen && (
        <div className="modal-overlay">
          <form className="modal-card sos-modal" onSubmit={saveSosContact}>
            <div className="book-header">
              <h2>🆘 SOS contact</h2>
            </div>
            <p className="hint">Who should get your live location? They'll receive a WhatsApp message with a Google Maps pin.</p>
            <label className="field">
              <span className="field-label">Name (optional)</span>
              <input value={sosName} onChange={(e) => setSosName(e.target.value)} placeholder="e.g. Mom" />
            </label>
            <label className="field">
              <span className="field-label">Phone number</span>
              <input value={sosPhone} onChange={(e) => setSosPhone(e.target.value)} placeholder="+27…" inputMode="tel" />
            </label>
            {sosError && <p className="error">{sosError}</p>}
            <div className="btn-row" style={{ marginTop: '12px' }}>
              <button type="button" className="btn" onClick={() => setSosOpen(false)}>Cancel</button>
              <button type="submit" className="btn danger" style={{ background: 'var(--danger)', color: '#fff' }}>Save & send SOS</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function CardPay({ trip, payment, onPaid, onPayment, onRefund, refunding }) {
  const [step, setStep] = useState('idle'); // idle | creating | checking | paid
  const [error, setError] = useState('');

  const payStatus = payment?.status;
  const cardPaid = payStatus === 'succeeded';
  const cardRefunded = payStatus === 'refunded';

  // Create the Yoco hosted checkout and redirect the customer to Yoco's secure
  // page. The success/cancel URLs send them back to this SPA (?payment=...),
  // where the mount check below confirms the charge with the backend.
  async function begin() {
    setError('');
    setStep('creating');
    try {
      const res = await api('/payments/checkout', { method: 'POST', body: { tripId: trip.id } });
      if (res.paid) {
        onPaid(res.trip);
        setStep('paid');
        return;
      }
      if (!res.redirectUrl) {
        setError('Payment link unavailable. Choose cash instead — your driver can help.');
        setStep('idle');
        return;
      }
      // Let the button re-enable, then go to Yoco.
      setTimeout(() => { window.location.href = res.redirectUrl; }, 100);
    } catch (e) {
      setError(e.message || 'Could not start card payment');
      setStep('idle');
    }
  }

  // Returned from Yoco's hosted page (?payment=success|cancelled)? Confirm the
  // payment with the backend and refresh the trip.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const paymentParam = params.get('payment');
    if (!paymentParam) return;
    if (paymentParam === 'success') {
      setStep('checking');
      api('/payments/confirm', { method: 'POST', body: { tripId: trip.id } })
        .then((res) => {
          if (res.paid) {
            onPaid(res.trip);
            if (res.payment) onPayment(res.payment);
            setStep('paid');
          } else {
            setStep('idle');
          }
        })
        .catch((e) => {
          setError(e.message || 'Payment check failed');
          setStep('idle');
        });
    } else if (paymentParam === 'cancelled') {
      setError('Payment was cancelled. You can try again or pay by cash.');
      setStep('idle');
    }
    // Clean the query string so returning to the app doesn't re-trigger.
    const url = new URL(window.location.href);
    url.searchParams.delete('payment');
    history.replaceState(null, '', url.toString());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip.id]);

  if (cardPaid || step === 'paid') {
    return (
      <div className="card-pay paid">
        <p className="success">Card payment successful</p>
        {trip.tipAmount > 0 && <p className="subtitle">including {formatRand(trip.tipAmount)} tip</p>}
        {onRefund && (
          <button className="link-btn" onClick={onRefund} disabled={refunding || cardRefunded}>
            {cardRefunded ? 'Refunded' : 'Request refund'}
          </button>
        )}
      </div>
    );
  }

  if (cardRefunded) {
    return <p className="success">Card payment refunded</p>;
  }

  return (
    <div className="card-pay">
      <p className="subtitle">Pay {formatRand(trip.finalFare)} by card</p>
      <p className="hint">You'll be taken to a secure payment page. Cash is always welcome as well.</p>
      <button className="btn primary" onClick={begin} disabled={step !== 'idle'}>
        {step === 'creating' ? 'Preparing…' : step === 'checking' ? 'Checking payment…' : 'Pay by card'}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
