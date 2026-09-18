# DriveLocal on Oracle Cloud — Always Free

This deploys the full app (SQLite DB + uploads + Caddy HTTPS + backups) onto
Oracle Cloud's **Always Free** tier: no card, no hibernation, persistent disk,
always on. It uses the exact container layout from `docker-compose.yml` /
`DEPLOY.md §14` — nothing about the app changes.

## Cost: $0

- `VM.Standard.A1.Flex` (Ampere ARM, free shape) — pick **2 OCPU / 12 GB RAM**
  (or 4 OCPU / 24 GB, all free within the monthly allowance).
- The boot volume holds everything (SQLite in a Docker named volume + Caddy
  certs). Oracle gives 200 GB of free block storage; the app uses far less.
- No card required as long as you stay on Always Free shapes/limits (the A1
  family is the safe pick — not the paid "Flexible" capacity shapes).

## Prereqs you already have

- Your real `backend/.env` (ClickSend creds, VAPID keys, JWT secret, `DRIVER_PHONE`).
- A **domain** pointing at the VM's public IP. This is *required*: web push +
  PWA install + geolocation all need HTTPS, and Caddy only issues Let's Encrypt
  certificates for real domains (it won't for a bare IP). A cheap ~R100-150/yr
  `.co.za` domain works. Blank `YOCO_*` keeps it cash-only.

## 1. Create the VM (OCI Console)

1. Sign up/login at `cloud.oracle.com`. If prompted, upgrade to **Pay As You Go**
   after signing up — this keeps Always Free resources after the trial and is
   still $0 for free shapes. (You *can* stay on the free account; PAYG just
   avoids the "trial expired" freeze.)
2. **Create a VCN** (virtual network) in your home region, then add these
   **Ingress rules** to its security list (required for Caddy):
   - Ingress TCP `80` from `0.0.0.0/0`
   - Ingress TCP `443` from `0.0.0.0/0`
   (SSH `22` is usually there by default. Oracle also ships a *second* firewall
   inside the VM that blocks 80/443 — `setup.sh` opens that automatically, so
   you only deal with the VCN here.)

   **Region + capacity:** pick `af-johannesburg-1` for SA. Ampere (ARM) capacity
   is occasionally "out of stock" — if the shape won't launch, retry later or try
   another availability domain. Your home region is permanent; you can't change
   it after signup — choose carefully.
3. **Create Compute → Instance**:
   - Image: **Ubuntu 24.04** (Canonical) — or Oracle Linux 8 for Oracle-first.
   - Shape: "Specialty and Legacy" → **AMD** → `VM.Standard.E2.1.Micro` is the
     tiniest free AMD shape, but pick the **A1** family under "Ampere" →
     `VM.Standard.A1.Flex` with **OCPUs 2, Memory 12 GB** (edit those fields).
   - Networking: the VCN you made, assign a **public IPv4 address**.
   - **Add SSH keys**: paste a public key you generated with `ssh-keygen -t ed25519`.
   - Create. Wait for "Running" → copy the **public IP**.
4. **Reserve the public IP** (Instances → VNIC → IP Addresses → *Create
   Reserved IP*) so the address doesn't change on stop/start. Then point your
   domain's **A record** at it.

## 2. Get your `backend/.env` onto the box

Your local machine already has the real secrets in
`backend/.env` (same file we use for dev). Upload it:

```bash
scp backend/.env ubuntu@<VM-IP>:/tmp/backend.env
```

Do **not** paste secrets into a chat or commit them — SCP it directly.

## 3. Run the setup script

SSH in (key `-i ~/.ssh/id_ed25519` if needed):

```bash
ssh ubuntu@<VM-IP>
```

Copy just the single setup script up (it clones the repo itself):

```bash
# from your laptop:
scp deploy/oracle/setup.sh ubuntu@<VM-IP>:/tmp/setup.sh
```

Then run it with your domain (you uploaded the .env in step 2):

```bash
APP_DOMAIN=drivelocal.example.co.za DRIVELOCAL_ENV_FILE=/tmp/backend.env \
  bash /tmp/setup.sh
```

The script installs Docker, clones `BuhleMahlangu/LocalDrive`, copies
`/tmp/backend.env` into place, and runs:

```bash
sudo APP_DOMAIN=https://drivelocal.example.co.za docker compose --profile proxy up --build -d
```

## 4. Verify

```
https://drivelocal.example.co.za/health        -> {"ok":true,...}
```

- Sign in as the owner (`DRIVER_PHONE`) → real ClickSend OTP arrives.
- Add to Home Screen as PWA; grant location + push on the HTTPS origin.
- Book a ride end→end; watch `docker compose logs -f app` for socket events.
- `docker compose ps` — `app` (healthy), `caddy`, and `backup` (writes snapshots
  every `BACKUP_INTERVAL_HOURS`, kept in the `drivelocal-backups` volume).

## Backups / resilience

- SQLite + uploads live in the `drivelocal-data` Docker volume on the boot disk;
  rebuild/restart the app and nothing is lost.
- For off-host safety set the `BACKUP_S3_*` vars in `backend/.env` (any S3 bucket:
  Cloudflare R2 / Backblaze B2 free tiers) so the safety audit trail leaves the box.
- VM is *not* a Multi-AZ service — it's one free VM. A daily S3 backup is your
  real disaster plan; that's acceptable for a single-driver launch.

## Troubleshooting

- **Caddy cert stuck** → domain must resolve to the public IP first (dig your
  domain); open port 80 outbound on the VM too.
- **Ports blocked** → check the VCN **security list** ingress 80/443 (step 1).
- **Backend refuses to start** → it lists the missing/weak env vars; fix in
  `/opt/drivelocal/backend/.env`, then `sudo docker compose up -d`.
- **Free (non-PAYG) account** → Always Free shapes keep running after the trial;
  paid/block-storage capacity beyond the free grant does not. 200 GB free block
  storage is far above what this app needs.