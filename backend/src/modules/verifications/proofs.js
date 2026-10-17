const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { badRequest } = require("../../utils/errors");
const { createTempUpload, processUpload, removeTempFile, sendFileSafely, UPLOAD_PROFILES } = require("../../services/fileUpload");

// Verification documents are sensitive (national IDs / student cards), so they
// live under private_uploads/ which is NOT statically served — access only
// happens through the authenticated per-request endpoints (same pattern and
// directory as manual payment proofs).
const PROOFS_DIR = UPLOAD_PROFILES.verificationDocument.destDir;
fs.mkdirSync(PROOFS_DIR, { recursive: true });

const profile = UPLOAD_PROFILES.verificationDocument;
const upload = createTempUpload({ maxBytes: profile.maxBytes });

/**
 * Process an uploaded verification document (image or PDF).
 * Images are re-encoded through sharp; PDFs are validated by magic bytes.
 * Returns { filename } or throws on invalid content.
 */
async function processVerificationUpload(file) {
  try {
    return await processUpload({
      tempPath: file.path,
      destDir: profile.destDir,
      allowedTypes: profile.allowedTypes,
      maxBytes: profile.maxBytes,
    });
  } catch (err) {
    if (err.uploadError) throw badRequest(err.message);
    throw err;
  } finally {
    await removeTempFile(file.path);
  }
}

// Stream a stored document to the caller with safe headers.
// Returns false when the file no longer exists so the caller can respond 404.
function sendDocument(res, documentUrl) {
  if (!documentUrl) return false;
  // Extract just the filename from the stored path (e.g. "/private_uploads/proofs/abc.jpg" -> "abc.jpg")
  const storedName = path.basename(documentUrl);
  return sendFileSafely(res, PROOFS_DIR, storedName);
}

module.exports = { upload, processVerificationUpload, sendDocument, PROOFS_DIR };
