const express = require("express");
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");
const { requireAuth } = require("../../middleware/auth");
const { asyncHandler, badRequest } = require("../../utils/errors");

const router = express.Router();

const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_BYTES = 5 * 1024 * 1024; // 5MB

const storage = multer.diskStorage({
  destination: path.join(__dirname, "..", "..", "..", "uploads"),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${crypto.randomBytes(16).toString("hex")}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_BYTES },
  fileFilter: (req, file, cb) => {
    // SRS Section 15 "Secure File / Image Uploads": validate type before
    // accepting, and store outside the app's own served-code directory
    // (uploads/ is only reachable via the explicit static route in app.js,
    // not part of the source tree Express would otherwise serve).
    if (!ALLOWED_TYPES.has(file.mimetype)) return cb(badRequest("Only JPEG, PNG, WEBP, or GIF images are allowed"));
    cb(null, true);
  },
});

router.post(
  "/",
  requireAuth(),
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest("No file uploaded (expected multipart field 'file')");
    res.status(201).json({ url: `/uploads/${req.file.filename}` });
  })
);

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({ error: { code: "FILE_TOO_LARGE", message: "Image must be under 5MB" } });
  }
  next(err);
});

module.exports = router;
