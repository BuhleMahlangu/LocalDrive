# DriveLocal — production deployment

This guide takes the app live for a small single-driver service: a VPS (or always-on home server) running the Node backend, a static build of the React app, and **Caddy** providing HTTPS + reverse proxy (handles the Socket.io WebSockets automatically).

The path below is the recommended **one-host** setup (frontend + API + WebSockets on one HTTPS domain). A lighter **two-host** alternative (static SPA + API) is covered at the end.

## 1. What you need

- A domain (e.g. `drivelocal.example.co.za`) pointing to your server's public IP.
- A server with Node.js 18+ (we recommend Node 20/22 LTS). Ubuntu/Debian assumed below.
- Real keys from: **ClickSend** (OTP SMS), **Yoco** (card payments — optional for launch), and VAPID keys for push (`npx web-push generate-vapid-keys`).

## 2. Directory layout

```
/opt/drivelocal/
├── backend/           # entire backend/ folder (without node_modules)
├── app/dist/          # built frontend (copied after npm run build)
└── .env               # backend secrets (chmod 600, never committed)
```

## 3. Frontend build

```bash
cd app
npm install
npm run build
# copy dist up to the server:
scp -r dist user@server:/opt/drivelocal/app/dist
```

## 4. Backend on the server

```bash
cd /opt/drivelocal/backend
npm install --omit=dev
cp .env.example .env && chmod 600 .env
# ... edit .env (see checklist below) ...
npm run seed          # create the driver account + location
```

Run it with PM2 so it restarts (SystemD is an alternative):

```bash
npm install -g pm2
pm2 start "node src/server.js" --name drivelocal
pm2 save
pm2 startup          # follow its instructions to enable on boot
```

Verify it responds (Caddy will expose this publicly later; for now test locally):

```bash
curl http://localhost:4000/health   # {"ok":true,...}
```

## 5. Caddy (HTTPS + reverse proxy + static files)

Install Caddy, then point it at the app. It provisions Let's Encrypt certificates automatically and proxies WebSockets without extra config.

`/etc/caddy/Caddyfile`:

```
drivelocal.example.co.za {
    encode gzip

    # Static PWA
    root * /opt/drivelocal/app/dist
    try_files {path} /index.html

    # API + realtime to the backend
    handle_path /api/* {
        reverse_proxy 127.0.0.1:4000
    }
    handle_path /socket.io/* {
        reverse_proxy 127.0.0.1:4000
    }
}
```

> **Security:** keep port 4000 bound to localhost only. Open 80/443 in the firewall; the Caddy proxy is the only public entry point. Don't expose the SQLite file or the `/api/payments/webhook` route publicly without the Yoco signature check (the backend verifies webhook signatures itself when `YOCO_WEBHOOK_SECRET` is set).

## 6. Backups (the SQLite file is your only copy of data)

The backend has a built-in online backup (safe with WAL). Schedule it nightly:

```bash
crontab -e
# every day at 03:05
5 3 * * * cd /opt/drivelocal/backend && npm run backup >> /opt/drivelocal/backend-backup.log 2>&1
```

It keeps the last 14 snapshots in `backend/backups/`. Copy those to another machine / object storage for real safety.

## 7. Production `.env` checklist

```ini
NODE_ENV=production
PORT=4000
JWT_SECRET=<64+ random chars — the server refuses weak values in production>
JWT_EXPIRES=30d
DRIVER_PHONE=+27000000000        # the owner driver — gates driver login
CLICKSEND_USERNAME=<your ClickSend account username>
CLICKSEND_API_KEY=<from ClickSend dashboard > API keys>
SMS_FROM=                         # optional alpha tag (WASPA-registered) or leave blank
CORS_ORIGINS=https://drivelocal.example.co.za
DB_DRIVER=sqlite
GOOGLE_MAPS_API_KEY=             # optional, enables real roads/ETA
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:you@example.co.za

# Card payments (Yoco) — start live in Cash-only mode by leaving these blank:
YOCO_SECRET_KEY=
YOCO_WEBHOOK_SECRET=
YOCO_SUCCESS_URL=https://drivelocal.example.co.za/?payment=success
YOCO_CANCEL_URL=https://drivelocal.example.co.za/?payment=cancelled
```

