import React, { useState, useEffect } from 'react';
import Landing from './screens/Landing.jsx';
import Login from './screens/Login.jsx';
import DriverShell from './shells/DriverShell.jsx';
import CustomerShell from './shells/CustomerShell.jsx';
import DriverApply from './screens/driver/Apply.jsx';
import TripTracker from './screens/track/TripTracker.jsx';
import PWAInstallPrompt from './components/PWAInstallPrompt.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { LangProvider } from './i18n.jsx';
import { getToken, getStoredUser, isDriverUser, isApprovedDriver, isAdminUser, clearSession, api } from './api.js';

// A shared trip link is /trip/<id> — the tracker is a standalone public page
// that works without logging in, so the tracker takes priority over everything.
function sharedTripId() {
  const m = window.location.pathname.match(/^\/trip\/([^/]+)\/?$/);
  return m ? m[1] : null;
}

export default function App() {
  const [user, setUser] = useState(getStoredUser());
  const [authed, setAuthed] = useState(!!getToken());
  const [role, setRole] = useState(() => (getStoredUser() ? (isDriverUser(getStoredUser()) ? 'driver' : 'customer') : 'customer'));
  // null = landing page, otherwise the role the user chose to log in as.
  const [loginRole, setLoginRole] = useState(null);

  useEffect(() => {
    if (!authed) return;
    // Validate the token against the server and refresh the profile.
    const refreshRole = isDriverUser(user);
    setRole(refreshRole ? 'driver' : 'customer');
    api('/auth/me')
      .then((me) => {
        setUser(me);
        setRole(isDriverUser(me) ? 'driver' : 'customer');
      })
      .catch(() => {
        clearSession();
        setAuthed(false);
        setUser(null);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed]);

  if (sharedTripId()) {
    return <ErrorBoundary><TripTracker tripId={sharedTripId()} /></ErrorBoundary>;
  }

  // Explicit role switch: a driver who logs in with the customer phone should see customer view, and vice-versa.
  function switchRole(next) {
    setRole(next);
  }

  function handleLogin(u) {
    setUser(u);
    setAuthed(true);
    setRole(isDriverUser(u) ? 'driver' : 'customer');
    setLoginRole(null);
  }

  function handleLogout() {
    clearSession();
    setUser(null);
    setAuthed(false);
    setRole('customer');
    setLoginRole(null);
  }

  if (!authed || !user) {
    if (!loginRole) {
      return (
        <LangProvider>
          <ErrorBoundary resetKey="landing">
            <Landing onChoose={setLoginRole} />
          </ErrorBoundary>
        </LangProvider>
      );
    }
    return (
      <LangProvider>
        <ErrorBoundary resetKey={`login-${loginRole}`} onReset={() => setLoginRole(null)}>
          <Login
            role={loginRole}
            onLogin={handleLogin}
            onBack={() => setLoginRole(null)}
          />
        </ErrorBoundary>
      </LangProvider>
    );
  }

  const shared = { user, setUser, onUserUpdate: setUser, onLogout: handleLogout, onSwitchRole: switchRole };

  // A driver account that hasn't been approved yet sees the application/status
  // screen instead of the operational driver dashboard. The admin owner is
  // always approved, so they go straight to the driver shell.
  const driverPending = isDriverUser(user) && !isApprovedDriver(user) && !isAdminUser(user);

  return (
    <LangProvider>
      <PWAInstallPrompt />
      <ErrorBoundary resetKey={role} onReset={handleLogout}>
        {driverPending
          ? <DriverApply {...shared} />
          : role === 'driver'
            ? <DriverShell {...shared} />
            : <CustomerShell {...shared} />}
      </ErrorBoundary>
    </LangProvider>
  );
}
