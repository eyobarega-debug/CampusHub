const express = require("express");
const multer = require("multer");
const { requireAuth } = require("../../middleware/auth");
const { asyncHandler, badRequest } = require("../../utils/errors");
const { createTempUpload, processUpload, removeTempFile, UPLOAD_PROFILES } = require("../../services/fileUpload");

const router = express.Router();

const profile = UPLOAD_PROFILES.publicImage;
const upload = createTempUpload({ maxBytes: profile.maxBytes });

router.post(
  "/",
  requireAuth(),
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest("No file uploaded (expected multipart field 'file')");
    try {
      const result = await processUpload({
        tempPath: req.file.path,
        destDir: profile.destDir,
        allowedTypes: profile.allowedTypes,
        maxBytes: profile.maxBytes,
      });
      res.status(201).json({ url: `/uploads/${result.filename}` });
    } catch (err) {
      if (err.uploadError) throw badRequest(err.message);
      throw err;
    } finally {
      await removeTempFile(req.file.path);
    }
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
