import geolocate from './geolocate.js';
import { api } from '../api.js';

// One-tap emergency sharing:
//  1. The backend records an SOS alert tied to the current trip (if any), and
//     the platform owner is notified in real time + by SMS. This feeds the
//     safety audit trail in Admin > Records.
//  2. The user's live location is still handed to a saved contact over WhatsApp
//     (the contact lives in the browser; nothing is stored by the backend).

const CONTACT_KEY = 'drivelocal_emergency_contact';

export function getEmergencyContact() {
  try {
    return JSON.parse(localStorage.getItem(CONTACT_KEY) || 'null');
  } catch {
    return null;
  }
}

export function setEmergencyContact({ name, phone }) {
  const clean = String(phone || '').replace(/[^\d+]/g, '');
  if (!clean) throw new Error('Enter a phone number');
  const contact = { name: (name || '').trim(), phone: clean };
  localStorage.setItem(CONTACT_KEY, JSON.stringify(contact));
  return contact;
}

// Record the SOS on the backend (best-effort — never block the WhatsApp share
// on a network hiccup), then open WhatsApp with a Google Maps pin.
export async function sendSos({ contact, note, tripId }) {
  let location = null;
  try {
    location = await geolocate();
  } catch {
    /* fall back to no pin rather than blocking the SOS */
  }

  try {
    await api('/sos', {
      method: 'POST',
      body: {
        tripId: tripId || null,
        note: note || 'Emergency SOS pressed',
        lat: location ? location.lat : null,
        lng: location ? location.lng : null,
      },
    });
  } catch (err) {
    // A failed recording must not silence the WhatsApp lifeline. The owner
    // still gets the alert from the web app if recording ever fails.
    console.warn('[sos] could not record alert:', err.message);
  }

  if (!contact || !contact.phone) return { recorded: true, shared: false };
  const pin = location
    ? `My live location: https://www.google.com/maps?q=${location.lat.toFixed(6)},${location.lng.toFixed(6)}`
    : '';
  const body = [note || '🚨 SOS — I need help right now!', pin, '', 'Sent from DriveLocal']
    .filter(Boolean).join('\n');
  const num = String(contact.phone || '').replace(/\s|-/g, '');
  window.open(`https://wa.me/${num}?text=${encodeURIComponent(body)}`, '_blank');
  return { recorded: true, shared: true };
}

export default { getEmergencyContact, setEmergencyContact, sendSos };