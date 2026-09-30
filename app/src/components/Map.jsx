import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';
import geolocate from '../lib/geolocate.js';

// OpenStreetMap's public raster tiles. Two things are load-bearing here:
//
//  * `detectRetina` must stay OFF. The standard OSM layer has no @2x variant
//    (it answers 400), and the usual Carto mirrors serve byte-identical images
//    at both sizes, so retina tiles are simply not available for free. The
//    crispness on high-DPR phones comes from fractional zoom below, which
//    scales the tile level with a transform (smooth interpolation) instead of
//    hard nearest-neighbour doubling at each integer step.
//  * Attribution is required by the OSM tile usage policy, so the control
//    stays enabled.
const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors';

// A marker is identified by WHAT IT IS, never by where it is. Keying on
// coordinates meant every GPS frame tore down and rebuilt the driver pin, so it
// teleported, lost its animation, and reset tooltip/hover state ~once a second.
// With a stable key we can call setLatLng() and glide the existing marker
// instead. Callers can pass an explicit `id`; spots key off their stored id and
// everything else is a singleton per type.
function markerKey(m, i) {
  if (m.id != null) return `${m.type}:id:${m.id}`;
  if (m.type === 'spot') return `spot:${m.spot?.id ?? m.spot?.name ?? i}`;
  return m.type;
}

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

const carIcon = L.divIcon({
  className: 'car-icon',
  // The dot stays the recognisable "car" blob; the arrow inside it rotates to
  // the driver's heading so the customer can see which way the car is facing.
  html: '<div class="car-dot"><span class="car-arrow" /></div>',
  iconSize: [28, 28],
  iconAnchor: [14, 14],
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

const ICONS = { driver: carIcon, home: homeIcon, dest: destIcon, spot: spotIcon, you: youIcon };

// Leaflet renders each pin as a bare <div>, which screen readers announce as an
// empty group. Markers that mean something get a role and a name; the purely
// decorative ones (a plain home/destination dot) are hidden instead, so they do
// not add noise to the map's accessible tree.
const MARKER_ROLES = { driver: 'Your driver', you: 'Your location', home: 'Pickup point', dest: 'Destination' };

function markerAlt(m) {
  return m.title || m.name || MARKER_ROLES[m.type] || '';
}

function applyMarkerA11y(marker, m) {
  const el = marker.getElement();
  if (!el) return;
  const label = markerAlt(m);
  if (m.type === 'spot' || m.title || m.name) {
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', label);
    el.removeAttribute('aria-hidden');
  } else {
    el.setAttribute('aria-hidden', 'true');
    el.removeAttribute('role');
    el.removeAttribute('aria-label');
  }
}

// Markers that represent something physically moving get animated between
// fixes; a pickup/destination pin that the user just placed should not glide.
const MOVING_TYPES = new Set(['driver', 'you']);

// GPS jitter under this looks like noise, not movement, so snapping is both
// cheaper and visually calmer than animating every 3 m wobble.
const GLIDE_MIN_M = 8;
const GLIDE_MIN_MS = 320;
const GLIDE_MAX_MS = 1200;
const GLIDE_MS_PER_M = 20; // roughly 50 km/h of visual travel speed
const METERS_PER_DEG = 111320;

function reduceMotion() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function metersBetween(a, b) {
  const midLat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const dx = (b.lng - a.lng) * Math.cos(midLat) * METERS_PER_DEG;
  const dy = (b.lat - a.lat) * METERS_PER_DEG;
  return Math.hypot(dx, dy);
}

function stopGlide(marker) {
  if (marker.__glide) {
    cancelAnimationFrame(marker.__glide);
    marker.__glide = null;
  }
  if (marker.__glideSettle) {
    clearTimeout(marker.__glideSettle);
    marker.__glideSettle = null;
  }
}

// Eases the marker from its current position to `to` over roughly the time the
// car would actually have taken, so live tracking reads as driving rather than
// as a series of jumps. A new target mid-flight retargets from wherever the
// marker currently is rather than snapping back to the stale origin.
function glideTo(marker, to) {
  stopGlide(marker);
  if (!marker._map) return;
  const from = marker.getLatLng();
  if (from.lat === to.lat && from.lng === to.lng) return;

  const meters = metersBetween(from, to);
  if (meters < GLIDE_MIN_M || reduceMotion()) {
    marker.setLatLng(to);
    return;
  }

  const ms = Math.min(GLIDE_MAX_MS, Math.max(GLIDE_MIN_MS, meters * GLIDE_MS_PER_M));
  const started = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - started) / ms);
    const eased = 1 - (1 - t) ** 3; // ease-out: settles rather than snaps
    const cur = marker.getLatLng();
    marker.setLatLng([
      cur.lat + (to.lat - cur.lat) * eased,
      cur.lng + (to.lng - cur.lng) * eased,
    ]);
    marker.__glide = t < 1 ? requestAnimationFrame(step) : null;
  };
  marker.__glide = requestAnimationFrame(step);

  // requestAnimationFrame is suspended for a tab the user is not looking at, and
  // a glide is the only thing that moves the pin. Without this the car freezes
  // part-way and stays visibly in the wrong place until the tab is focused again.
  // The animation is decoration; the reported position is not optional.
  marker.__glideSettle = setTimeout(() => {
    marker.__glideSettle = null;
    stopGlide(marker);
    marker.setLatLng(to);
  }, ms + 150);
}

