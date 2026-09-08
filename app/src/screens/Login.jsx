import React, { useState } from 'react';
import { api, setSession } from '../api.js';

export default function Login({ role = 'customer', onLogin, onBack }) {
  const isDriver = role === 'driver';
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState('phone');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  function handlePhone(e) {
    // Friendly live formatting for SA numbers as they type (keeps the raw input clean).
    const raw = e.target.value.replace(/[^\d+]/g, '');
    setPhone(raw);
  }

  async function requestCode(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api('/auth/otp/request', { method: 'POST', body: { phone, role } });
      setStep('code');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function verify(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await api('/auth/otp/verify', {
        method: 'POST',
        body: { phone, code, name, email, role },
      });
      setSession(res.token, res.user);
      onLogin(res.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-screen">
      <div className="brand-hero">
        <div className="brand-badge">DL</div>
        <h1>DriveLocal</h1>
        <p>{isDriver ? 'Driver login — manage trips and bookings.' : 'Your trusted local driver — book in seconds.'}</p>
        {onBack && (
          <span className="back-link" onClick={onBack}>‹ Change (customer / driver)</span>
        )}
      </div>

      {step === 'phone' ? (
        <form className="card" onSubmit={requestCode}>
          <h2>{isDriver ? 'Driver login' : 'Log in with your phone'}</h2>
          <label>
            Phone number
            <input type="tel" inputMode="tel" placeholder="+27 82 000 0000" value={phone} onChange={handlePhone} required autoFocus />
          </label>
          {error && <p className="error">{error}</p>}
          <button className={`btn ${isDriver ? 'driver' : 'primary'}`} disabled={loading}>{loading ? 'Sending…' : 'Request code'}</button>
          <p className="hint">
            We text you a one-time code. In local development the code is also shown in the server console.
          </p>
        </form>
      ) : (
        <form className="card" onSubmit={verify}>
          <h2>Enter your code</h2>
          <p className="hint">Code sent to {phone}</p>
          <label>
            Verification code
            <input type="text" inputMode="numeric" maxLength="6" placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
          </label>
          <label>
            Your name (optional)
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Thabo" />
          </label>
          <label>
            Email (optional)
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@email.com" />
          </label>
          {error && <p className="error">{error}</p>}
          <button className={`btn ${isDriver ? 'driver' : 'primary'}`} disabled={loading}>{loading ? 'Verifying…' : 'Verify & continue'}</button>
          <button type="button" className="link-btn" onClick={() => setStep('phone')} disabled={loading}>Change phone number</button>
        </form>
      )}
    </div>
  );
}
