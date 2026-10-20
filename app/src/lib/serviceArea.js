// The town/service area the app operates in, sourced from the server
// (GET /api/public/config). The owner sets it in Admin → Settings; until then
// `lat`/`lng` are null and callers fall back to the device's own location.
//
// Fetched once per page load and shared, so the booking map, the driver map and
// the admin screen all agree on the same centre.
import { useEffect, useState } from 'react';
import { api } from '../api.js';

const DEFAULT = { name: '', lat: null, lng: null, radiusKm: 30 };

let cache = null;
let inflight = null;

export async function loadServiceArea() {
  if (cache) return cache;
  if (!inflight) {
    inflight = api('/public/config')
      .then((r) => {
        cache = { ...DEFAULT, ...(r && r.serviceArea ? r.serviceArea : {}) };
        return cache;
      })
      .catch(() => DEFAULT)
      .finally(() => { inflight = null; });
  }
  return inflight;
}

// React hook: returns the service area, refreshing when it arrives. The initial
// value is the cache if we already have one, else the empty default.
export function useServiceArea() {
  const [area, setArea] = useState(cache || DEFAULT);
  useEffect(() => {
    let alive = true;
    loadServiceArea().then((a) => { if (alive) setArea(a); });
    return () => { alive = false; };
  }, []);
  return area;
}

export default { loadServiceArea, useServiceArea, DEFAULT };
