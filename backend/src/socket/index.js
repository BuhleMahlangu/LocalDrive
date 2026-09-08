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

    // Driver: publish GPS every few seconds.
    socket.on('driver:location', (payload) => {
      if (role !== 'driver') return;
      const { lat, lng, heading, accuracy } = payload || {};
      if (typeof lat !== 'number' || typeof lng !== 'number') return;
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
      if (role !== 'driver') return;
      repo.setDriverOnline(id, !!isOnline);
      io.emit('driver:status:update', { driverId: id, isOnline: !!isOnline });
    });

    // Driver accepts/declines a requested trip.
    socket.on('trip:accept', (tripId) => {
      if (role !== 'driver') return;
      const trip = repo.getTripById(tripId);
      if (trip) {
        io.to(`user:${trip.customerId}`).emit('trip:accepted', { trip: serializeTrip(trip) });
      }
    });

    socket.on('disconnect', () => {
      console.log(`[socket] disconnected: ${id}`);
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
    paymentUpdated(payment, trip) {
      if (!payment || !trip) return;
      const payload = { tripId: trip.id, status: payment.status, trip: serializeTrip(trip) };
      if (trip.customerId) io.to(`user:${trip.customerId}`).emit('payment:updated', payload);
      if (trip.driverId) io.to(`user:${trip.driverId}`).emit('payment:updated', { tripId: trip.id, status: payment.status });
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
  // Include customer name for the driver view (kept minimal).
  if (trip.customerId) {
    const c = repo.getUserById(trip.customerId);
    trip.customerName = c ? c.name : null;
    trip.customerPhone = c ? c.phone : null;
  }
  return trip;
}

module.exports = { initSocket };
