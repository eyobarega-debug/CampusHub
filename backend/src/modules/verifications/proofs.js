const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const { badRequest } = require("../../utils/errors");

// Verification documents are sensitive (national IDs / student cards), so they
// live under private_uploads/ which is NOT statically served — access only
// happens through the authenticated per-request endpoints (same pattern and
// directory as manual payment proofs).
const PROOFS_DIR = path.join(__dirname, "..", "..", "..", "private_uploads", "proofs");
fs.mkdirSync(PROOFS_DIR, { recursive: true });

const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
]);
const MAX_BYTES = 10 * 1024 * 1024; // 10MB

const upload = multer({
  storage: multer.diskStorage({
    destination: PROOFS_DIR,
    // Never trust the client filename: server-generated random name only.
    filename: (req, file, cb) =>
      cb(null, `${crypto.randomBytes(16).toString("hex")}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: MAX_BYTES },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_TYPES.has(file.mimetype)) {
      return cb(badRequest("Only images (JPEG, PNG, WEBP, GIF) or PDF files are allowed"));
    }
    cb(null, true);
  },
});

const CONTENT_TYPES = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

// Stream a stored document to the caller. documentUrl is server-generated;
// path.basename() guards against path traversal even if the stored value were
// ever tampered with. Returns false when the file no longer exists so the
// caller can respond 404.
function sendDocument(res, documentUrl) {
  const file = path.join(PROOFS_DIR, path.basename(documentUrl || ""));
  if (!documentUrl || !fs.existsSync(file)) return false;
  res.setHeader("Content-Type", CONTENT_TYPES[path.extname(file).toLowerCase()] || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="document${path.extname(file)}"`);
  res.setHeader("Cache-Control", "private, no-store");
  fs.createReadStream(file).pipe(res);
  return true;
}

module.exports = { upload, sendDocument, PROOFS_DIR };
