const { Router } = require('express');
const { authRequired } = require('../middleware');
const uploadsService = require('../services/uploads');

// Access-controlled delivery of stored driver documents. Only the driver the
// document belongs to, or an admin, may view them.
const router = Router();

router.get('/uploads/:filename', authRequired(), (req, res) => {
  const { filename } = req.params;
  const ownerId = uploadsService.ownerIdFromFilename(filename);
  const isOwner = req.user.role !== 'customer' && ownerId === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isAdmin) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (!uploadsService.readFile(filename, res)) return;
});

module.exports = router;