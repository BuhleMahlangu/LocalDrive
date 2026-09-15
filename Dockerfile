# ---- Frontend build stage ------------------------------------------------
# Build the React PWA. The backend serves app/dist in the same image (the
# one-host model from DEPLOY.md), so no VITE_API_BASE is needed here.
FROM node:20-bookworm-slim AS web
WORKDIR /build/app
COPY app/package.json app/package-lock.json ./
RUN npm ci
COPY app/ .
RUN npm run build

# ---- Runtime stage --------------------------------------------------------
# Node backend (Express + Socket.io). The built SPA is copied in from the
# web stage; the backend's /api and /socket.io routes serve it all together.
FROM node:20-bookworm-slim
WORKDIR /app

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

COPY backend/ .
# Place the SPA where backend/src/app.js expects it (path.join(__dirname, '..', '..', 'app', 'dist')).
COPY --from=web /build/app/dist ./dist

ENV NODE_ENV=production
ENV PORT=4000
ENV DB_FILE=/data/drivelocal.sqlite

# SQLite state + backups live on a volume so the container is disposable.
VOLUME ["/data", "/app/backups"]

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- http://127.0.0.1:4000/health || exit 1

# Seed the owner-driver on every start (idempotent), then run the API.
CMD ["sh", "-c", "node src/scripts/seed.js && node src/server.js"]