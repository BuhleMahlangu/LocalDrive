// Sound + haptic feedback helpers.
//
// Browsers only let audio start after a user gesture, so we lazily create (and
// resume) an AudioContext on the first pointer/key interaction. Everything is
// best-effort: if audio or vibration is unavailable we silently do nothing.

let audioCtx = null;

function ctx() {
  if (audioCtx) return audioCtx;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();
  } catch {
    audioCtx = null;
  }
  return audioCtx;
}

function resume() {
  const c = ctx();
  if (c && c.state === 'suspended') c.resume().catch(() => {});
}

// Prime the audio context on the first user gesture so later chimes play.
if (typeof window !== 'undefined') {
  const prime = () => { resume(); };
  window.addEventListener('pointerdown', prime, { once: true });
  window.addEventListener('keydown', prime, { once: true });
}

function tone(freq, startSec, durSec, type = 'sine', peak = 0.2) {
  const c = ctx();
  if (!c) return;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, c.currentTime + startSec);
  gain.gain.exponentialRampToValueAtTime(peak, c.currentTime + startSec + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + startSec + durSec);
  osc.connect(gain).connect(c.destination);
  osc.start(c.currentTime + startSec);
  osc.stop(c.currentTime + startSec + durSec + 0.05);
}

function vibrate(pattern) {
  try {
    if (navigator.vibrate) navigator.vibrate(pattern);
  } catch { /* unsupported */ }
}

// Urgent, unmissable two-note chime + buzz — for an incoming booking request.
export function playRequestChime() {
  resume();
  tone(880, 0, 0.4, 'sine', 0.22);    // A5
  tone(1319, 0.16, 0.55, 'sine', 0.22); // E6 — rising "come look!" pair
  vibrate([300, 120, 300]);
}

// Pleasant soft confirmation for positive events (trip accepted, trip complete).
export function playSuccessChime() {
  resume();
  tone(659, 0, 0.25, 'sine', 0.18);   // E5
  tone(988, 0.14, 0.45, 'sine', 0.18); // B5
  vibrate(120);
}

export default { playRequestChime, playSuccessChime };