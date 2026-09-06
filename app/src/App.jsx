import React, { useState, useEffect } from 'react';
import Landing from './screens/Landing.jsx';
import Login from './screens/Login.jsx';
import DriverShell from './shells/DriverShell.jsx';
import CustomerShell from './shells/CustomerShell.jsx';
import { getToken, getStoredUser, isDriverUser, clearSession, api } from './api.js';

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
      return <Landing onChoose={setLoginRole} />;
    }
    return (
      <Login
        role={loginRole}
        onLogin={handleLogin}
        onBack={() => setLoginRole(null)}
      />
    );
  }

  const shared = { user, setUser, onLogout: handleLogout, onSwitchRole: switchRole };

  if (role === 'driver') {
    return <DriverShell {...shared} />;
  }
  return <CustomerShell {...shared} />;
}
