import React, { useState } from 'react';
import { api, setSession } from '../api.js';
import { useI18n, LangToggle } from '../i18n.jsx';

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
      <LangToggle className="lang-toggle top-right" />
      <div className="brand-hero">
        <div className="brand-badge"><img src="/pwa-192.png" alt="DriveLocal logo" /></div>
        <h1>DriveLocal</h1>
        <p>{isDriver ? t('login.taglineDriver') : t('login.taglineCustomer')}</p>
        {onBack && (
          <span className="back-link" onClick={onBack}>{t('login.changeRole')}</span>
        )}
      </div>

      {step === 'phone' ? (
        <form className="card" onSubmit={requestCode}>
          <h2>{isDriver ? t('login.titleDriver') : t('login.titleCustomer')}</h2>
          <label>
            {t('common.phone')}
            <input type="tel" inputMode="tel" placeholder={t('login.ph')} value={phone} onChange={handlePhone} required autoFocus />
          </label>
          {error && <p className="error">{error}</p>}
          <button className={`btn ${isDriver ? 'driver' : 'primary'}`} disabled={loading}>{loading ? t('login.sending') : t('login.requestCode')}</button>
          <p className="hint">{t('login.devHint')}</p>
        </form>
      ) : (
        <form className="card" onSubmit={verify}>
          <h2>{t('login.enterCode')}</h2>
          <p className="hint">{t('login.codeSent', { phone })}</p>
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
          <button className={`btn ${isDriver ? 'driver' : 'primary'}`} disabled={loading}>{loading ? t('login.verifying') : t('login.verify')}</button>
          <button type="button" className="link-btn" onClick={() => setStep('phone')} disabled={loading}>{t('login.changePhone')}</button>
        </form>
      )}
    </div>
  );
}
