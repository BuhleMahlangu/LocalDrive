import React, { useState } from 'react';
import Home from '../screens/customer/Home.jsx';
import Book from '../screens/customer/Book.jsx';
import ActiveTrip from '../screens/customer/ActiveTrip.jsx';
import History from '../screens/customer/History.jsx';
import ThemeToggle from '../components/ThemeToggle.jsx';
import Icon from '../components/Icon.jsx';
import { isDriverUser } from '../api.js';

export default function CustomerShell({ user, onLogout, onSwitchRole }) {
  const [view, setView] = useState('home');
  const [activeTrip, setActiveTrip] = useState(null);
  const [rebookDest, setRebookDest] = useState(null);

  // If the logged-in user is also the driver (owner), offer to switch to driver mode.
  const canBeDriver = isDriverUser(user);

  function openActive(trip) {
    // Scheduled rides aren't live yet — return home so the "Upcoming" card shows.
    if (trip && trip.status === 'scheduled') {
      setActiveTrip(null);
      setRebookDest(null);
      setView('home');
      return;
    }
    setActiveTrip(trip);
    setView('active');
  }

  function startRebook(trip) {
    setRebookDest(trip ? trip.destination : null);
    setView('book');
  }

  function closeActive() {
    setActiveTrip(null);
    setRebookDest(null);
    setView('home');
  }

  // Home / Book / History stay mounted and are hidden with CSS so that switching
  // tabs never tears down and rebuilds the screens (which re-fired every API
  // call and replayed mount animations, causing visible flicker). ActiveTrip is
  // mounted only when opened so its socket doesn't linger in the background.
  const showActive = view === 'active';

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">DriveLocal</span>
        <span className="user-chip">{user.name || user.phone}</span>
        {canBeDriver && (
          <button className="chip-btn" onClick={() => onSwitchRole('driver')} title="Open driver dashboard">
            <Icon name="swap" size={14} /> Driver mode
          </button>
        )}
        <ThemeToggle />
        <button className="link-btn" onClick={onLogout}>Log out</button>
      </header>

      <div style={{ display: view === 'home' ? undefined : 'none' }}>
        <Home
          user={user}
          onBook={() => { setRebookDest(null); setView('book'); }}
          onResume={() => setView('active')}
          onRebook={(trip) => { setRebookDest(trip ? trip.destination : null); setView('book'); }}
          onPickPlace={(place) => {
            setRebookDest({ lat: place.lat, lng: place.lng, address: place.address || place.label, note: place.note });
            setView('book');
          }}
        />
      </div>

      <div style={{ display: view === 'book' ? undefined : 'none' }}>
        <Book
          user={user}
          presetDest={rebookDest}
          onBack={() => { setRebookDest(null); setView('home'); }}
          onRequest={(trip) => { setRebookDest(null); openActive(trip); }}
          onResume={() => setView('active')}
        />
      </div>

      <div style={{ display: view === 'history' ? undefined : 'none' }}>
        <History user={user} onBack={() => setView('home')} onRebook={startRebook} />
      </div>

      {showActive && (
        <div>
          <ActiveTrip
            user={user}
            initial={activeTrip}
            onExit={closeActive}
            onNewBooking={() => { setActiveTrip(null); setView('book'); }}
          />
        </div>
      )}

      <nav className="bottom-nav">
        <button className={view === 'home' ? 'nav-btn active' : 'nav-btn'} onClick={() => setView('home')}>
          <Icon name="home" className="nav-icon" /> Home
        </button>
        <button className={view === 'book' ? 'nav-btn active' : 'nav-btn'} onClick={() => { setActiveTrip(null); setView('book'); }}>
          <Icon name="book" className="nav-icon" /> Book
        </button>
        <button className={view === 'history' ? 'nav-btn active' : 'nav-btn'} onClick={() => setView('history')}>
          <Icon name="history" className="nav-icon" /> Trips
        </button>
      </nav>
    </div>
  );
}
