const { Router } = require('express');
const repo = require('../db/repository');

// Public, unauthenticated endpoint for the "share my trip" tracker link.
// The share URL contains a random trip id (unguessable) that the customer
// chooses to share, so this intentionally leaks no personal data: no customer
// name, no phone numbers, and driver live-location only surfaces while the
// trip is active.
function publicRoutes() {
  const router = Router();

  router.get('/trips/:id/live', (req, res) => {
    const trip = repo.getTripById(req.params.id);
    if (!trip) return res.status(404).json({ error: 'Trip not found' });

    const driver = trip.driverId ? repo.getUserById(trip.driverId) : null;
    const visibleStatus = ['requested', 'accepted', 'ongoing', 'completed'].includes(trip.status)
      ? trip.status
      : 'cancelled';

    const driverLoc = (visibleStatus === 'accepted' || visibleStatus === 'ongoing') && trip.driverId
      ? repo.getDriverLocation(trip.driverId)
      : null;

    res.json({
      id: trip.id,
      status: visibleStatus,
      pickup: trip.pickup,
      destination: trip.destination,
      distanceKm: trip.distanceKm,
      fareEstimate: trip.fareEstimate,
      finalFare: visibleStatus === 'completed' ? trip.finalFare : null,
      driver: driver ? {
        name: driver.name,
        vehicleType: driver.vehicleType,
        licensePlate: driver.licensePlate,
      } : null,
      driverLoc: driverLoc ? { lat: driverLoc.lat, lng: driverLoc.lng } : null,
      polyline: trip.routePolyline || null,
      updatedAt: new Date().toISOString(),
    });
  });

  return router;
}

module.exports = publicRoutes;