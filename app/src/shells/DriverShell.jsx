import React, { useState } from 'react';
import Dashboard from '../screens/driver/Dashboard.jsx';
import Profile from '../screens/driver/Profile.jsx';
import Trips from '../screens/driver/Trips.jsx';
import Admin from '../screens/driver/Admin.jsx';
import Analytics from '../screens/driver/Analytics.jsx';
import Revenue from '../screens/driver/Revenue.jsx';
import ThemeToggle from '../components/ThemeToggle.jsx';
import ErrorBoundary from '../components/ErrorBoundary.jsx';
import Icon from '../components/Icon.jsx';
import { isAdminUser } from '../api.js';
import { LangToggle, useI18n } from '../i18n.jsx';

export default function DriverShell({ user, setUser, onLogout, onSwitchRole }) {
  const { t } = useI18n();
  const [view, setView] = useState('dashboard');

  // The Dashboard runs the live geolocation loop and the socket that keeps the
  // driver online and receiving requests, so it is mounted once and only
  // hidden — never torn down — when you switch tabs. Unmounting it dropped the
  // socket, and after the auto-offline grace period the driver silently went
  // offline while their app still said "Online". Trips/Profile etc. are light
  // one-shot screens and are hidden (via CSS) the same way.
  const showDashboard = view === 'dashboard';
  const hasAdmin = isAdminUser(user);

  const navItems = (
    <>
      <button className={view === 'dashboard' ? 'nav-btn active' : 'nav-btn'} onClick={() => setView('dashboard')} aria-current={view === 'dashboard' ? 'page' : undefined}>
        <Icon name="home" className="nav-icon" /> {t('nav.home')}
      </button>
      <button className={view === 'trips' ? 'nav-btn active' : 'nav-btn'} onClick={() => setView('trips')} aria-current={view === 'trips' ? 'page' : undefined}>
        <Icon name="trips" className="nav-icon" /> {t('nav.trips')}
      </button>
      <button className={view === 'analytics' ? 'nav-btn active' : 'nav-btn'} onClick={() => setView('analytics')} aria-current={view === 'analytics' ? 'page' : undefined}>
        <Icon name="chart" className="nav-icon" /> {t('nav.insights')}
      </button>
      <button className={view === 'revenue' ? 'nav-btn active' : 'nav-btn'} onClick={() => setView('revenue')} aria-current={view === 'revenue' ? 'page' : undefined}>
        <Icon name="coins" className="nav-icon" /> {t('nav.payouts')}
      </button>
      {hasAdmin && (
        <button className={view === 'admin' ? 'nav-btn active' : 'nav-btn'} onClick={() => setView('admin')} aria-current={view === 'admin' ? 'page' : undefined}>
          <Icon name="gear" className="nav-icon" /> {t('nav.admin')}
        </button>
      )}
      <button className={view === 'profile' ? 'nav-btn active' : 'nav-btn'} onClick={() => setView('profile')} aria-current={view === 'profile' ? 'page' : undefined}>
        <Icon name="profile" className="nav-icon" /> {t('nav.profile')}
      </button>
    </>
  );

  return (
    <div className="app driver-app">
      {/* Desktop: fixed sidebar (≥900px) */}
      <nav className="side-nav" aria-label="Main">
        <span className="brand brand-logomark side-brand"><img src="/logo-horizontal.png" alt="DriveLocal" /><em>{t('common.driver')}</em></span>
        <div className="side-items">{navItems}</div>
        <div className="side-foot">
          <span className="user-chip">{user.name || user.phone}</span>
          <button className="chip-btn" onClick={() => onSwitchRole('customer')} title={t('common.customerMode')}>
            <Icon name="swap" size={14} /> {t('common.customerMode')}
          </button>
          <div className="side-toggles">
            <ThemeToggle />
            <LangToggle />
          </div>
          <button className="link-btn" onClick={onLogout}>{t('common.logout')}</button>
        </div>
      </nav>

      {/* Mobile: gradient header (hidden ≥900px) */}
      <header className="dash-header">
        <span className="brand brand-logomark"><img src="/logo-horizontal.png" alt="DriveLocal" /><em>{t('common.driver')}</em></span>
        <span className="user-chip">{user.name || user.phone}</span>
        <button className="chip-btn" onClick={() => onSwitchRole('customer')} title={t('common.customerMode')}>
          <Icon name="swap" size={14} /> {t('common.customerMode')}
        </button>
        <ThemeToggle />
        <LangToggle />
        <button className="link-btn" onClick={onLogout}>{t('common.logout')}</button>
      </header>

      <div style={{ display: showDashboard ? undefined : 'none' }}>
        <ErrorBoundary resetKey="dashboard"><Dashboard user={user} onUserUpdate={setUser} /></ErrorBoundary>
      </div>

      <div style={{ display: view === 'trips' ? undefined : 'none' }}>
        <ErrorBoundary resetKey="trips"><Trips /></ErrorBoundary>
      </div>

      <div style={{ display: view === 'analytics' ? undefined : 'none' }}>
        <ErrorBoundary resetKey="analytics"><Analytics /></ErrorBoundary>
      </div>

      <div style={{ display: view === 'revenue' ? undefined : 'none' }}>
        <ErrorBoundary resetKey="revenue"><Revenue /></ErrorBoundary>
      </div>

      <div style={{ display: view === 'profile' ? undefined : 'none' }}>
        <ErrorBoundary resetKey="profile"><Profile user={user} onUserUpdate={setUser} /></ErrorBoundary>
      </div>

      <div style={{ display: view === 'admin' ? undefined : 'none' }}>
        <ErrorBoundary resetKey="admin"><Admin /></ErrorBoundary>
      </div>

      {/* Mobile: floating bottom nav (hidden ≥900px) */}
      <nav className="bottom-nav">
        {navItems}
      </nav>
    </div>
  );
}
