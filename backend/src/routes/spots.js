const { Router } = require('express');
const repo = require('../db/repository');

// Public list of preset pickup spots for the service area (no auth needed).
function spotsRoutes() {
  const router = Router();
  router.get('/', (_req, res) => {
    res.json({ spots: repo.listPickupSpots() });
  });
  return router;
}

module.exports = spotsRoutes;