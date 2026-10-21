# DriveLocal

A **one-driver booking platform** for South Africa (pricing in ZAR). You are the only driver — customers book rides with you, track you in real time, and pay/tip in-app. No multi-driver complexity.

```
LocalDrive/
├── backend/   # Node.js (Express + Socket.io) REST API
│   ├── src/   # config, routes, services, socket, db
│   ├── test/  # unit tests (node --test)
│   └── scripts/  # seed.js, backup.js, smoke.js (E2E, server must be running)
└── app/       # Single React (Vite) PWA — customer + driver views in one
```

## Deploying

Two supported shapes (full instructions in **[DEPLOY.md](DEPLOY.md)**):

- **One host** — the backend serves the API *and* the built SPA behind Caddy
  (§1–§14). Simplest to run.
- **Split** — the SPA is a static site on **Vercel**, the API + WebSockets run on
  **Railway** or **Render** with **SQLite on a persistent volume**
  ([§12](DEPLOY.md#12-split-deployment-vercel--railway--render)). Ready-to-deploy
  configs ship in the repo: `app/vercel.json`, `Dockerfile.backend`,
  `railway.toml`, `render.yaml`.

```bash
# one host
docker compose up --build          # backend + SPA + optional Caddy

# split: backend on Railway/Render (DB on the volume at /data)
docker build -f Dockerfile.backend -t drivelocal-api .
# split: frontend on Vercel (root directory = app/)
cd app && VITE_API_BASE=https://<api-host> npm run build
```

## Stack

| Layer | Tech |
|-------|------|
| Frontend | React 18 + Vite + Leaflet (OSM maps) + Socket.io client, PWA installable |
| Backend | Node.js + Express + Socket.io + better-sqlite3 (SQLite) |
| Auth | Phone + 6-digit PIN (set at signup) + JWT — salted scrypt hashes, throttled per phone and per IP. No OTP, no passwords |
| Payments | Yoco hosted checkout (card) — cash by default until `YOCO_SECRET_KEY` is set |
| Revenue | Monthly **driver subscription** (freemium: owner free, others paid) — no per-ride commission |
| Real-time | Socket.io (driver GPS streaming every 3s + live trip pushes) |
| Currency | ZAR (South African Rand) |

## Quick start

```bash
# Terminal 1 — backend  (port 4000)
cd backend
npm install
npm run dev

# Terminal 2 — web app  (port 5173)
cd app
npm install
npm run dev
```

Open **http://localhost:5173**. If you already have a session you'll go straight in; otherwise you land on a start page and choose **Book a ride** (customer) or **I'm the driver**.

## First login (real accounts)

There is **no demo data** — the database starts empty and you create real
accounts through the app. The owner (driver) account is the phone in
`DRIVER_PHONE`; run `npm run seed` once to create it (and set the service area),
or just log in with that number.

| Role | Phone |
|------|-------|
| Owner / driver | your `DRIVER_PHONE` |
| Customer | any other phone you sign in with |

**PIN login:** sign in with your phone + a 6-digit PIN. The first time you sign in
with a number, you set the PIN; after that you enter it. There are no passwords and
no codes to wait for. Repeated wrong PINs are throttled (5 per minute per number,
20 per minute per IP), so a forgotten PIN means waiting a minute, not a lockout —
the owner can reset it if needed.

> Because it's **one app**, logging in with the driver phone opens the **driver dashboard** (requests, online toggle, earnings, profile) and any other phone opens the **customer app**. Use "**Driver mode / Customer mode**" in the header to switch views without logging out.

Only the phone in `DRIVER_PHONE` becomes the owner/admin. Anyone else who picks "I'm the driver" submits an **application** the owner approves or rejects from the Admin tab.

To see the full booking flow, open the app in **two windows** (e.g. normal + incognito): log in as the driver in one (toggle **Online**), and as a customer in the other — then book and accept.

## Features

**Customer**
- Start page to choose **customer / driver** login, PIN login (no passwords)
- GPS auto-pickup + tap-map pickup & destination pins you can **re-adjust** at any time
- Landmark chips + free-text "describe this place" notes (for areas without street names)
- Real-time driver tracking, route line, live ZAR fare estimate
- Call / WhatsApp the driver during a trip
- **Cash or Card** (Yoco hosted checkout) payment choice at booking — the Card option hides automatically until Yoco is configured
- Transparent **fare breakdown** (base + distance + time) before booking
- **Schedule a ride** for a future time — book now, ride later, or cancel it anytime before the driver starts it
- **Saved places** (Home / Work / Taxi rank / School) for one-tap booking
- **Preset pickup spots** — managed by the owner in Admin → Spots, shown as pins on the driver's map and as one-tap options in the customer's Book screen (no GPS permission needed)
- Receipts, ride history, one-tap rebook of a previous route, **share receipt** via WhatsApp
- **Fare disputes** — raise one from a completed trip; the owner reviews and resolves it, and you're notified of the outcome
- Star rating + optional tip + quick **feedback tags** after each ride
- **Web push** notifications (trip accepted / driver on the way)
- **Dark mode** toggle + installable PWA, works offline

**Driver (you)**
- Go online/offline toggle (broadcasts GPS live)
- Incoming request card with pickup/destination notes + **10-second auto-decline** countdown, with Call/WhatsApp and map-navigate shortcuts
- **Upcoming scheduled rides** card — start pre-booked trips with one tap
- **Web push** notifications for new booking requests (and scheduled-trip activation)
- Active trip flow: Start → Complete, with customer call/WhatsApp
- Earnings dashboard: **take-home this week**, today's fares, avg fare, tips, avg rating, ride counts
- Full trip history with fares, tips and ratings, and which customer each ride was for
- Profile editor: vehicle, license plate, service radius, base fare, per-km, per-min rates
- **Owner admin console**: driver vetting, trip audit records (map + chat + payments), payouts/EFT export, ops dashboard, and **fare-dispute review**

## Environment configuration

Copy `backend/.env.example` → `backend/.env` and fill in. **Features activate automatically once their key is present.** With everything empty, the app runs on cash + phone/PIN login + straight-line fare estimates.

| Variable | Purpose |
|----------|---------|
| `DRIVER_PHONE` | The owner-driver's phone (E.164). Gates who may act as driver. Default `+27000000000` |
| `JWT_SECRET` | Token signing. Production refuses to start unless it's a strong random value (32+ chars) |
| *(SMS — SOS only)* | **Optional.** `SMS_PROVIDER=whatsapp` + `WHATSAPP_ACCESS_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID`, or `africastalking` / `twilio` / `clicksend` + that provider's credentials (`AT_*`, `TWILIO_*`, `CLICKSEND_*`). Powers emergency SOS alerts. In dev/test messages are logged to the console (no credit burned); set `SMS_FORCE=true` to send for real |
| *(Email — notifications)* | **Optional.** `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` (+ optional `SMTP_PORT`, `SMTP_SECURE`, `SMTP_FROM`) for account/trip notification emails |
| `YOCO_SECRET_KEY` / `YOCO_WEBHOOK_SECRET` | **Card payments** via Yoco hosted checkout; also sets `YOCO_SUCCESS_URL` / `YOCO_CANCEL_URL` to your HTTPS URLs |
| `GOOGLE_MAPS_API_KEY` | True Google routing + polylines instead of straight-line estimates |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | **Web push** notifications (`npx web-push generate-vapid-keys`) |
| `CORS_ORIGINS` | Comma-separated allowed origins (default `http://localhost:5173`). On a split deploy this is the frontend's exact origin |
| `TRUST_PROXY` | Proxy hops to trust for the client IP (default `1` in production). Keeps the per-IP PIN throttle per-user behind a proxy — see [DEPLOY.md §12.6](DEPLOY.md#126-trust_proxy-why-it-matters-here) |
| `DB_FILE` / `UPLOADS_DIR` | Where SQLite and the uploaded documents live. Point both at the mounted volume (`/data/…`) on Railway/Render so they survive redeploys |
| `VITE_API_BASE` | *(frontend)* the API origin when the SPA is hosted separately. Baked in at **build** time — changing it needs a rebuild |

PIN attempts are **rate-limited** per phone (5 failures / 60s window) and per IP (20 failures / 60s window); only failures count, so a correct login is never throttled.

> **Production safety:** the backend **fails fast** on `NODE_ENV=production` if `JWT_SECRET` or `DRIVER_PHONE` are missing or weak, **or if no service-area centre is set** (`SERVICE_AREA_LAT`/`LNG`). Login is phone + PIN, so no OTP delivery path is required. Web push, geolocation and PWA install require **HTTPS** (or `localhost`).

## Tests, lint, backups

```bash
cd backend
npm run seed        # create the owner/admin account (+ location)
npm test            # unit tests (node --test, in-memory DB)
npm run lint        # ESLint (also: cd app && npm run lint)
npm run smoke       # end-to-end API test (server must be running first)
npm run backup      # SQLite online backup -> backend/backups (keeps last 14)

cd app
npm run build       # production build + PWA service worker
```

## Roadmap / when you go live

- **Enable card payments** — add real `YOCO_SECRET_KEY` + `YOCO_WEBHOOK_SECRET`, set success/cancel URLs to your HTTPS domain.
- **Auth** — done: phone + a 6-digit PIN set at signup, stored as a salted scrypt hash and throttled per phone/IP. No OTP provider needed.
- **Monetisation** — done: monthly **driver subscription** (freemium — the owner drives free, other drivers pay to receive bookings). Manage it in **Admin → Subscriptions**; drivers keep 100% of each fare. No per-ride commission.
- **Real routing** — add a `GOOGLE_MAPS_API_KEY` for true road distances/ETAs.
- **HTTPS hosting** — required for web push, in-app geolocation and secure payments. Free path (Oracle Cloud Always Free + DuckDNS) in `DEPLOY.md` §15.
- **Driver payouts** — card fares settle via Yoco; cash fares go hand-to-hand. Payout batches for card earnings are in the driver **Payouts** tab.
- **Database** — SQLite is fine for one driver; migrate to Postgres/PostGIS (`schema.sql` mirrored) if you scale.