> The server **will not start** in production without JWT + ClickSend credentials + DRIVER_PHONE. That's deliberate.

## 8. Enabling card payments (Yoco)

1. Create a **Yoco** account and generate a secret key; put it in `YOCO_SECRET_KEY`.
2. In the Yoco dashboard, create a **webhook subscription** for `payment.succeeded` / `payment.failed` pointing to `https://drivelocal.example.co.za/api/payments/webhook`. Copy the subscription secret into `YOCO_WEBHOOK_SECRET`.
3. Set `YOCO_SUCCESS_URL` / `YOCO_CANCEL_URL` to your domain as above.
4. Restart the backend. The customer Booking screen and active-trip "Pay by card" option appear automatically. Customers are redirected to Yoco's secure hosted page, then back to confirm.

## 9. Phone / PWA install

- Open `https://drivelocal.example.co.za` in the phone browser.
- Chrome/Android: menu → **Add to Home screen** (or "Install app"). iOS Safari: Share → **Add to Home Screen**.
- Push notifications require the user to grant permission; the toggle is on the customer Home and driver Profile.

## 10. Post-launch smoke test

With the server running:

```bash
cd backend
npm run smoke     # full customer <-> driver journey against the live API
npm run backup    # confirm a snapshot is written
```

## 11. Post-deploy checklist

Run through this on the live URL before telling anyone:

- [ ] **HTTPS works and the PWA installs** (browser "Add to Home screen" / install prompt).
- [ ] **SMS OTP arrives** — real ClickSend message in production (`123456` only in dev). Sign in as both customer and driver.
- [ ] **Location permission granted** — the #1 gotcha. On a phone it must be allowed for the domain (Settings → Privacy → Location); without it the customer can't pick up automatically and push needs HTTPS anyway.
- [ ] **Book a trip end→end**: request → driver accepts → driver taps "I've arrived" → customer sees the arrived card → start trip → fare confirm → rating. Watch for live socket updates (no CORS / WS proxy errors in the browser console).
- [ ] **Share link** `GET /api/public/trips/<id>/live` opens without logging in.
- [ ] **Yoco card flow** if enabled (hosted checkout → success/cancel redirect).
- [ ] **Backup** — schedule `npm run backup` nightly and copy the snapshots off the server.

## 12. Two-host alternative (static SPA + separate API)

This avoids the backend serving static files: host `app/dist/` on Vercel/Netlify/Cloudflare Pages and the API on a Node host.

1. Build the frontend with the API origin set: `VITE_API_BASE=https://api.your-domain.com npm run build` (leave it unset for one-host).
2. Upload `app/dist/*` to the static host. Enable an **SPA fallback**: every route that isn't a real file must return `index.html` (required for the `/trip/:id` public tracker links).
3. Run the backend on its own host behind Caddy/nginx with the same reverse-proxy rules (proxy `/api` and `/socket.io`, allow WebSocket upgrades for live tracking).
4. Set `CORS_ORIGINS=https://your-domain.com` in the backend `.env`.

Geolocation, push, payments and PWA install all require **HTTPS** on the domain your phone opens.

## 13. Notes & gotchas

- The tracker page and PWA live at the same origin, so shared trip links work even
  with the app installed.
- Browser audio for the request chime needs a user gesture first (it primes on the
  first tap) — do not expect sound in the background tab or phone locked.
- Don't change `platformFeePercent` and `autoOfflineGraceMs` in code — use the
  **Admin** tab in the driver app (writes to the fast `settings` table). Changed
  values are picked up by the backend scheduler, so no restart needed.
- Web push only works on HTTPS with a service worker — the frontend build wires
  push handlers into the generated `sw.js` automatically.
- Production OTP is a real ClickSend SMS under the surface (`123456` only in dev).
  Keep `NODE_ENV=development` for local testing to avoid burning SMS credits.

## Troubleshooting

- **Backend won't start** → read the error: production fail-fast lists exactly which env vars are missing/weak.
- **Push/geolocation don't work** → they need HTTPS; check the browser console for permissions.
- **Card option missing** → Yoco not configured (`npm run dev` server was started before keys were added — restart it).
- **Socket.io keeps reconnecting** → confirm Caddy proxies `/socket.io` (your nginx/caddy must allow WebSocket upgrades).