// Persisted "seen onboarding" flag. Split out from the component so the
// Onboarding module only exports a component (keeps React Fast Refresh happy).
const SEEN_KEY = 'drivelocal_onboarded';

export function hasSeenOnboarding() {
  try { return localStorage.getItem(SEEN_KEY) === '1'; } catch { return true; }
}

export function markOnboardingSeen() {
  try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* ignore */ }
}
