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

## Stack

| Layer | Tech |
|-------|------|
| Frontend | React 18 + Vite + Leaflet (OSM maps) + Socket.io client, PWA installable |
| Backend | Node.js + Express + Socket.io + better-sqlite3 (SQLite) |
| Auth | Phone OTP (ClickSend in prod, console in dev) + JWT |
| Payments | Yoco hosted checkout (card) — cash by default until `YOCO_SECRET_KEY` is set |
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

## Demo accounts

The driver account is seeded by `npm run seed`. Dev OTP is always **`123456`**.

| Role | Phone |
|------|-------|
| Driver (you) | `+27000000000` (Chevrolet Spark LT · XX 000 XX) |
| Customer | any other phone, e.g. `+27730002222` |

> Because it's **one app**, logging in with the driver phone opens the **driver dashboard** (requests, online toggle, earnings, profile) and any other phone opens the **customer app**. Use "**Driver mode / Customer mode**" in the header to switch views without logging out.

Only the phone in `DRIVER_PHONE` can ever act as the driver — the backend refuses to create a driver account for any other number (a safety gate added so a stranger picking "I'm the driver" can't see customers' bookings).

To see the full booking flow, open the app in **two windows** (e.g. normal + incognito): log in as the driver in one (toggle **Online**), and as a customer in the other — then book and accept.

## Features

**Customer**
- Start page to choose **customer / driver** login, OTP login (no passwords)
- GPS auto-pickup + tap-map pickup & destination pins you can **re-adjust** at any time
- Landmark chips + free-text "describe this place" notes (for areas without street names, e.g. Thubelihle / Kriel)
- Real-time driver tracking, route line, live ZAR fare estimate
- Call / WhatsApp the driver during a trip
- **Cash or Card** (Yoco hosted checkout) payment choice at booking — the Card option hides automatically until Yoco is configured
- Receipts, ride history, one-tap rebook of a previous route
- Star rating + optional tip after each ride
- **Web push** notifications (trip accepted / driver on the way)

**Driver (you)**
- Go online/offline toggle (broadcasts GPS live)
- Incoming request card with pickup/destination notes + **10-second auto-decline** countdown, with Call/WhatsApp and map-navigate shortcuts
- **Web push** notifications for new booking requests
- Active trip flow: Start → Complete, with customer call/WhatsApp
- Earnings dashboard (today / total / trips)
- Full trip history with fares, tips and ratings
- Profile editor: vehicle, license plate, service radius, base fare, per-km, per-min rates

## Environment configuration

Copy `backend/.env.example` → `backend/.env` and fill in. **Features activate automatically once their key is present.** With everything empty, the app runs on cash + dev OTP + straight-line fare estimates.

| Variable | Purpose |
|----------|---------|
| `DRIVER_PHONE` | The owner-driver's phone (E.164). Gates who may act as driver. Default `+27000000000` |
| `JWT_SECRET` | Token signing. Production refuses to start unless it's a strong random value (32+ chars) |
| `CLICKSEND_USERNAME` / `CLICKSEND_API_KEY` / `SMS_FROM` | Real SMS OTP via **ClickSend** (pay-as-you-go; `SMS_FROM` is an optional SA-friendly sender). In dev, OTPs print to the backend console (`123456`); any other env generates a random code |
| `YOCO_SECRET_KEY` / `YOCO_WEBHOOK_SECRET` | **Card payments** via Yoco hosted checkout; also sets `YOCO_SUCCESS_URL` / `YOCO_CANCEL_URL` to your HTTPS URLs |
| `GOOGLE_MAPS_API_KEY` | True Google routing + polylines instead of straight-line estimates |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | **Web push** notifications (`npx web-push generate-vapid-keys`) |
| `FCM_SERVER_KEY` | Optional legacy FCM push |
| `CORS_ORIGINS` | Comma-separated allowed origins (default `http://localhost:5173`) |

OTP requests are **rate-limited** per phone (3 / 60s window, 10 / day) to stop SMS-bombing.

> **Production safety:** the backend **fails fast** on `NODE_ENV=production` if `JWT_SECRET`, ClickSend credentials, or `DRIVER_PHONE` are missing or weak. Web push, geolocation and PWA install require **HTTPS** (or `localhost`).

## Tests, lint, backups

```bash
cd backend
npm run seed        # create/update demo accounts + driver
npm test            # unit tests (node --test, in-memory DB)
npm run lint        # ESLint (also: cd app && npm run lint)
npm run smoke       # end-to-end API test (server must be running first)
npm run backup      # SQLite online backup -> backend/backups (keeps last 14)

cd app
npm run build       # production build + PWA service worker
```

## Roadmap / when you go live

- **Enable card payments** — add real `YOCO_SECRET_KEY` + `YOCO_WEBHOOK_SECRET`, set success/cancel URLs to your HTTPS domain.
- **Real SMS OTP** — add live `CLICKSEND_USERNAME` / `CLICKSEND_API_KEY` (and an SA `SMS_FROM` if wanted), then set `NODE_ENV=production`.
- **Real routing** — add a `GOOGLE_MAPS_API_KEY` for true road distances/ETAs.
- **HTTPS hosting** — required for web push, in-app geolocation and secure payments. See `DEPLOY.md`.
- **Driver payouts** — MVP pays 100% to the owner (single driver). Yoco payouts if you ever split fares.
- **Database** — SQLite is fine for one driver; migrate to Postgres/PostGIS (`schema.sql` mirrored) if you scale.