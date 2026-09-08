import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

const KIND_EMOJI = { home: '🏠', work: '💼', place: '📍', taxi: '🚐', school: '🏫', clinic: '🏥', shop: '🏪', other: '📍' };
const DEFAULT_KINDS = [
  { kind: 'home', label: 'Home', emoji: '🏠' },
  { kind: 'work', label: 'Work', emoji: '💼' },
  { kind: 'taxi', label: 'Taxi rank', emoji: '🚐' },
  { kind: 'school', label: 'School', emoji: '🏫' },
];

function emojiFor(place) {
  return KIND_EMOJI[place.kind] || '📍';
}

// Lists the customer's saved places; tapping one fills the active point.
export default function SavedPlacesBar({ onPick, active = 'destination' }) {
  const [places, setPlaces] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api('/customer/places')
      .then((list) => setPlaces(Array.isArray(list) ? list : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return null;
  if (places.length === 0) return null;

  return (
    <div className="saved-rows">
      {places.slice(0, 4).map((p) => (
        <button key={p.id} type="button" className="saved-chip" onClick={() => onPick(p)}>
          <span className="kind-emoji">{emojiFor(p)}</span>
          <span>
            <span className="saved-label">{p.label}</span>
            <span className="saved-addr">{p.address || `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`}</span>
          </span>
          {active && <span className="hint" style={{ margin: 0 }}>set {active}</span>}
        </button>
      ))}
    </div>
  );
}

// Offers to save the current point into a named slot (Home / Work / custom).
export function SavePlaceBar({ point, onSaved }) {
  const [busy, setBusy] = useState(false);
  if (!point) return null;

  async function save(kind, label) {
    setBusy(true);
    try {
      await api('/customer/places', {
        method: 'POST',
        body: { label, kind, address: point.address || label, lat: point.lat, lng: point.lng, note: point.note },
      });
      onSaved && onSaved();
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="save-slot-bar">
      {DEFAULT_KINDS.map((k) => (
        <button key={k.kind} type="button" className="save-slot" disabled={busy} onClick={() => save(k.kind, k.label)}>
          <span>{k.emoji}</span>
          <span>Save as {k.label}</span>
        </button>
      ))}
    </div>
  );
}
