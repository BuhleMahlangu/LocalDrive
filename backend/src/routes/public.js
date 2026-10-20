const { Router } = require('express');
const repo = require('../db/repository');
const config = require('../config');

// Which channel a login code will be delivered on, so the client can ask for an
// email address up front when email is the only path (and never promise an SMS
// that isn't configured). Mirrors services/auth.js delivery selection.
function otpDeliveryChannel() {
  const canSms = config.sms.provider === 'whatsapp'
    ? !!(config.sms.whatsappToken && config.sms.whatsappPhoneNumberId)
    : config.sms.provider === 'africastalking'
      ? !!(config.sms.atApiKey && config.sms.atUsername)
      : config.sms.provider === 'twilio'
        ? !!(config.sms.twilioAccountSid && config.sms.twilioAuthToken && config.sms.twilioFrom)
        : config.sms.provider === 'clicksend'
          ? !!(config.sms.clicksendUser && config.sms.clicksendApiKey)
          : false;
  if (canSms) return 'sms';
  if (config.smtp.host && config.smtp.user && config.smtp.pass) return 'email';
  return 'console';
}

// Public, unauthenticated endpoint for the "share my trip" tracker link.
// The share URL contains a random trip id (unguessable) that the customer
// chooses to share, so this intentionally leaks no personal data: no customer
// name, no phone numbers, and driver live-location only surfaces while the
// trip is active.
function publicRoutes() {
  const router = Router();

  // Public app config the client needs before/without signing in — currently the
  // town/service area so the map opens in the right place, plus the OTP delivery
  // channel so the login screen knows whether an email address is needed.
  // Contains no secrets.
  router.get('/config', (_req, res) => {
    res.json({
      serviceArea: repo.getServiceArea(),
      otpDelivery: otpDeliveryChannel(),
    });
  });

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
      driverLoc: driverLoc
        ? { lat: driverLoc.lat, lng: driverLoc.lng, heading: driverLoc.heading ?? null }
        : null,
      polyline: trip.routePolyline || null,
      updatedAt: new Date().toISOString(),
    });
  });

  return router;
}

module.exports = publicRoutes;