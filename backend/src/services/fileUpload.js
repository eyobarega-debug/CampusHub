/**
 * Secure file upload service.
 *
 * Why sharp?  We need to validate that uploaded images are actually valid
 * raster images (not HTML/SVG/scripts disguised with an image extension or
 * MIME type).  The only reliable way is to decode the pixel data and
 * re-encode it.  sharp (libvips) is the standard Node library for this:
 * it strips EXIF/metadata, rejects malformed files, and outputs a clean
 * image — all without trusting any client-supplied header.
 *
 * Design:
 *   - Files are first written to a temp directory by multer (memoryStorage
 *     would blow up on a 10 MB PDF).
 *   - processUpload() reads the raw bytes, detects the real type via magic
 *     bytes, validates it against the caller's allow-list, re-encodes images
 *     through sharp, and writes the result with a random server-generated
 *     filename to the final destination.
 *   - The original temp file is always deleted afterwards.
 *   - The caller never sees the original filename or extension.
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");

// ─── Magic-byte signatures ──────────────────────────────────────────────────

const SIGNATURES = [
  { type: "image/jpeg",       ext: ".jpg",  bytes: [0xFF, 0xD8, 0xFF] },
  { type: "image/png",        ext: ".png",  bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
  { type: "image/webp",       ext: ".webp", bytes: null, detect: (buf) => buf.length >= 12 && buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP" },
  { type: "image/gif",        ext: ".gif",  bytes: null, detect: (buf) => buf.length >= 6 && (buf.slice(0, 6).toString("ascii") === "GIF87a" || buf.slice(0, 6).toString("ascii") === "GIF89a") },
  { type: "application/pdf",  ext: ".pdf",  bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
];

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const DOCUMENT_TYPES = new Set(["application/pdf"]);

// Maximum image dimensions to prevent decompression bombs.
const MAX_IMAGE_DIMENSION = 8192;

// ─── Detect actual content type from file bytes ─────────────────────────────

function detectType(buffer) {
  for (const sig of SIGNATURES) {
    if (sig.detect) {
      if (sig.detect(buffer)) return { type: sig.type, ext: sig.ext };
    } else if (sig.bytes) {
      if (buffer.length >= sig.bytes.length && sig.bytes.every((b, i) => buffer[i] === b)) {
        return { type: sig.type, ext: sig.ext };
      }
    }
  }
  return null;
}

// ─── Safe content-type map (for serving) ────────────────────────────────────

const SAFE_CONTENT_TYPES = {
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png":  "image/png",
  ".webp": "image/webp",
  ".gif":  "image/gif",
  ".pdf":  "application/pdf",
};

function safeContentType(ext) {
  return SAFE_CONTENT_TYPES[ext] || "application/octet-stream";
}

// ─── Random filename ────────────────────────────────────────────────────────

function randomFilename(ext) {
  return `${crypto.randomBytes(20).toString("hex")}${ext}`;
}

// ─── Process an uploaded file ───────────────────────────────────────────────

/**
 * Validate and process an uploaded file.
 *
 * @param {object} opts
 * @param {string}   opts.tempPath        - Path to the multer temp file.
 * @param {string}   opts.destDir         - Final destination directory.
 * @param {Set}      opts.allowedTypes    - Set of MIME types to accept.
 * @param {number}   [opts.maxBytes]      - Maximum file size (checked after read).
 * @param {number}   [opts.maxDimension]  - Max width/height for images.
 * @param {boolean}  [opts.reencodeImages] - Re-encode raster images through sharp (default true).
 * @returns {Promise<{ filename, contentType, ext, size }>}
 */
