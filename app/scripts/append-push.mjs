import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const swPath = join(root, 'dist', 'sw.js');

const PUSH_CODE = `
// ---- DriveLocal push handlers (appended at build) ----
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; }
  catch { payload = { title: 'DriveLocal', body: event.data ? event.data.text() : '' }; }
  const title = payload.title || 'DriveLocal';
  const options = {
    body: payload.body || '',
    icon: '/pwa-192.png',
    badge: '/pwa-192.png',
    data: payload.data || { url: '/' },
    vibrate: [100, 50, 100],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = data.url || '/';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    for (const client of clients) {
      if (client.url.startsWith(self.location.origin) && 'focus' in client) return client.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  }));
});
`;

let sw = readFileSync(swPath, 'utf8');
if (sw.includes('DriveLocal push handlers')) {
  console.log('Push handlers already present in sw.js');
} else {
  // Append after skipWaiting so workbox bootstrap stays intact.
  sw += PUSH_CODE;
  writeFileSync(swPath, sw);
  console.log(`Appended push handlers to ${swPath}`);
}
