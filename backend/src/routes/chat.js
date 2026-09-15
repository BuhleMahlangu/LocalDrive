const { Router } = require('express');
const repo = require('../db/repository');
const { authRequired } = require('../middleware');

// In-trip chat between the two participants (customer <-> driver). Routes live
// under /api/chat so either side can use them with their own auth token; every
// call verifies the caller is actually a participant in the trip.
function chatRoutes({ notify }) {
  const router = Router();
  router.use(authRequired());

  function loadTripOr403(tripId, user) {
    const trip = repo.getTripById(tripId);
    if (!trip) {
      const err = new Error('Trip not found');
      err.status = 404;
      throw err;
    }
    if (user.id !== trip.customerId && user.id !== trip.driverId) {
      const err = new Error('You are not a participant in this trip');
      err.status = 403;
      throw err;
    }
    return trip;
  }

  router.get('/trips/:tripId/messages', (req, res, next) => {
    try {
      const trip = loadTripOr403(req.params.tripId, req.user);
      // Opening the thread marks incoming messages as read for the reader, and
      // tells the sender their messages were seen.
      if (repo.hasUnreadMessages(trip.id, req.user.id)) {
        repo.markTripMessagesRead(trip.id, req.user.id);
        notify.chatRead(trip, req.user.id);
      }
      const messages = repo.getTripMessages(trip.id);
      res.json({ messages });
    } catch (e) { next(e); }
  });

  router.post('/trips/:tripId/messages', (req, res, next) => {
    try {
      const trip = loadTripOr403(req.params.tripId, req.user);
      const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
      if (!body) {
        return res.status(400).json({ error: 'Message body is required' });
      }
      if (body.length > 2000) {
        return res.status(400).json({ error: 'Message is too long (max 2000 characters)' });
      }
      const message = repo.createTripMessage({ tripId: trip.id, senderId: req.user.id, body });
      notify.chatMessage(message, trip);
      res.status(201).json({ message });
    } catch (e) { next(e); }
  });

  router.post('/trips/:tripId/read', (req, res, next) => {
    try {
      const trip = loadTripOr403(req.params.tripId, req.user);
      const messages = repo.markTripMessagesRead(trip.id, req.user.id);
      notify.chatRead(trip, req.user.id);
      res.json({ ok: true, messages });
    } catch (e) { next(e); }
  });

  return router;
}

module.exports = chatRoutes;