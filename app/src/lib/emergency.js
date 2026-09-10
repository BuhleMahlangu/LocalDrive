import geolocate from './geolocate.js';

// One-tap emergency sharing: send the user's live location to a saved contact
// over WhatsApp. The contact lives in the browser so nothing is stored by the
// backend, and the flow works offline-from-PWA (it only needs the network when
// actually opening WhatsApp).

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

// Grab a fresh location fix and hand the SOS off to WhatsApp with a Google Maps
// pin so the contact can see exactly where the sender is.
export async function sendSos({ contact, note }) {
  let location = null;
  try {
    location = await geolocate();
  } catch {
    /* fall back to no pin rather than blocking the SOS */
  }
  const pin = location
    ? `My live location: https://www.google.com/maps?q=${location.lat.toFixed(6)},${location.lng.toFixed(6)}`
    : '';
  const body = [note || '🚨 SOS — I need help right now!', pin, '', 'Sent from DriveLocal']
    .filter(Boolean).join('\n');
  const num = String(contact.phone || '').replace(/\s|-/g, '');
  window.open(`https://wa.me/${num}?text=${encodeURIComponent(body)}`, '_blank');
}

export default { getEmergencyContact, setEmergencyContact, sendSos };