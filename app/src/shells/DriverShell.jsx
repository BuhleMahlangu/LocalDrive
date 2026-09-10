import React, { useState } from 'react';
import Dashboard from '../screens/driver/Dashboard.jsx';
import Profile from '../screens/driver/Profile.jsx';
import Trips from '../screens/driver/Trips.jsx';
import Admin from '../screens/driver/Admin.jsx';
import ThemeToggle from '../components/ThemeToggle.jsx';
import Icon from '../components/Icon.jsx';

export default function DriverShell({ user, setUser, onLogout, onSwitchRole }) {
  const [view, setView] = useState('dashboard');

  // The Dashboard runs a live geolocation loop and socket while mounted, so it is
  // torn down when you leave it. Trips and Profile are light, one-shot screens
  // and stay mounted (hidden via CSS) so switching between them never rebuilds
  // them (which re-fired API calls and replayed mount animations -> flicker).
  const showDashboard = view === 'dashboard';

  return (
    <div className="app driver-app">
      <header className="dash-header">
        <span className="brand brand-logomark"><img src="/logo-horizontal.png" alt="DriveLocal" /><em>Driver</em></span>
        <span className="user-chip">{user.name || user.phone}</span>
        <button className="chip-btn" onClick={() => onSwitchRole('customer')} title="Preview the customer app">
          <Icon name="swap" size={14} /> Customer mode
        </button>
        <ThemeToggle />
        <button className="link-btn" onClick={onLogout}>Log out</button>
      </header>

      {showDashboard && <Dashboard user={user} onUserUpdate={setUser} />}

      <div style={{ display: view === 'trips' ? undefined : 'none' }}>
        <Trips />
      </div>

      <div style={{ display: view === 'profile' ? undefined : 'none' }}>
        <Profile user={user} onUserUpdate={setUser} />
      </div>

      <div style={{ display: view === 'admin' ? undefined : 'none' }}>
        <Admin />
      </div>

      <nav className="bottom-nav">
        <button className={view === 'dashboard' ? 'nav-btn active' : 'nav-btn'} onClick={() => setView('dashboard')}>
          <Icon name="home" className="nav-icon" /> Home
        </button>
        <button className={view === 'trips' ? 'nav-btn active' : 'nav-btn'} onClick={() => setView('trips')}>
          <Icon name="trips" className="nav-icon" /> Trips
        </button>
        <button className={view === 'admin' ? 'nav-btn active' : 'nav-btn'} onClick={() => setView('admin')}>
          <Icon name="gear" className="nav-icon" /> Admin
        </button>
        <button className={view === 'profile' ? 'nav-btn active' : 'nav-btn'} onClick={() => setView('profile')}>
          <Icon name="profile" className="nav-icon" /> Profile
        </button>
      </nav>
    </div>
  );
}
