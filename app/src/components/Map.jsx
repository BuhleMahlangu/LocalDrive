import React, { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

function markerKey(m) {
  return `${m.type}:${m.lat.toFixed(6)},${m.lng.toFixed(6)}`;
}

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

const carIcon = L.divIcon({
  className: 'car-icon',
  html: '<div class="car-dot"></div>',
  iconSize: [24, 24],
  iconAnchor: [12, 12],
});

const homeIcon = L.divIcon({
  className: 'home-icon',
  html: '<div class="home-dot"></div>',
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

const destIcon = L.divIcon({
  className: 'dest-icon',
  html: '<div class="dest-dot2"></div>',
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

const spotIcon = L.divIcon({
  className: 'spot-icon',
  html: '<div class="spot-dot"></div>',
  // 40px hit zone around a small dot so pickup spots are easy to tap on a phone.
  iconSize: [40, 40],
  iconAnchor: [20, 20],
});

const youIcon = L.divIcon({
  className: 'you-icon',
  html: '<div class="you-dot"></div>',
  iconSize: [24, 24],
  iconAnchor: [12, 12],
});

// Re-exported Leaflet so consumers can customise if needed.
export { L };

// Markers: [{lat,lng,type:'driver'|'home'|'dest'}]
// route: array of [lat,lng] points to draw a polyline (optional, single redrawn
// when `routes` is provided). `routes` may also supply per-route colour/dash:
//   [{ points: [[lat,lng],...], color: '#22c55e', dashed: true }]
// center: [lat,lng], onMapClick: (latlng) => void, autofit: bool
export default function Map({
  center = [-26.2155, 29.2916],
  zoom = 12,
  markers = [],
  route = null,
  routes = null,
  onMapClick,
  onSpotClick,
  onLocate,
  className = '',
  autofit = true,
  autofitSpots = false,
  locateControl = false,
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  const polyRef = useRef([]);
  const markersRef = useRef([]);
  const circlesRef = useRef({});
  const fittedRef = useRef(false);
  const prevAutofitRef = useRef(undefined);
  const resizeObserverRef = useRef(null);
  const spotClickRef = useRef(null);
  const locateCtlRef = useRef(null);

  useEffect(() => { spotClickRef.current = onSpotClick; }, [onSpotClick]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, { center, zoom, attributionControl: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
    mapRef.current = map;
    layerRef.current = L.layerGroup().addTo(map);
    markersRef.current = [];
    fittedRef.current = false;

    // Optional "my location" button that re-centres on the device GPS — used on
    // screens where the caller doesn't already gate location behind a gesture.
    if (locateControl) {
      const btn = L.control({ position: 'bottomright' });
      btn.onAdd = () => {
        const el = L.DomUtil.create('div', 'leaflet-bar leaflet-control-locate');
        el.innerHTML = '<button type="button" aria-label="My location" title="My location">🎯</button>';
        L.DomEvent.disableClickPropagation(el);
        el.addEventListener('click', () => {
          if (!navigator.geolocation) return;
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              const { latitude, longitude } = pos.coords;
              map.setView([latitude, longitude], Math.max(map.getZoom(), 15), { animate: true });
              if (typeof onLocate === 'function') onLocate({ lat: latitude, lng: longitude });
            },
            () => {},
            { enableHighAccuracy: true, timeout: 10000 },
          );
        });
        return el;
      };
      locateCtlRef.current = btn.addTo(map);
    }

    // The map can get mounted inside a hidden tab (display:none). Leaflet then
    // initialises at 0x0 and stays blank when the tab is later shown. Watch the
    // container and re-size whenever its dimensions actually change.
    const ro = new ResizeObserver(() => {
      if (mapRef.current) mapRef.current.invalidateSize();
    });
    ro.observe(containerRef.current);
    resizeObserverRef.current = ro;

    return () => {
      if (locateCtlRef.current) {
        map.removeControl(locateCtlRef.current);
        locateCtlRef.current = null;
      }
      resizeObserverRef.current.disconnect();
      resizeObserverRef.current = null;
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
      polyRef.current = [];
      markersRef.current = [];
      circlesRef.current = {};
      fittedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (onMapClick) map.on('click', onMapClick);
    return () => {
      const cur = mapRef.current;
      if (cur && onMapClick) cur.off('click', onMapClick);
    };
  }, [onMapClick]);

  // The locate control call-back is kept in a ref so the handler stays fresh without
  // recreating the map. The map-init effect below guards on mapRef so it only
  // constructs the Leaflet map once, even if this dependency changes.
  const onLocateRef = useRef(onLocate);
  useEffect(() => { onLocateRef.current = onLocate; }, [onLocate]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layerRef.current) return;

    const existing = markersRef.current;
    const next = markers.map((m) => ({ ...m, key: markerKey(m) }));

    // Remove markers that disappeared.
    existing.forEach((m) => {
      if (!next.some((n) => n.key === m.key)) {
        map.removeLayer(m.marker);
      }
    });

    // Add markers that are new (reuse the layer when the key already existed so
    // the leaflet marker stays in place).
    next.forEach((m) => {
      const prior = existing.find((e) => e.key === m.key);
      if (prior) {
        m.marker = prior.marker;
      } else {
        let icon = null;
        if (m.type === 'driver') icon = carIcon;
        else if (m.type === 'home') icon = homeIcon;
        else if (m.type === 'dest') icon = destIcon;
        else if (m.type === 'spot') icon = spotIcon;
        else if (m.type === 'you') icon = youIcon;
        m.marker = L.marker([m.lat, m.lng], {
          icon,
          title: m.title || m.name || '',
          // Spots are always tappable (customers pick the closest); other pins
          // become interactive only when they carry an annotation.
          interactive: m.type === 'spot' || !!(m.title || m.name),
          // A spot tap must only pick the spot — never also trigger the map's
          // own click handler as the gesture bubbles up.
          bubblingMouseEvents: false,
        });
        if (m.title || m.name) m.marker.bindTooltip(m.title || m.name, { direction: 'top', offset: [0, -10], opacity: 0.92 });
        m.marker.addTo(layerRef.current);
      }
    });

    // Pickup-spot pins are selectable — bind a click handler that stops the
    // click from also reaching the map (so tapping a spot never drops a stray
    // destination pin while the user is choosing).
    next.forEach((m) => {
      if (m.type !== 'spot') return;
      m.marker.off('click');
      if (spotClickRef.current) {
        m.marker.on('click', (e) => {
          L.DomEvent.stop(e);
          spotClickRef.current(m.spot || m);
        });
      }
    });

    // Accuracy radius for GPS-derived pins, keyed so coords/accuracy can update.
    const wantedCircles = {};
    next.forEach((m) => {
      const hasAcc = m.accuracy != null && Number.isFinite(m.accuracy) && m.accuracy > 0;
      if (!hasAcc) return;
      const ckey = m.key;
      wantedCircles[ckey] = true;
      const circle = circlesRef.current[ckey];
      const opts = {
        radius: Math.max(m.accuracy, 5),
        color: '#22c55e',
        weight: 1.5,
        fillColor: '#22c55e',
        fillOpacity: 0.12,
      };
      if (circle) {
        circle.setLatLng([m.lat, m.lng]);
        circle.setRadius(opts.radius);
      } else {
        circlesRef.current[ckey] = L.circle([m.lat, m.lng], opts).addTo(layerRef.current);
      }
    });
    Object.keys(circlesRef.current).forEach((ckey) => {
      if (!wantedCircles[ckey]) {
        map.removeLayer(circlesRef.current[ckey]);
        delete circlesRef.current[ckey];
      }
    });

    markersRef.current = next;

    // Route polyline(s)
    const lines = [];
    if (routes && routes.length) lines.push(...routes.filter((r) => r && r.points && r.points.length >= 2));
    else if (route && route.length >= 2) lines.push({ points: route, color: '#3b82f6' });
    polyRef.current.forEach((p) => map.removeLayer(p));
    polyRef.current = lines.map((r) => {
      const opts = { color: r.color || '#3b82f6', weight: 4, opacity: 0.75 };
      if (r.dashed) opts.dashArray = '8 10';
      return L.polyline(r.points, opts).addTo(map);
    });
    const flatRoute = polyRef.current.flatMap((p) => p.getLatLngs());
    const routePts = flatRoute.map((ll) => [ll.lat, ll.lng]);

    // Frame the view around the pins/route once there are at least two points so
    // the whole route is visible. A lone LIVE driver marker is tracked so the car
    // stays framed while it moves. We otherwise avoid jumping to a single static
    // pin (the caller's `center` prop keeps the initial view on the service area).
    if (autofit) {
      // Spot pins (preset pickup locations) are scenery on the driver map and
      // never drive the framing — unless the caller opts in (autofitSpots) so a
      // customer can see all the pickup spots around them at once.
      const stable = next.filter((m) => m.type !== 'driver' && (autofitSpots || m.type !== 'spot'));
      const pts = [...stable.map((m) => [m.lat, m.lng]), ...routePts];
      if (pts.length >= 2) {
        const sig = pts.map((p) => p[0].toFixed(5) + ',' + p[1].toFixed(5)).sort().join('|');
        if (sig !== fittedRef.current) {
          fittedRef.current = sig;
          map.fitBounds(L.latLngBounds(pts).pad(0.2), { maxZoom: 15, animate: false });
        }
      } else if (next.length === 1 && (next[0].type === 'driver' || next[0].type === 'home')) {
        const d = next[0];
        const sig = d.lat.toFixed(5) + ',' + d.lng.toFixed(5);
        if (sig !== fittedRef.current) {
          fittedRef.current = sig;
          map.setView([d.lat, d.lng], Math.max(map.getZoom(), d.type === 'driver' ? 13 : 15), { animate: false });
        }
      }
    } else if (prevAutofitRef.current === true) {
      // Trip cleared while the map was framing a route — glide back to the
      // caller's intended centre so we don't keep lingering elsewhere.
      fittedRef.current = false;
      map.setView(center, map.getZoom() > 15 ? 15 : map.getZoom(), { animate: true });
    }
    prevAutofitRef.current = autofit;
  }, [markers, route, routes, autofit, autofitSpots, center]);

  return <div ref={containerRef} className={`map ${className}`} />;
}