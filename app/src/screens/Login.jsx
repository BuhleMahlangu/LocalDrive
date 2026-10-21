import React, { useState } from 'react';
import { api, setSession } from '../api.js';
import { useI18n, LangToggle } from '../i18n.jsx';

export default function Login({ role = 'customer', onLogin, onBack }) {
  const { t } = useI18n();
  const isDriver = role === 'driver';
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  // 'phone' → 'login' (existing account) or 'setup' (first time: choose a PIN).
  const [step, setStep] = useState('phone');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  function handlePhone(e) {
    // Friendly live formatting for SA numbers as they type (keeps the raw input clean).
    const raw = e.target.value.replace(/[^\d+]/g, '');
    setPhone(raw);
  }

  function handlePin(e, setter) {
    // PINs are digits only, max 6.
    setter(e.target.value.replace(/\D/g, '').slice(0, 6));
  }

  // Ask the server whether this number already has a PIN, then show the right step.
  async function checkNumber(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await api('/auth/account', { method: 'POST', body: { phone } });
      setPhone(res?.phone || phone);
      setStep(res?.hasPin ? 'login' : 'setup');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function login(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await api('/auth/pin/login', { method: 'POST', body: { phone, pin, role } });
      setSession(res.token, res.user);
      onLogin(res.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function setup(e) {
    e.preventDefault();
    setError('');
    if (pin.length !== 6) { setError(t('login.pinLength')); return; }
    if (pin !== confirmPin) { setError(t('login.pinMismatch')); return; }
    setLoading(true);
    try {
      const res = await api('/auth/pin/setup', {
        method: 'POST',
        body: { phone, pin, name: name.trim() || undefined, email: email.trim() || undefined, role },
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
      <LangToggle className="lang-toggle top-right" />
      <div className="brand-hero">
        <div className="brand-badge"><img src="/pwa-192.png" alt="DriveLocal logo" /></div>
        <h1>DriveLocal</h1>
        <p className="hero-tagline">{isDriver ? t('login.taglineDriver') : t('login.taglineCustomer')}</p>
        {onBack && (
          <button type="button" className="back-link" onClick={onBack}>{t('login.changeRole')}</button>
        )}
      </div>

      {step === 'phone' && (
        <form className="card animate-in" onSubmit={checkNumber}>
          <h2>{isDriver ? t('login.titleDriver') : t('login.titleCustomer')}</h2>
          <label>
            {t('common.phone')}
            <input type="tel" inputMode="tel" placeholder={t('login.ph')} value={phone} onChange={handlePhone} required autoFocus />
          </label>
          {error && <p className="error">{error}</p>}
          <button className={`btn ${isDriver ? 'driver' : 'primary'} big`} disabled={loading}>{loading ? t('login.checking') : t('login.continue')}</button>
        </form>
      )}

      {step === 'login' && (
        <form className="card animate-in" onSubmit={login}>
          <h2>{t('login.enterPin')}</h2>
          <p className="hint">{t('login.pinFor', { phone })}</p>
          <label>
            {t('login.pin')}
            <input type="password" inputMode="numeric" maxLength="6" placeholder="••••••" value={pin} onChange={(e) => handlePin(e, setPin)} required autoFocus />
          </label>
          {error && <p className="error">{error}</p>}
          <button className={`btn ${isDriver ? 'driver' : 'primary'} big`} disabled={loading}>{loading ? t('login.verifying') : t('login.signIn')}</button>
          <button type="button" className="link-btn" onClick={() => { setStep('phone'); setPin(''); setError(''); }} disabled={loading}>{t('login.changePhone')}</button>
        </form>
      )}

      {step === 'setup' && (
        <form className="card animate-in" onSubmit={setup}>
          <h2>{t('login.createPin')}</h2>
          <p className="hint">{t('login.createPinHint')}</p>
          <label>
            {t('login.yourName')}
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Thabo" />
          </label>
          <label>
            {t('login.email')} ({t('login.emailOptional')})
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@email.com" />
          </label>
          <label>
            {t('login.pin')}
            <input type="password" inputMode="numeric" maxLength="6" placeholder="••••••" value={pin} onChange={(e) => handlePin(e, setPin)} required autoFocus />
          </label>
          <label>
            {t('login.confirmPin')}
            <input type="password" inputMode="numeric" maxLength="6" placeholder="••••••" value={confirmPin} onChange={(e) => handlePin(e, setConfirmPin)} required />
          </label>
          {error && <p className="error">{error}</p>}
          <button className={`btn ${isDriver ? 'driver' : 'primary'} big`} disabled={loading}>{loading ? t('login.saving') : t('login.createAccount')}</button>
          <button type="button" className="link-btn" onClick={() => { setStep('phone'); setPin(''); setConfirmPin(''); setError(''); }} disabled={loading}>{t('login.changePhone')}</button>
        </form>
      )}
    </div>
  );
}
