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

// Re-exported Leaflet so consumers can customise if needed.
export { L };

// Markers: [{lat,lng,type:'driver'|'home'|'dest'}]
// route: array of [lat,lng] points to draw a polyline (optional)
// center: [lat,lng], onMapClick: (latlng) => void, autofit: bool
export default function Map({
  center = [-26.2155, 29.2916],
  zoom = 12,
  markers = [],
  route = null,
  onMapClick,
  className = '',
  autofit = true,
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  const polyRef = useRef(null);
  const markersRef = useRef([]);
  const fittedRef = useRef(false);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, { center, zoom, attributionControl: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
    mapRef.current = map;
    layerRef.current = L.layerGroup().addTo(map);
    markersRef.current = [];
    fittedRef.current = false;
    return () => {
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
      polyRef.current = null;
      markersRef.current = [];
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

    // Add markers that are new.
    next.forEach((m) => {
      if (!existing.some((e) => e.key === m.key)) {
        let icon = null;
        if (m.type === 'driver') icon = carIcon;
        else if (m.type === 'home') icon = homeIcon;
        else if (m.type === 'dest') icon = destIcon;
        const marker = L.marker([m.lat, m.lng], { icon }).addTo(layerRef.current);
        m.marker = marker;
      }
    });

    markersRef.current = next;

    // Route polyline
    if (polyRef.current) {
      map.removeLayer(polyRef.current);
      polyRef.current = null;
    }
    if (route && route.length >= 2) {
      polyRef.current = L.polyline(route, { color: '#3b82f6', weight: 4, opacity: 0.75 }).addTo(map);
    }

    // Frame the view around the pins/route once there are at least two points so
    // the whole route is visible. A lone LIVE driver marker is tracked so the car
    // stays framed while it moves. We otherwise avoid jumping to a single static
    // pin (the caller's `center` prop keeps the initial view on the service area).
    if (autofit) {
      const stable = next.filter((m) => m.type !== 'driver');
      const pts = [...stable.map((m) => [m.lat, m.lng]), ...(route || [])];
      if (pts.length >= 2) {
        const sig = pts.map((p) => p[0].toFixed(5) + ',' + p[1].toFixed(5)).sort().join('|');
        if (sig !== fittedRef.current) {
          fittedRef.current = sig;
          map.fitBounds(L.latLngBounds(pts).pad(0.2), { maxZoom: 15, animate: false });
        }
      } else if (next.length === 1 && next[0].type === 'driver') {
        const d = next[0];
        const sig = d.lat.toFixed(5) + ',' + d.lng.toFixed(5);
        if (sig !== fittedRef.current) {
          fittedRef.current = sig;
          map.setView([d.lat, d.lng], Math.max(map.getZoom(), 13), { animate: false });
        }
      }
    }
  }, [markers, route, autofit]);

  return <div ref={containerRef} className={`map ${className}`} />;
}
