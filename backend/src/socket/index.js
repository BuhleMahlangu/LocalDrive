const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const config = require('../config');
const repo = require('../db/repository');
const push = require('../services/push');

// Socket.io real-time layer.
// Rooms: `user:{id}` for direct pushes; `driver-location` for location broadcasts.
// Driver publishes location every ~3s; we broadcast to any listening customer rooms.

function initSocket(httpServer, corsOrigins) {
  const io = new Server(httpServer, {
    cors: { origin: corsOrigins, methods: ['GET', 'POST'] },
  });

  // Auto-offline grace timers per driver: a disconnect doesn't instantly mark
  // the driver offline — we wait a few seconds in case it's a page refresh,
  // network blip or dev restart. Reconnecting / publishing location cancels it.
  const offlineTimers = new Map();

  // ---- GPS spoofing / sanity detection ----
  // Track the last known fix per driver so a suspicious teleport (e.g. jumping
  // >50 km between 3-second pings) can be flagged and dropped. Also reject
  // coordinates that are plainly outside valid global ranges.
  const lastFixes = new Map();
  const spoofStreak = new Map();
  const MAX_SPOOF_KM = 50; // max plausible distance between pings (3s apart)

  function isPlausible(lat, lng) {
    return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
  }

  function isSpoofed(driverId, lat, lng, accuracy) {
    const last = lastFixes.get(driverId);
    lastFixes.set(driverId, { lat, lng });
    if (!last) return false;
    // A device claiming to be precise (>5km error) is reporting a junk/faked
    // fix — drop it rather than store a location that could be anywhere.
    if (typeof accuracy === 'number' && accuracy > 5000) return true;
    const km = geoKm(last.lat, last.lng, lat, lng);
    if (km > MAX_SPOOF_KM) {
      spoofStreak.set(driverId, (spoofStreak.get(driverId) || 0) + 1);
      // After 3 consecutive impossible jumps, hard-offline the driver — they are
      // almost certainly faking their GPS (or their device is broken).
      if (spoofStreak.get(driverId) >= 3) {
        console.warn(`[socket] ${driverId} flagged for impossible GPS jumps — going offline`);
        repo.setDriverOnline(driverId, false);
        spoofStreak.delete(driverId);
        io.emit('driver:status:update', { driverId, isOnline: false });
      }
      return true; // drop this fix
    }
    spoofStreak.delete(driverId);
    return false;
  }

  function geoKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function clearOfflineTimer(userId) {
    const timer = offlineTimers.get(userId);
    if (timer) {
      clearTimeout(timer);
      offlineTimers.delete(userId);
    }
  }

  function scheduleAutoOffline(userId) {
    clearOfflineTimer(userId);
    // Never auto-offline while the driver is mid-trip — a customer would be
    // stranded. Only idle drivers (no active trip) may auto-go offline.
    const active = repo.getActiveTripsForDriver(userId)[0];
    if (active) return;
    const setting = parseFloat(repo.getSetting('auto_offline_grace_ms'));
    const graceMs = Number.isFinite(setting) ? setting : config.autoOfflineGraceMs;
    offlineTimers.set(userId, setTimeout(() => {
      offlineTimers.delete(userId);
      repo.setDriverOnline(userId, false);
      io.emit('driver:status:update', { driverId: userId, isOnline: false });
    }, graceMs));
  }

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication required'));
    try {
      const payload = jwt.verify(token, config.jwtSecret);
      const user = repo.getUserById(payload.sub);
      if (!user) return next(new Error('User not found'));
      socket.user = user;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const { id, role } = socket.user;
    socket.join(`user:${id}`);
    console.log(`[socket] ${role} connected: ${id}`);
    // A fresh connection means the driver is back — cancel any pending offline.
    clearOfflineTimer(id);

    // Can this user act as a driver (admin owner or approved/vetted driver)?
    const isActiveDriver = () => socket.user.role === 'admin'
      || (socket.user.role === 'driver'
        && (socket.user.driverStatus === 'approved' || socket.user.driverStatus == null));

    // Driver: publish GPS every few seconds.
    socket.on('driver:location', (payload) => {
      if (!isActiveDriver()) return;
      // Driver is alive and streaming — no auto-offline.
      clearOfflineTimer(id);
      const { lat, lng, heading, accuracy } = payload || {};
      if (typeof lat !== 'number' || typeof lng !== 'number') return;
      if (!isPlausible(lat, lng)) return;
      if (isSpoofed(id, lat, lng, accuracy)) return;
      repo.upsertDriverLocation(id, { lat, lng, heading, accuracy });

      // Broadcast to any room listening for driver location.
      io.emit('driver:location:update', { driverId: id, lat, lng, heading, accuracy });

      // If this driver has an active trip, push live location to that customer.
      const active = repo.getActiveTripsForDriver(id)[0];
      if (active) {
        io.to(`user:${active.customerId}`).emit('trip:location', {
          tripId: active.id,
          lat, lng, heading,
        });
      }
    });

    // Customer: subscribe to a specific driver's location stream.
    socket.on('driver:subscribe', (driverId) => {
      const loc = repo.getDriverLocation(driverId);
      socket.emit('driver:location:init', { driverId, location: loc });
    });

    // Driver goes online/offline.
    socket.on('driver:online', (isOnline) => {
      if (!isActiveDriver()) return;
      repo.setDriverOnline(id, !!isOnline);
      io.emit('driver:status:update', { driverId: id, isOnline: !!isOnline });
      if (isOnline) clearOfflineTimer(id);
    });

    // Driver accepts/declines a requested trip.
    socket.on('trip:accept', (tripId) => {
      if (!isActiveDriver()) return;
      const trip = repo.getTripById(tripId);
      if (trip) {
        io.to(`user:${trip.customerId}`).emit('trip:accepted', { trip: serializeTrip(trip) });
      }
    });

    socket.on('disconnect', () => {
      console.log(`[socket] disconnected: ${id}`);
      // Only auto-offline after the grace period — a quick reconnect (page
      // refresh, network blip, dev restart) cancels it. Skip entirely if the
      // driver has an active trip so a customer is never left stranded.
      if (socket.user.role === 'driver' || socket.user.role === 'admin') scheduleAutoOffline(id);
    });
  });

  // Helper to notify a customer when a trip moves state (used by REST too).
  const notify = {
    tripUpdated(trip) {
      if (!trip) return;
      io.to(`user:${trip.customerId}`).emit('trip:updated', { trip: serializeTrip(trip) });
      if (trip.driverId) io.to(`user:${trip.driverId}`).emit('trip:updated', { trip: serializeTrip(trip) });
    },
    newTripToDriver(trip, driverId, driverPublic) {
      io.to(`user:${driverId}`).emit('trip:request', { trip: serializeTrip(trip), driverPublic });
      // Web push if the driver isn't connected (or as extra belt).
      push.sendToUser(driverId, {
        title: 'New booking request',
        body: `${trip.pickup?.address || 'Pickup'} → ${trip.destination?.address || 'Destination'} · est. R${trip.fareEstimate != null ? trip.fareEstimate : '?'}`,
        data: { type: 'newTrip', tripId: trip.id },
      });
    },
    scheduledTripAdded(trip, driverId) {
      if (!trip || !driverId) return;
      io.to(`user:${driverId}`).emit('trip:scheduled', { trip: serializeTrip(trip) });
      push.sendToUser(driverId, {
        title: 'Scheduled ride booked',
        body: `Pre-booked: ${trip.pickup?.address || 'Pickup'} → ${trip.destination?.address || 'Destination'}`,
        data: { type: 'scheduledTrip', tripId: trip.id },
      });
    },
    tripAccepted(trip) {
      if (!trip) return;
      io.to(`user:${trip.customerId}`).emit('trip:accepted', { trip: serializeTrip(trip) });
      push.sendToUser(trip.customerId, {
        title: 'Driver on the way',
        body: 'Your driver has accepted your booking.',
        data: { type: 'tripAccepted', tripId: trip.id },
      });
    },
    tripArrived(trip) {
      if (!trip) return;
      io.to(`user:${trip.customerId}`).emit('trip:arrived', { trip: serializeTrip(trip) });
      push.sendToUser(trip.customerId, {
        title: 'Your driver has arrived',
        body: 'Step outside when you see the car.',
        data: { type: 'tripArrived', tripId: trip.id },
      });
    },
    paymentUpdated(payment, trip) {
      if (!payment || !trip) return;
      const payload = { tripId: trip.id, status: payment.status, trip: serializeTrip(trip) };
      if (trip.customerId) io.to(`user:${trip.customerId}`).emit('payment:updated', payload);
      if (trip.driverId) io.to(`user:${trip.driverId}`).emit('payment:updated', { tripId: trip.id, status: payment.status });
    },
    // In-trip chat: deliver the message to the other participant's room in real
    // time (the sender already has it optimistically in the UI).
    chatMessage(message, trip) {
      if (!message || !trip) return;
      const recipientId = message.senderId === trip.customerId ? trip.driverId : trip.customerId;
      if (recipientId) {
        io.to(`user:${recipientId}`).emit('chat:message', { message });
      }
    },
    chatRead(trip, readerId) {
      if (!trip || !readerId) return;
      const recipientId = readerId === trip.customerId ? trip.driverId : trip.customerId;
      if (recipientId) {
        io.to(`user:${recipientId}`).emit('chat:read', { tripId: trip.id, readerId });
      }
    },
    driverStatus(driverPublic) {
      io.emit('driver:status', driverPublic);
    },
    onlineDriversChanged(drivers) {
      io.emit('drivers:online', drivers);
    },
  };

  return { io, notify };
}

function serializeTrip(trip) {
  // Include customer name for the driver view (kept minimal). Most trip objects
  // already carry customer info from `withCustomerInfo`, so only look up when
  // missing — avoids a DB round-trip per event on shared trips.
  if (trip.customerId && trip.customerName == null && trip.customerPhone == null) {
    const c = repo.getUserById(trip.customerId);
    trip.customerName = c ? c.name : null;
    trip.customerPhone = c ? c.phone : null;
  }
  return trip;
}

module.exports = { initSocket };
