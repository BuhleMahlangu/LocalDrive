import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import Icon from '../components/Icon.jsx';
import { useI18n, LangToggle } from '../i18n.jsx';

export default function Landing({ onChoose }) {
  const { t } = useI18n();
  const [online, setOnline] = useState(null); // null = unknown
  const [driver, setDriver] = useState(null);

  useEffect(() => {
    api('/customer/driver/availability').then((r) => setOnline(!!r.isOnline)).catch(() => setOnline(null));
    api('/customer/driver').then(setDriver).catch(() => setDriver(null));
  }, []);

  return (
    <div className="login-screen landing-screen">
      <LangToggle className="lang-toggle top-right" />
      <div className="brand-hero">
        <div className="brand-badge"><img src="/pwa-192.png" alt="DriveLocal logo" /></div>
        <h1>DriveLocal</h1>
        <p>{t('landing.tagline')}</p>
      </div>

      <div className="card landing-card">
        {online != null && (
          <div className={`online-strip ${online ? 'up' : ''}`}>
            {online
              ? `🟢 ${driver?.name || t('common.driver')} ${t('landing.online')}`
              : t('landing.offline')}
          </div>
        )}

        <button type="button" className="btn primary big" onClick={() => onChoose('customer')}>
          <Icon name="book" size={20} /> {t('landing.customer')}
        </button>

        <div className="hero-feats">
          <span className="feat">Live GPS tracking</span>
          <span className="feat">Cash or card</span>
          <span className="feat">Drop-pin pickup</span>
        </div>

        <div className="landing-divider">{t('common.driver')}?</div>

        <button type="button" className="btn driver big" onClick={() => onChoose('driver')}>
          <Icon name="car" size={20} /> {t('landing.driver')}
        </button>
        <p className="hint">{t('login.driverHint')} — {t('landing.driverShort')}</p>
      </div>
    </div>
  );
}