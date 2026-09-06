import React, { useEffect, useMemo, useRef, useState } from 'react';
import Map from '../../components/Map.jsx';
import { api, connectSocket, formatRand, toTel, toWhatsApp } from '../../api.js';
export default function ActiveTrip({ initial, onExit, onNewBooking }) {
  const [trip, setTrip] = useState(initial);
  const [driver, setDriver] = useState(null);
  const [driverLoc, setDriverLoc] = useState(null);
  const [route, setRoute] = useState(null);
  const [stars, setStars] = useState(0);
  const [tip, setTip] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [payment, setPayment] = useState(null);
  const [refunding, setRefunding] = useState(false);
  const socketRef = useRef(null);

  useEffect(() => {
    api('/customer/driver').then(setDriver).catch(() => {});
    api('/customer/trips/active').then((r) => r.trip && setTrip(r.trip)).catch(() => {});
    if (initial?.id) {
      api(`/customer/trips/${initial.id}`).catch(() => {});
    }

    const socket = connectSocket();
    socketRef.current = socket;
    socket.on('trip:updated', (data) => data?.trip && setTrip(data.trip));
    socket.on('trip:accepted', (data) => data?.trip && setTrip(data.trip));
    socket.on('trip:location', (data) => {
      if (data?.tripId === trip?.id) setDriverLoc({ lat: data.lat, lng: data.lng });
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

  function submitRating() {
    if (!trip || stars < 1) return;
    setBusy(true);
    setError('');
    api(`/customer/trips/${trip.id}/rate`, { method: 'POST', body: { stars, tipAmount: tip } })
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
        <p className="hint">No active trip.</p>
        <button className="btn" onClick={onNewBooking}>Book a ride</button>
      </div>
    );
  }

  const status = trip.status;
  const rated = status === 'completed' && trip.rating != null;

  return (
    <div className="screen">
      <div className="book-header">
        <button className="link-btn" onClick={status === 'completed' ? onExit : (['requested','accepted'].includes(status) ? cancel : undefined)} disabled={busy}>
          {status === 'completed' ? '‹ Home' : (['requested','accepted'].includes(status) ? '‹ Cancel' : '')}
        </button>
        <h1>{statusLabel(status)}</h1>
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
          <p className="hint">Waiting for your driver to accept…</p>
        )}
        {status === 'accepted' && <p className="hint">Your driver is on the way. Track their car approaching you.</p>}
        {status === 'ongoing' && <p className="hint">Trip in progress — tracking in real time.</p>}

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
              <div className="rate-box">
                <p>How was your ride?</p>
                <div className="stars-row">
                  {[1,2,3,4,5].map((n) => (
                    <button key={n} className={`star ${stars >= n ? 'on' : ''}`} onClick={() => setStars(n)}>★</button>
                  ))}
                </div>
                <div className="field">
                  <span className="field-label">Add a tip</span>
                  <div className="tips-row">
                    {[0,10,20,50].map((v) => (
                      <button key={v} className={`tip-chip ${tip === v ? 'on' : ''}`} onClick={() => setTip(v)}>{v === 0 ? 'No tip' : formatRand(v)}</button>
                    ))}
                  </div>
                </div>
                {error && <p className="error">{error}</p>}
                <button className="btn primary" onClick={submitRating} disabled={stars < 1 || busy}>{busy ? 'Saving…' : 'Rate & tip'}</button>
                <button className="link-btn" onClick={onNewBooking}>Book another ride</button>
              </div>
            ) : (
              <div className="done-box">
                <p>Thanks! You rated {trip.rating}★</p>
                <button className="btn primary" onClick={onNewBooking}>Book another ride</button>
                <button className="link-btn" onClick={onExit}>Back to home</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function statusLabel(s) {
  switch (s) {
    case 'requested': return 'Booking requested';
    case 'accepted': return 'Driver on the way';
    case 'ongoing': return 'Trip in progress';
    case 'completed': return 'Trip complete';
    case 'cancelled': return 'Trip cancelled';
    default: return s;
  }
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
    if (params.get('payment') !== 'success') return;
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
    // Clean the query string so returning to the app doesn't re-confirm.
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