async function processUpload({
  tempPath,
  destDir,
  allowedTypes,
  maxBytes,
  maxDimension = MAX_IMAGE_DIMENSION,
  reencodeImages = true,
}) {
  let buffer;
  try {
    buffer = await fsp.readFile(tempPath);
  } catch (err) {
    throw Object.assign(new Error("Upload file could not be read"), { uploadError: true, httpStatus: 400 });
  }

  // Size check (defense in depth — multer limits should catch this first).
  if (maxBytes && buffer.length > maxBytes) {
    throw Object.assign(new Error(`File exceeds the ${Math.round(maxBytes / 1024 / 1024)}MB limit`), { uploadError: true, httpStatus: 400 });
  }

  // Detect actual type from magic bytes.
  const detected = detectType(buffer);
  if (!detected) {
    throw Object.assign(new Error("Unsupported file type — the file content does not match any allowed format"), { uploadError: true, httpStatus: 400 });
  }
  if (!allowedTypes.has(detected.type)) {
    throw Object.assign(new Error(`File type '${detected.type}' is not allowed for this upload`), { uploadError: true, httpStatus: 400 });
  }

  let finalBuffer = buffer;
  let finalExt = detected.ext;
  let finalType = detected.type;

  // Re-encode images through sharp to strip metadata and validate structure.
  if (IMAGE_TYPES.has(detected.type) && reencodeImages) {
    try {
      const image = sharp(buffer);
      const metadata = await image.metadata();

      // Dimension check.
      if (metadata.width > maxDimension || metadata.height > maxDimension) {
        throw Object.assign(
          new Error(`Image dimensions ${metadata.width}×${metadata.height} exceed the ${maxDimension}×${maxDimension} limit`),
          { uploadError: true, httpStatus: 400 }
        );
      }

      // Re-encode to the same format, stripping all metadata.
      // GIFs are converted to PNG (sharp's GIF output may lose animation;
      // for profile pictures / proofs this is acceptable and much safer).
      let pipeline = image.rotate(); // auto-rotate based on EXIF before stripping

      if (detected.type === "image/jpeg") {
        pipeline = pipeline.jpeg({ quality: 90, mozjpeg: true });
        finalExt = ".jpg";
        finalType = "image/jpeg";
      } else if (detected.type === "image/png") {
        pipeline = pipeline.png({ compressionLevel: 6 });
        finalExt = ".png";
        finalType = "image/png";
      } else if (detected.type === "image/webp") {
        pipeline = pipeline.webp({ quality: 90 });
        finalExt = ".webp";
        finalType = "image/webp";
      } else if (detected.type === "image/gif") {
        // Convert GIF to PNG for safety (strips animation + any embedded scripts).
        pipeline = pipeline.png({ compressionLevel: 6 });
        finalExt = ".png";
        finalType = "image/png";
      }

      finalBuffer = await pipeline.toBuffer();
    } catch (err) {
      if (err.uploadError) throw err;
      // sharp couldn't decode it — it's not a valid image.
      throw Object.assign(
        new Error("The uploaded file appears to be corrupted or is not a valid image"),
        { uploadError: true, httpStatus: 400 }
      );
    }
  }

  // For PDFs: the magic-byte check already confirmed it starts with %PDF.
  // We do NOT convert PDFs to images — they are legitimate document uploads.
  // PDFs are stored as-is and served with Content-Disposition + nosniff headers.

  // Generate random filename and write to destination.
  const filename = randomFilename(finalExt);
  const destPath = path.join(destDir, filename);
  await fsp.mkdir(destDir, { recursive: true });
  await fsp.writeFile(destPath, finalBuffer);

  return {
    filename,
    contentType: finalType,
    ext: finalExt,
    size: finalBuffer.length,
  };
}

// ─── Cleanup helper ─────────────────────────────────────────────────────────

async function removeTempFile(filePath) {
  if (!filePath) return;
  try { await fsp.unlink(filePath); } catch (_) { /* already gone */ }
}

// ─── Serve a private file safely ────────────────────────────────────────────

/**
 * Stream a file from a private directory with safe headers.
 * Returns false if the file does not exist.
 */
function sendFileSafely(res, baseDir, storedFilename) {
  if (!storedFilename) return false;
  // path.basename prevents path traversal even if the DB value is tampered.
  const safeName = path.basename(storedFilename);
  const filePath = path.join(baseDir, safeName);
  if (!fs.existsSync(filePath)) return false;

  const ext = path.extname(safeName).toLowerCase();
  res.setHeader("Content-Type", safeContentType(ext));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", `inline; filename="file${ext}"`);
  res.setHeader("Cache-Control", "private, no-store");
  fs.createReadStream(filePath).pipe(res);
  return true;
}

// ─── Multer temp-file storage config ────────────────────────────────────────

const multer = require("multer");

const TEMP_DIR = path.join(__dirname, "..", "..", "uploads_temp");
fs.mkdirSync(TEMP_DIR, { recursive: true });

const tempStorage = multer.diskStorage({
  destination: TEMP_DIR,
  filename: (_req, _file, cb) => cb(null, `tmp_${crypto.randomBytes(16).toString("hex")}`),
});

/**
 * Create a multer instance that writes to a temp directory.
 * The real validation + rename happens in processUpload().
 */
function createTempUpload({ maxBytes }) {
  return multer({
    storage: tempStorage,
    limits: { fileSize: maxBytes },
  });
}

// ─── Pre-configured upload profiles ─────────────────────────────────────────

const UPLOAD_PROFILES = {
  // Profile pictures, product images, general images
  publicImage: {
    allowedTypes: new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]),
    maxBytes: 5 * 1024 * 1024,
    destDir: path.join(__dirname, "..", "..", "uploads"),
    reencodeImages: true,
  },
  // Verification documents (student ID, enrollment proof)
  verificationDocument: {
    allowedTypes: new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"]),
    maxBytes: 10 * 1024 * 1024,
    destDir: path.join(__dirname, "..", "..", "private_uploads", "proofs"),
    reencodeImages: true,
  },
  // Payment proof screenshots
  paymentProof: {
    allowedTypes: new Set(["image/jpeg", "image/png", "image/webp"]),
    maxBytes: 5 * 1024 * 1024,
    destDir: path.join(__dirname, "..", "..", "private_uploads", "proofs"),
    reencodeImages: true,
  },
};

module.exports = {
  detectType,
  processUpload,
  removeTempFile,
  sendFileSafely,
  createTempUpload,
  safeContentType,
  UPLOAD_PROFILES,
  IMAGE_TYPES,
  DOCUMENT_TYPES,
  TEMP_DIR,
};
