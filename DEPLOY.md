# DriveLocal — production deployment

This guide takes the app live for a small single-driver service: a VPS (or always-on home server) running the Node backend, a static build of the React app, and **Caddy** providing HTTPS + reverse proxy (handles the Socket.io WebSockets automatically).

The path below is the recommended **one-host** setup (frontend + API + WebSockets on one HTTPS domain). A lighter **two-host** alternative (static SPA + API) is covered at the end.

> Prefer containers? Jump to **[§14 Docker](#14-docker-alternative-optional)** — a multi-stage `Dockerfile` + `docker-compose.yml` (with optional Caddy) are included at the repo root.

## 1. What you need

- A domain — a **free DuckDNS subdomain** works fine (e.g. `drivelocal.duckdns.org`), or your own domain.
- A server with Node.js 18+ (we recommend Node 20/22 LTS). Ubuntu/Debian assumed below. **Oracle Cloud Always Free** (ARM Ampere, 4 cores / 24 GB) runs this comfortably at R0/month — see §15.
- Real keys from: **Yoco** (card payments — optional for launch), VAPID keys for push (`npx web-push generate-vapid-keys`), and an **OTP provider** — WhatsApp Cloud API (free tier, recommended), or an SMS provider (Africa's Talking / Twilio / ClickSend), or SMTP email. See §13.

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
npm run seed          # create the owner/admin account + location
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
# The town the app serves. Set this (or configure it later in Admin → Settings).
SERVICE_AREA_NAME=Kriel, Mpumalanga
SERVICE_AREA_LAT=-26.2155
SERVICE_AREA_LNG=29.2916
SERVICE_AREA_RADIUS_KM=30
# OTP delivery — production refuses to start unless a real path is configured.
# There is no fixed-code fallback.
# Recommended for SA: WhatsApp Cloud API (free tier / cheapest OTPs).
SMS_PROVIDER=whatsapp
WHATSAPP_ACCESS_TOKEN=...
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_OTP_TEMPLATE=drivelocal_otp      # approved Authentication template
WHATSAPP_TEMPLATE_LANG=en

# Alternative OTP providers (pick ONE for SMS_PROVIDER):
#   SMS_PROVIDER=africastalking  → AT_API_KEY, AT_USERNAME, AT_SENDER_ID
#   SMS_PROVIDER=twilio          → TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM
#   SMS_PROVIDER=clicksend       → CLICKSEND_USERNAME, CLICKSEND_API_KEY, CLICKSEND_FROM
#   Email fallback (any provider) → SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM
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

> The server **will not start** in production without JWT + DRIVER_PHONE. That's deliberate. It **also refuses to start without a working OTP delivery path** (WhatsApp/SMS or SMTP) and **without a service-area centre** — so you can never accidentally ship a fixed code to real users or run with the map pointing at nowhere.

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
- [ ] **Sign-in works with a real code** — the OTP is delivered by WhatsApp/SMS/email. Sign in as both customer and driver.
- [ ] **Location permission granted** — the #1 gotcha. On a phone it must be allowed for the domain (Settings → Privacy → Location); without it the customer can't pick up automatically and push needs HTTPS anyway.
- [ ] **Book a trip end→end**: request → driver accepts → driver taps "I've arrived" → customer sees the arrived card → start trip → fare confirm → rating. Watch for live socket updates (no CORS / WS proxy errors in the browser console).
- [ ] **Share link** `GET /api/public/trips/<id>/live` opens without logging in.
- [ ] **Yoco card flow** if enabled (hosted checkout → success/cancel redirect).
- [ ] **Backup** — schedule `npm run backup` nightly and copy the snapshots off the server.
- [ ] **Pickup spots set up** — add the preset pickup spots via the owner app's **Admin → Spots** tab (tap "Add spot", then the map; each shows as a pin to every customer and driver).

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
- Don't change `autoOfflineGraceMs` in code — use the **Admin** tab in the driver app
  (writes to the fast `settings` table). Changed values are picked up by the
  backend scheduler, so no restart needed. (Rides no longer carry a commission —
  see the subscription model below.)
- Web push only works on HTTPS with a service worker — the frontend build wires
  push handlers into the generated `sw.js` automatically.
- **OTP delivery** uses whichever provider is configured (WhatsApp Cloud API
  recommended, or Africa's Talking / Twilio / ClickSend / SMTP email). In
  development and tests the code is logged to the server console instead of being
  sent. Production refuses to boot without a real delivery path.
- **Service area** (the town the app serves) is set from `SERVICE_AREA_*` or at
  runtime in **Admin → Settings**; the saved value wins. It centres the maps and
  bounds how far they can be panned. Production refuses to boot without a centre.
- **Monetisation is a monthly driver subscription, not a per-ride cut.** Revenue
  from cash rides is impossible to intercept, so the model is freemium: the owner
  account (role `admin`, i.e. `DRIVER_PHONE`) drives **free forever**, and every
  other driver needs an active paid period to go online and accept rides (they
  keep 100% of each fare). Manage plans and record manual payments (EFT/cash) from
  the owner app's **Admin → Subscriptions** tab; drivers see their status and
  payment history under the **Subscription** tab.

## 14. Docker (alternative, optional)

The repo ships with container files for a **single-container** deployment that matches
the one-host model: the backend serves both the API and the built SPA.

Files:
- `Dockerfile` — multi-stage: builds the PWA, then runs the Node backend with `app/dist` baked in.
- `docker-compose.yml` — `app` (backend) service + an **optional** `caddy` proxy service (HTTPS).
- `Caddyfile` — reverse-proxies everything to the app container (WebSockets included).

### Local test

```bash
cp backend/.env.example backend/.env   # add real secrets; DB_FILE is set by compose
docker compose up --build app          # http://localhost:4000
```

### Production

1. Point your domain at the host; open ports 80/443.
2. Fill `backend/.env` per the §7 checklist (production fail-fast still applies).
3. Set `APP_DOMAIN=https://your.domain` (compose env) and start everything:

```bash
APP_DOMAIN=https://drivelocal.example.co.za docker compose --profile proxy up --build -d
```

Caddy provisions the Let's Encrypt certificate automatically and routes `/api` and
`/socket.io` to the app. SQLite data is kept in named volumes (`drivelocal-data`,
`drivelocal-backups`) so the container is disposable.

> Nothing is lost if the container is recreated: the DB lives in the `drivelocal-data`
> volume and `npm run backup` inside the container writes to the `drivelocal-backups`
> volume (schedule it via cron/systemd on the host). Keep backups off the host too.

### Automatic backups (compose `backup` service)

The compose file also starts a `backup` service (same image, no open ports) that
runs `node src/scripts/backup-loop.js`: an online SQLite backup on boot, then every
`BACKUP_INTERVAL_HOURS` (default 6). It keeps the newest `BACKUP_KEEP` copies in the
`drivelocal-backups` volume.

```bash
docker compose up --build -d            # starts app + backup together
```

**Off-site copy (strongly recommended):** point the backup service at any
S3-compatible bucket (AWS S3, Cloudflare R2, Backblaze B2, MinIO…) so a dead or
stolen host can never destroy the safety audit trail. Add these to the shell
running compose (or to `backend/.env`):

```bash
BACKUP_S3_ENDPOINT=https://s3.af-south-1.amazonaws.com   # R2/B2/MinIO endpoints work too
BACKUP_S3_BUCKET=drivelocal-backups
BACKUP_S3_KEY=...
BACKUP_S3_SECRET=...
BACKUP_S3_REGION=af-south-1       # default us-east-1
BACKUP_S3_PREFIX=drivelocal       # object-key prefix inside the bucket
```

Uploads use AWS SigV4 (path-style) with no SDK — the same code works for any
S3-compatible provider. Restore by copying a snapshot's `.sqlite` file over
`/app/data/drivelocal.sqlite` (the `drivelocal-data` volume) and restarting `app`. The `backup` container runs inside the same network and needs **no** network config beyond DNS access to the object-storage endpoint.

## 15. Free hosting: Oracle Cloud Always Free + DuckDNS

This is the fully-free stack: an **Oracle Cloud Always Free** ARM VM (Ampere A1 — up to 4 cores / 24 GB RAM, free forever), a free **DuckDNS** subdomain, and **Caddy** for automatic HTTPS. Total cost: **R0/month**. No cold starts (unlike Render/Railway free tiers, which sleep and kill Socket.io), and SQLite + WebSockets work natively.

### 15.1 Create the VM

1. Sign up at Oracle Cloud and pick a home region close to your users (e.g. `af-johannesburg-1`).
2. Create a **Compute → Instance**:
   - Shape: **Ampere → VM.Standard.A1.Flex** (Always Free eligible; 2–4 OCPUs / 12–24 GB).
   - Image: **Ubuntu 22.04 or 24.04**.
   - Boot volume: default (Always Free covers up to 200 GB).
3. Upload your SSH key, create the instance, note its **public IP**.
4. In the instance's VCN **Security List / Network Security Group**, add ingress rules for **TCP 80** and **TCP 443** from `0.0.0.0/0` (Oracle images also ship an `iptables`/`firewalld` firewall — see 15.4).

### 15.2 Free domain (DuckDNS)

1. Go to [duckdns.org](https://www.duckdns.org), sign in, create a subdomain like `drivelocal`.
2. Set its IP to your VM's public IP (`drivelocal.duckdns.org → <public IP>`).
3. Use `drivelocal.duckdns.org` everywhere the guide says `drivelocal.example.co.za`.

> DuckDNS is a plain DNS provider — Let's Encrypt will issue a certificate for it exactly as for a paid domain, so nothing else changes.

### 15.3 Install the stack

```bash
# Node 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
# Caddy (official repo)
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

# App
sudo mkdir -p /opt/drivelocal && sudo chown $USER /opt/drivelocal
cd /opt/drivelocal
git clone <your-repo> .        # or scp the folders up
cd app && npm ci && npm run build && cd ..
cd backend && npm install --omit=dev && cp .env.example .env
```

Edit `backend/.env` per the **§7 checklist**, with `CORS_ORIGINS=https://drivelocal.duckdns.org`. Then seed and run under PM2:

```bash
cd /opt/drivelocal/backend
npm run seed
sudo npm install -g pm2
pm2 start "node src/server.js" --name drivelocal && pm2 save && pm2 startup
```

Point Caddy at it (copy the §5 Caddyfile, replacing the domain with your DuckDNS name):

```bash
sudo cp /opt/drivelocal/Caddyfile.example /etc/caddy/Caddyfile   # or write it from §5
sudo systemctl reload caddy
```

Caddy fetches the certificate on first request. Open `https://drivelocal.duckdns.org`.

### 15.4 Gotchas on Oracle

- **Two firewalls.** Oracle's cloud Security List **and** the VM's own firewall must both allow 80/443. On Ubuntu images that ships as `iptables`:
  ```bash
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
  sudo netfilter-persistent save
  ```
- **Keep port 4000 bound to localhost** (Caddy is the only public entry point) — this is already the default.
- **Backups:** schedule §6's `npm run backup` nightly; the Always Free boot volume is not a backup. Add the optional **S3-compatible off-site** copy (Cloudflare R2 free tier works well) from §14.
- **Always Free capacity:** Ampere A1 availability varies by region; if you can't create one, try another region or the `VM.Standard.E2.1.Micro` shape (also Always Free, smaller).

## Troubleshooting

- **Backend won't start** → read the error: production fail-fast lists exactly which env vars are missing/weak.
- **Push/geolocation don't work** → they need HTTPS; check the browser console for permissions.
- **Card option missing** → Yoco not configured (`npm run dev` server was started before keys were added — restart it).
- **Socket.io keeps reconnecting** → confirm Caddy proxies `/socket.io` (your nginx/caddy must allow WebSocket upgrades).