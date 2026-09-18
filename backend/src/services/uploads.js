const fs = require('fs');
const path = require('path');
const multer = require('multer');

// Driver vetting documents (ID copy, selfie, proof of residence) are stored on
// local disk, defaulting to backend/data/uploads. Filenames are prefixed with
// the driver id so file-level access control is trivial: only the owning driver
// or an admin may read them (see routes/uploads.js). Deployments that mount a
// persistent volume (e.g. the /data volume in the Dockerfile) can point
// UPLOADS_DIR there so uploads survive redeploys, mirroring how DB_FILE is
// redirected.
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'data', 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Accepted MIME types map to a safe extension (never trust the client filename).
const ALLOWED_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB per document

function sanitizeBase(driverId, field) {
  return String(driverId).replace(/[^a-zA-Z0-9_-]/g, '')
    + '_' + String(field).replace(/[^a-zA-Z0-9_-]/g, '');
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = ALLOWED_MIME[file.mimetype] || 'bin';
    cb(null, `${sanitizeBase(req.user.id, req.params.field || file.fieldname)}.${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE, files: 4 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME[file.mimetype]) return cb(null, true);
    const err = new Error('Only JPG, PNG, WEBP or PDF documents are allowed');
    err.status = 400;
    cb(err);
  },
});

// Serve a stored upload: caller must already have verified access.
function readFile(filename, res) {
  const safe = path.basename(filename).replace(/[^a-zA-Z0-9_.-]/g, '');
  const filePath = path.join(UPLOADS_DIR, safe);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: 'File not found' });
    return false;
  }
  res.sendFile(filePath);
  return true;
}

// The driver id embedded in a filename (used for access control), or null.
function ownerIdFromFilename(filename) {
  const m = String(filename).match(/^(u_[a-f0-9]+)_/);
  return m ? m[1] : null;
}

// Best-effort removal of a stored document (used when an applicant re-submits
// with a replacement file). Never throws; silently returns false if it's gone.
function deleteFile(filename) {
  const safe = path.basename(String(filename || '')).replace(/[^a-zA-Z0-9_.-]/g, '');
  if (!safe) return false;
  const filePath = path.join(UPLOADS_DIR, safe);
  try {
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

module.exports = { upload, UPLOADS_DIR, ALLOWED_MIME, readFile, ownerIdFromFilename, deleteFile };