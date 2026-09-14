import React, { useState } from 'react';
import Home from '../screens/customer/Home.jsx';
import Book from '../screens/customer/Book.jsx';
import ActiveTrip from '../screens/customer/ActiveTrip.jsx';
import History from '../screens/customer/History.jsx';
import ThemeToggle from '../components/ThemeToggle.jsx';
import ErrorBoundary from '../components/ErrorBoundary.jsx';
import Icon from '../components/Icon.jsx';
import Onboarding, { hasSeenOnboarding } from '../components/Onboarding.jsx';
import { LangToggle } from '../i18n.jsx';
import { isDriverUser, api } from '../api.js';

export default function CustomerShell({ user, onLogout, onSwitchRole }) {
  const [view, setView] = useState('home');
  const [activeTrip, setActiveTrip] = useState(null);
  const [rebookDest, setRebookDest] = useState(null);
  // Bumped whenever the customer returns Home so its "ongoing trip" card and
  // upcoming list are re-fetched (they are fetched once per visit, not live).
  const [homeRefresh, setHomeRefresh] = useState(0);
  // First-run walkthrough for new customers.
  const [showOnboarding, setShowOnboarding] = useState(() => !hasSeenOnboarding());

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

  // Resume an accepted/ongoing trip: Home carries the trip it fetched, but when
  // called without one (Book screen) re-fetch it so ActiveTrip never mounts bare.
  function resumeActive(trip) {
    if (trip) {
      openActive(trip);
      return;
    }
    setView('active');
    api('/customer/trips/active')
      .then((r) => r.trip && setActiveTrip(r.trip))
      .catch(() => setActiveTrip(null));
  }

  function goHome() {
    setActiveTrip(null);
    setView('home');
    setHomeRefresh((n) => n + 1);
  }

  function startRebook(trip) {
    setRebookDest(trip ? trip.destination : null);
    setView('book');
  }

  function closeActive() {
    setActiveTrip(null);
    setRebookDest(null);
    setView('home');
    setHomeRefresh((n) => n + 1);
  }

  // Home / Book / History stay mounted and are hidden with CSS so that switching
  // tabs never tears down and rebuilds the screens (which re-fired every API
  // call and replayed mount animations, causing visible flicker). ActiveTrip is
  // mounted only when opened so its socket doesn't linger in the background.
  const showActive = view === 'active';

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand brand-logomark"><img src="/logo-horizontal.png" alt="DriveLocal" /></span>
        <span className="user-chip">{user.name || user.phone}</span>
        {canBeDriver && (
          <button className="chip-btn" onClick={() => onSwitchRole('driver')} title="Open driver dashboard">
            <Icon name="swap" size={14} /> Driver mode
          </button>
        )}
        <ThemeToggle />
        <LangToggle />
        <button className="link-btn" onClick={onLogout}>Log out</button>
      </header>

      <div style={{ display: view === 'home' ? undefined : 'none' }}>
        <ErrorBoundary resetKey="home">
          <Home
            user={user}
            refreshKey={homeRefresh}
            onBook={() => { setRebookDest(null); setView('book'); }}
            onResume={resumeActive}
            onRebook={(trip) => { setRebookDest(trip ? trip.destination : null); setView('book'); }}
            onPickPlace={(place) => {
              setRebookDest({ lat: place.lat, lng: place.lng, address: place.address || place.label, note: place.note });
              setView('book');
            }}
          />
        </ErrorBoundary>
      </div>

      <div style={{ display: view === 'book' ? undefined : 'none' }}>
        <ErrorBoundary resetKey="book">
          <Book
            user={user}
            presetDest={rebookDest}
            onBack={goHome}
            onRequest={(trip) => { setRebookDest(null); openActive(trip); }}
            onResume={resumeActive}
          />
        </ErrorBoundary>
      </div>

      <div style={{ display: view === 'history' ? undefined : 'none' }}>
        <ErrorBoundary resetKey="history">
          <History user={user} onBack={goHome} onRebook={startRebook} />
        </ErrorBoundary>
      </div>

      {showActive && (
        <div>
          <ErrorBoundary resetKey="active" onReset={closeActive}>
            <ActiveTrip
              user={user}
              initial={activeTrip}
              onExit={closeActive}
              onNewBooking={() => { setActiveTrip(null); setView('book'); }}
            />
          </ErrorBoundary>
        </div>
      )}

      <nav className="bottom-nav">
        <button className={view === 'home' ? 'nav-btn active' : 'nav-btn'} onClick={goHome}>
          <Icon name="home" className="nav-icon" /> Home
        </button>
        <button className={view === 'book' ? 'nav-btn active' : 'nav-btn'} onClick={() => { setActiveTrip(null); setView('book'); }}>
          <Icon name="book" className="nav-icon" /> Book
        </button>
        <button className={view === 'history' ? 'nav-btn active' : 'nav-btn'} onClick={() => setView('history')}>
          <Icon name="history" className="nav-icon" /> Trips
        </button>
      </nav>

      {showOnboarding && (
        <Onboarding onDone={() => setShowOnboarding(false)} />
      )}
    </div>
  );
}
