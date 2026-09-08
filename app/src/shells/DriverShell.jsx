import React, { useState } from 'react';
import Dashboard from '../screens/driver/Dashboard.jsx';
import Profile from '../screens/driver/Profile.jsx';
import Trips from '../screens/driver/Trips.jsx';
import ThemeToggle from '../components/ThemeToggle.jsx';

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
        <span className="brand">DriveLocal · Driver</span>
        <span className="user-chip">{user.name || user.phone}</span>
        <button className="chip-btn" onClick={() => onSwitchRole('customer')} title="Preview the customer app">🙂 Customer mode</button>
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

      <nav className="bottom-nav">
        <button className={view === 'dashboard' ? 'nav-btn active' : 'nav-btn'} onClick={() => setView('dashboard')}>🏠 Home</button>
        <button className={view === 'trips' ? 'nav-btn active' : 'nav-btn'} onClick={() => setView('trips')}>📋 Trips</button>
        <button className={view === 'profile' ? 'nav-btn active' : 'nav-btn'} onClick={() => setView('profile')}>⚙️ Profile</button>
      </nav>
    </div>
  );
}