function applyHeading(marker, heading) {
  const el = marker.getElement && marker.getElement();
  if (!el) return;
  const arrow = el.querySelector('.car-arrow');
  if (!arrow) return;
  arrow.style.transform = heading == null || !Number.isFinite(heading) ? '' : `rotate(${heading}deg)`;
}

function lineSignature(line) {
  const pts = line.points || [];
  // Comparing the endpoints plus the count is enough to notice a real reroute
  // while staying cheap on a few-hundred-point polyline.
  const first = pts[0] || [0, 0];
  const last = pts[pts.length - 1] || [0, 0];
  return `${pts.length}:${first[0]?.toFixed(5)},${first[1]?.toFixed(5)}:${last[0]?.toFixed(5)},${last[1]?.toFixed(5)}`;
}

// Re-exported Leaflet so consumers can customise if needed.
export { L };

// Markers: [{ id?, lat, lng, type:'driver'|'home'|'dest'|'spot'|'you',
//             spot?, name?, title?, accuracy?, heading? }]
// route: array of [lat,lng] points to draw a polyline (optional, single redrawn
// when `routes` is provided). `routes` may also supply per-route colour/dash:
//   [{ points: [[lat,lng],...], color: '#22c55e', dashed: true }]
// center: [lat,lng], onMapClick: (latlng) => void, autofit: bool
// follow: marker key (e.g. 'driver') to keep centred; the user panning away
//         turns following off and reveals a recenter button.
export default function Map({
  center = [-26.2155, 29.2916],
  zoom = 12,
  markers = [],
  route = null,
  routes = null,
  onMapClick,
  onSpotClick,
  onLocate,
  onLocateError,
  className = '',
  autofit = true,
  autofitSpots = false,
  locateControl = false,
  follow = null,
  onFollowChange,
  maxBounds = null,
  minZoom = 4,
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  const polyLayerRef = useRef(null);
  const polyRef = useRef([]);
  const polySigRef = useRef('');
  const markersRef = useRef([]);
  const circlesRef = useRef({});
  const fittedRef = useRef(false);
  const prevAutofitRef = useRef(undefined);
  const resizeObserverRef = useRef(null);
  const spotClickRef = useRef(null);
  const locateCtlRef = useRef(null);
  const locateBtnRef = useRef(null);
  const recenterElRef = useRef(null);
  const draggingRef = useRef(false);
  const followRef = useRef(follow);
  const [following, setFollowing] = useState(false);
  const [tilesOffline, setTilesOffline] = useState(false);

  useEffect(() => { spotClickRef.current = onSpotClick; }, [onSpotClick]);

  // Callback props are read through refs so the map and the markers below are
  // built once and never rebuilt just because a parent re-created a closure.
  const onLocateRef = useRef(onLocate);
  const onLocateErrorRef = useRef(onLocateError);
  const onFollowChangeRef = useRef(onFollowChange);
  useEffect(() => { onLocateRef.current = onLocate; }, [onLocate]);
  useEffect(() => { onLocateErrorRef.current = onLocateError; }, [onLocateError]);
  useEffect(() => { onFollowChangeRef.current = onFollowChange; }, [onFollowChange]);
  useEffect(() => { followRef.current = follow; }, [follow]);
  useEffect(() => { if (onFollowChangeRef.current) onFollowChangeRef.current(following); }, [following]);

  // A new follow target (a fresh driver, a new trip) re-arms following; the
  // user can still pan away again.
  useEffect(() => { if (follow) setFollowing(true); }, [follow]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      center,
      zoom,
      minZoom,
      maxZoom: 19,
      // Fractional zoom: Leaflet scales the whole tile level with a transform,
      // so a high-DPR screen gets smooth interpolation rather than chunky
      // nearest-neighbour doubling at every integer zoom step.
      zoomSnap: 0.25,
      zoomDelta: 0.5,
      wheelPxPerZoomLevel: 100,
      maxBounds: maxBounds || undefined,
      maxBoundsViscosity: 0.85,
    });

    const tileLayer = L.tileLayer(TILE_URL, {
      maxZoom: 19,
      minZoom: 1,
      subdomains: ['a', 'b', 'c'],
      attribution: TILE_ATTRIBUTION,
      detectRetina: false, // see the note at the top — there are no @2x tiles
      keepBuffer: 3,
    }).addTo(map);

    // Recently-viewed tiles are served from the service worker cache offline.
    // When they cannot be fetched we do NOT blank the map — the pins are still
    // exact — we just say so, because a silent grey grid looks like a broken
    // app on a patchy connection.
    let fails = 0;
    let failTimer = null;
    tileLayer.on('tileerror', () => {
      fails += 1;
      if (fails < 3 || failTimer) return;
      failTimer = setTimeout(() => {
        failTimer = null;
        if (fails >= 3) setTilesOffline(true);
      }, 1200);
    });
    tileLayer.on('tileload', () => {
      fails = 0;
      setTilesOffline(false); // no-op re-render when already false
    });

    mapRef.current = map;
    layerRef.current = L.layerGroup().addTo(map);
    polyLayerRef.current = L.layerGroup().addTo(map);
    markersRef.current = [];
    fittedRef.current = false;

    // The map sits inside a scrolling page. With wheel zoom on from the start
    // Leaflet swallows the wheel and the page can't scroll past the map on a
    // desktop. So wheel zoom arms only once the user has clicked into the map
    // and disarms on the way out.
    map.scrollWheelZoom.disable();
    map.on('click', () => map.scrollWheelZoom.enable());
    map.on('mouseout', () => map.scrollWheelZoom.disable());

    // A deliberate pan means the user wants to look somewhere themselves, so
    // stop chasing the driver and offer the recenter button instead.
    //
    // dragstart is safe to use here even though programmatic moves also touch the
    // map: Leaflet fires dragstart/dragend only for real Draggable interactions,
    // never for our own panTo/fitBounds, so following cannot switch itself off.
    // Without this, mouse dragging on a desktop did nothing at all and the map
    // snapped back on the next driver update.
    const stopFollowing = () => { if (followRef.current) setFollowing(false); };
    map.on('dragstart', () => {
      draggingRef.current = true;
      stopFollowing();
    });
    map.on('dragend', () => { draggingRef.current = false; });

    // Pinch zoom has no dragstart, so the zoom controls need their own hook.
    const el = containerRef.current;
    el.addEventListener('wheel', stopFollowing, { passive: true });
    el.addEventListener('touchstart', stopFollowing, { passive: true });
    const zoomCtl = map.zoomControl && map.zoomControl.getContainer();
    if (zoomCtl) zoomCtl.addEventListener('mousedown', stopFollowing);

    // Optional "my location" button that re-centres on the device GPS. Uses the
    // shared geolocate() burst sampler rather than a raw one-shot fix, so the
    // pin lands on a verified fix rather than a possibly-km-off Wi-Fi guess.
    if (locateControl) {
      const btn = L.control({ position: 'bottomright' });
      btn.onAdd = () => {
        const el = L.DomUtil.create('div', 'leaflet-bar leaflet-control-locate');
        const button = L.DomUtil.create('button', '', el);
        button.type = 'button';
        button.textContent = '🎯';
        button.title = 'Centre on my location';
        button.setAttribute('aria-label', 'Centre on my location');
        L.DomEvent.disableClickPropagation(el);
        el.addEventListener('click', async () => {
          button.disabled = true;
          button.classList.add('busy');
          try {
            const { lat, lng, accuracy } = await geolocate();
            // Asking to be put somewhere else is as deliberate as dragging the
            // map, so release follow mode here too — otherwise the next driver
            // fix yanks the view straight back and the button did nothing.
            stopFollowing();
            map.setView([lat, lng], Math.max(map.getZoom(), 15), { animate: true });
            if (onLocateRef.current) onLocateRef.current({ lat, lng, accuracy });
          } catch (err) {
            if (onLocateErrorRef.current) onLocateErrorRef.current(err);
          } finally {
            button.disabled = false;
            button.classList.remove('busy');
          }
        });
        locateBtnRef.current = button;
        return el;
      };
      locateCtlRef.current = btn.addTo(map);
    }

    // Shown only when following was interrupted, so the customer can hand the
    // view back to the driver with one tap. Always built rather than only when
    // `follow` is already set at mount: the follow target appears with the
    // first driver fix, which is well after the map is constructed. It starts
    // hidden so it can never flash before the effect below reveals it.
    const recenterCtl = L.control({ position: 'topright' });
    recenterCtl.onAdd = () => {
      const el = L.DomUtil.create('div', 'leaflet-bar leaflet-control-recenter');
      el.style.display = 'none';
      const button = L.DomUtil.create('button', '', el);
      button.type = 'button';
      button.textContent = '🎯';
      button.title = 'Follow the driver again';
      button.setAttribute('aria-label', 'Follow the driver again');
      L.DomEvent.disableClickPropagation(el);
      button.addEventListener('click', () => setFollowing(true));
      recenterElRef.current = el;
      return el;
    };
    recenterCtl.addTo(map);

    // The map can get mounted inside a hidden tab (display:none). Leaflet then
    // initialises at 0x0 and stays blank when the tab is later shown. Watch the
    // container and re-size whenever its dimensions actually change.
    const ro = new ResizeObserver(() => {
      if (mapRef.current) mapRef.current.invalidateSize();
    });
    ro.observe(containerRef.current);
    resizeObserverRef.current = ro;

    return () => {
      if (failTimer) clearTimeout(failTimer);
      el.removeEventListener('wheel', stopFollowing);
      el.removeEventListener('touchstart', stopFollowing);
      if (zoomCtl) zoomCtl.removeEventListener('mousedown', stopFollowing);
      if (locateCtlRef.current) {
        map.removeControl(locateCtlRef.current);
        locateCtlRef.current = null;
      }
      locateBtnRef.current = null;
      recenterElRef.current = null;
      resizeObserverRef.current.disconnect();
      resizeObserverRef.current = null;
      markersRef.current.forEach((m) => { stopGlide(m.marker); m.marker?.remove(); });
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
      polyLayerRef.current = null;
      polyRef.current = [];
      polySigRef.current = '';
      markersRef.current = [];
      circlesRef.current = {};
      fittedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Declared after the map-init effect so the control element already exists the
  // first time this runs.
  useEffect(() => {
    const el = recenterElRef.current;
    if (el) el.style.display = follow && !following ? '' : 'none';
  }, [follow, following]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (onMapClick) map.on('click', onMapClick);
    return () => {
      const cur = mapRef.current;
      if (cur && onMapClick) cur.off('click', onMapClick);
    };
  }, [onMapClick]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layerRef.current) return;

    const existing = markersRef.current;
    const next = markers.map((m, i) => ({ ...m, key: markerKey(m, i) }));

    // Remove markers that disappeared.
    existing.forEach((m) => {
      if (!next.some((n) => n.key === m.key)) {
        stopGlide(m.marker);
        m.marker.off();
        layerRef.current.removeLayer(m.marker);
      }
    });

    // Add markers that are new, move the ones that already exist. Reusing the
    // layer on a key match is what keeps the DOM node (and its icon animation
    // and tooltip) alive across GPS updates.
    next.forEach((m) => {
      const prior = existing.find((e) => e.key === m.key);
      if (prior) {
        m.marker = prior.marker;
        const target = [m.lat, m.lng];
        const moved = prior.lat !== m.lat || prior.lng !== m.lng;
        if (moved) {
          if (MOVING_TYPES.has(m.type)) glideTo(m.marker, target);
          else m.marker.setLatLng(target);
        }
        if (m.type === 'driver') applyHeading(m.marker, m.heading);
        if (m.title || m.name) {
          const label = m.title || m.name;
          const tip = m.marker.getTooltip();
          if (tip) {
            if (tip.getContent() !== label) tip.setContent(label);
          } else {
            m.marker.bindTooltip(label, { direction: 'top', offset: [0, -10], opacity: 0.92 });
          }
          m.marker.options.title = label;
        } else if (m.marker.getTooltip()) {
          m.marker.unbindTooltip();
        }
        // Re-run in case a pin gained or lost its label.
        applyMarkerA11y(m.marker, m);
        return;
      }

      const marker = L.marker([m.lat, m.lng], {
        icon: ICONS[m.type] || null,
        title: m.title || m.name || '',
        // Spots are always tappable (customers pick the closest); other pins
        // become interactive only when they carry an annotation.
        interactive: m.type === 'spot' || !!(m.title || m.name),
        // A spot tap must only pick the spot — never also trigger the map's
        // own click handler as the gesture bubbles up.
        bubblingMouseEvents: false,
        alt: markerAlt(m),
      });
      m.marker = marker;
      if (m.title || m.name) {
        marker.bindTooltip(m.title || m.name, { direction: 'top', offset: [0, -10], opacity: 0.92 });
      }
      applyMarkerA11y(marker, m);
      marker.addTo(layerRef.current);
      // A marker's DOM element only exists once it is on the map, so apply the
      // ARIA attributes after mounting as well (the call above covers the
      // already-mounted case on marker reuse).
      applyMarkerA11y(marker, m);
      if (m.type === 'driver') applyHeading(marker, m.heading);
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

    // Accuracy radius for GPS-derived pins, keyed by marker identity so the
    // circle is updated in place instead of being rebuilt on every fix.
    const wantedCircles = {};
    next.forEach((m) => {
      const hasAcc = m.accuracy != null && Number.isFinite(m.accuracy) && m.accuracy > 0;
      if (!hasAcc) return;
      wantedCircles[m.key] = true;
      const circle = circlesRef.current[m.key];
      const radius = Math.max(m.accuracy, 5);
      if (circle) {
        circle.setLatLng([m.lat, m.lng]);
        circle.setRadius(radius);
      } else {
        circlesRef.current[m.key] = L.circle([m.lat, m.lng], {
          radius,
          color: '#22c55e',
          weight: 1.5,
          fillColor: '#22c55e',
          fillOpacity: 0.12,
        }).addTo(layerRef.current);
      }
    });
    Object.keys(circlesRef.current).forEach((ckey) => {
      if (!wantedCircles[ckey]) {
        layerRef.current.removeLayer(circlesRef.current[ckey]);
        delete circlesRef.current[ckey];
      }
    });

    markersRef.current = next;

    // Route polyline(s). Rebuilt only when the geometry actually changed — the
    // effect re-runs on every marker update, and the driver's own map moves
    // every couple of seconds, so unconditional teardown was churning the line
    // for no reason.
    const lines = [];
    if (routes && routes.length) lines.push(...routes.filter((r) => r && r.points && r.points.length >= 2));
    else if (route && route.length >= 2) lines.push({ points: route, color: '#3b82f6' });
    const polySig = lines.map((l) => `${l.color || ''}|${l.dashed ? 1 : 0}|${lineSignature(l)}`).join('||');
    if (polySig !== polySigRef.current) {
      polySigRef.current = polySig;
      polyRef.current.forEach((p) => p.remove());
      polyRef.current = lines.map((r) => {
        const opts = { color: r.color || '#3b82f6', weight: 4, opacity: 0.75 };
        if (r.dashed) opts.dashArray = '8 10';
        return L.polyline(r.points, opts).addTo(polyLayerRef.current);
      });
    }
    const routePts = lines.flatMap((r) => r.points || []);

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

    // Follow mode: keep the tracked marker centred while it moves. Skipped
    // while the user is mid-pan, and only while the marker is actually on the
    // map (a marker removed by a later render must not drag the view).
    if (following && follow) {
      const target = next.find((m) => m.key === follow && m.marker?._map);
      if (target && !draggingRef.current) {
        const c = map.getCenter();
        if (c.lat !== target.lat || c.lng !== target.lng) {
          map.panTo([target.lat, target.lng], { animate: true, duration: 0.5 });
        }
      }
    }
  }, [markers, route, routes, autofit, autofitSpots, center, following, follow]);

  return (
    <div ref={containerRef} className={`map ${className}`}>
      {tilesOffline && (
        <div className="map-offline-note">
          Map pictures unavailable offline — pins are still accurate
        </div>
      )}
    </div>
  );
}
