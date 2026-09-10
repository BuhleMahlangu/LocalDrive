# Deploying DriveLocal

This is a single-owner ride app: one Express + Socket.io backend (SQLite) and one
React (Vite + PWA) frontend. Nothing here actually happens until you pick a host
and add real credentials — this doc is the runbook for doing that.

## What you need to decide

1. **One host (simplest)** — serve the built frontend *and* the API from the
   same HTTPS domain behind a reverse proxy. No `VITE_API_BASE` needed.
2. **Two hosts** — SPA on a static host (Vercel/Netlify/Cloudflare Pages) and the
   API on a Node host. Set `VITE_API_BASE=https://api.your-domain.com` and rebuild.

Geolocation and camera/audio on phones require **HTTPS** (or localhost), so a real
domain matters — your phone will refuse location on a plain HTTP address.

## Backend (Express + Socket.io + SQLite)

```
cd backend
npm ci
npm run seed          # first time only — creates a real SQLite DB + demo data
cp .env.example .env  # then edit it (see below)
NODE_ENV=production node src/server.js   # or npm start, or use pm2/systemd
```

Required env vars (see `backend/.env`):
| Variable | Purpose |
| --- | --- |
| `NODE_ENV` | `production` for real run (dev shows the OTP in console + allows `123456`) |
| `JWT_SECRET` | long random string — **change it**, never commit it |
| `YT_ACCOUNT_SID` / `YT_AUTH_TOKEN` / `YT_SENDER_ID` | Twilio-ish SMS for OTPs (optional in dev) |
| `YOCO_API_KEY` / `YOCO_API_BASE` | card payments (optional – app falls back to cash-only) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | web push notifications |
| `ADMIN_PHONE` | the owner-driver phone used to sign in as driver |

> OTP in production: the app sends a real SMS. In development it logs the code to
> the server console and accepts `123456`. Keep `NODE_ENV=development` for local
> testing to avoid burning SMS credits.

Forward traffic to port **4000**. If using Caddy/nginx, also proxy WebSocket
upgrades (`Upgrade`/`Connection` headers) so live tracking works.

## Frontend (React + Vite PWA)

```
cd app
npm ci
npm run build                       # outputs app/dist (PWA + service worker)
npm run preview                     # local check of the built app
```

Upload `app/dist/*` to your static host or configure your one-host setup to serve
these files with a **SPA fallback**: every route that isn't a real file should
return `index.html` (required for the `/trip/:id` public tracker links).

On one-host setups nothing else is needed. On a two-host setup follow the
two-host notes above.

## Environment matrix (recommended production values)

| Setting | Local dev | Production |
| --- | --- | --- |
| `VITE_API_BASE` | unset (Vite proxy) | unset on one host, or `https://api.your-domain` |
| `VITE_DRIVER_PHONE` | `+27000000000` | same number (owner driver) |
| `NODE_ENV` | `development` | `production` |
| Web push/VAPID | optional | needed for notifications |

## Post-deploy checklist

- [ ] HTTPS works and the PWA installs (browser install prompt).
- [ ] SMS OTP arrives (or locally `123456`), sign in as customer and driver.
- [ ] Browser **location permission** allowed — this is the #1 gotcha. On a phone
      it must be granted for the domain (Settings → Privacy → Location).
- [ ] Book a trip end→end: request → driver accepts → **driver taps "I've arrived"**
      → customer sees the arrived card → start trip → dropdown → fare confirm →
      rating. Live socket updates work (no CORS/WS proxy errors in console).
- [ ] `GET /api/public/trips/<id>/live` opens without logging in (share links).
- [ ] Yoco card flow if enabled.
- [ ] Backup: run `npm run backup` in `backend/` on a schedule that suits you.
      SQLite is a single file — copy it off the server.

## Notes & gotchas

- The tracker page and PWA live at the same origin, so shared trip links work
  even with the app installed.
- Browser audio for the request chime needs a user gesture first (it primes on
  the first tap) — do not expect sound in the background tab/phone locked.
- Don't change `platformFeePercent` and `autoOfflineGraceMs` in code — use the
  **Admin** tab in the driver app (writes to the fast `settings` table).
- Web push only works on HTTPS with a service worker — the frontend build wires
  push handlers into the generated `sw.js` automatically.