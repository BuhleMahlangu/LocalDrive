import React, { useEffect, useState } from 'react';
import { api, setSession } from '../api.js';
import { useI18n, LangToggle } from '../i18n.jsx';
import { loadAppConfig } from '../lib/appConfig.js';

export default function Login({ role = 'customer', onLogin, onBack }) {
  const { t } = useI18n();
  const isDriver = role === 'driver';
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState('phone');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // How the last OTP was delivered: 'sms' | 'email' | 'console' (dev fallback).
  const [delivery, setDelivery] = useState(null);
  const [devMode, setDevMode] = useState(false);
  // Which channel this deployment uses ('sms' | 'email' | 'console'): when it's
  // email, the address is required — otherwise the code would be sent nowhere.
  const [channel, setChannel] = useState('sms');
  const emailRequired = channel === 'email';

  useEffect(() => {
    let alive = true;
    loadAppConfig().then((c) => { if (alive) setChannel(c.otpDelivery); });
    return () => { alive = false; };
  }, []);

  function handlePhone(e) {
    // Friendly live formatting for SA numbers as they type (keeps the raw input clean).
    const raw = e.target.value.replace(/[^\d+]/g, '');
    setPhone(raw);
  }

  async function requestCode(e) {
    e.preventDefault();
    setError('');
    if (emailRequired && !email.trim()) {
      setError(t('login.emailRequired'));
      return;
    }
    setLoading(true);
    try {
      const res = await api('/auth/otp/request', { method: 'POST', body: { phone, role, email: email.trim() || undefined } });
      setDelivery(res?.delivery || 'sms');
      setDevMode(!!res?.dev);
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
      <LangToggle className="lang-toggle top-right" />
      <div className="brand-hero">
        <div className="brand-badge"><img src="/pwa-192.png" alt="DriveLocal logo" /></div>
        <h1>DriveLocal</h1>
        <p className="hero-tagline">{isDriver ? t('login.taglineDriver') : t('login.taglineCustomer')}</p>
        {onBack && (
          <button type="button" className="back-link" onClick={onBack}>{t('login.changeRole')}</button>
        )}
      </div>

      {step === 'phone' ? (
        <form className="card animate-in" onSubmit={requestCode}>
          <h2>{isDriver ? t('login.titleDriver') : t('login.titleCustomer')}</h2>
          <label>
            {t('common.phone')}
            <input type="tel" inputMode="tel" placeholder={t('login.ph')} value={phone} onChange={handlePhone} required autoFocus />
          </label>
          <label>
            {t('login.email')}{emailRequired ? '' : ` (${t('login.emailOptional')})`}
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@email.com"
              required={emailRequired}
            />
          </label>
          {error && <p className="error">{error}</p>}
          <button className={`btn ${isDriver ? 'driver' : 'primary'} big`} disabled={loading}>{loading ? t('login.sending') : t('login.requestCode')}</button>
        </form>
      ) : (
        <form className="card animate-in" onSubmit={verify}>
          <h2>{t('login.enterCode')}</h2>
          <p className="hint">
            {delivery === 'email' && email.trim()
              ? t('login.emailSent', { email: email.trim() })
              : delivery === 'console'
                ? t('login.codeSent', { phone })
                : t('login.smsSent', { phone })}
          </p>
          {devMode && <p className="hint">{t('login.devHint')}</p>}
          <label>
            {t('login.verificationCode')}
            <input type="text" inputMode="numeric" maxLength="6" placeholder={t('login.codePh')} value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
          </label>
          <label>
            {t('login.yourName')}
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Thabo" />
          </label>
          <label>
            {t('login.email')}
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@email.com" />
          </label>
          {error && <p className="error">{error}</p>}
          <button className={`btn ${isDriver ? 'driver' : 'primary'} big`} disabled={loading}>{loading ? t('login.verifying') : t('login.verify')}</button>
          <button type="button" className="link-btn" onClick={() => setStep('phone')} disabled={loading}>{t('login.changePhone')}</button>
        </form>
      )}
    </div>
  );
}
