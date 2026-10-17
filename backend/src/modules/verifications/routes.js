const express = require("express");
const { z } = require("zod");

const db = require("../../db");
const { requireAuth } = require("../../middleware/auth");
const { validate } = require("../../middleware/validate");
const { asyncHandler, badRequest, notFound, forbidden, conflict } = require("../../utils/errors");
const { notify, audit } = require("../../utils/notify");
const multer = require("multer");
const { upload, processVerificationUpload, sendDocument } = require("./proofs");

const router = express.Router();

const DOCUMENT_TYPES = ["student_id", "university_id_card", "proof_of_enrollment", "other"];

// Public shape of a verification request: metadata only, never the document
// path (the document is fetched separately through the authenticated
// /document endpoints).
function requestOut(r) {
  return {
    id: r.id,
    documentType: r.document_type,
    studentNote: r.student_note,
    status: r.status,
    rejectionReason: r.rejection_reason,
    createdAt: r.created_at,
    reviewedAt: r.reviewed_at,
    hasDocument: !!r.document_url,
  };
}

const submitSchema = z.object({
  documentType: z.enum(DOCUMENT_TYPES),
  studentNote: z.string().max(1000).optional(),
});

// FR-002 manual fallback — submit official proof of campus membership.
router.post(
  "/submit",
  requireAuth(),
  upload.single("document"),
  validate({ body: submitSchema }),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest("No document uploaded (expected multipart field 'document')");
    if (req.user.verified) {
      throw conflict("Your account is already campus verified", "ALREADY_VERIFIED");
    }
    if (!req.user.university_id) throw forbidden("Your account is not attached to a university");

    const processed = await processVerificationUpload(req.file);

    try {
      const { rows } = await db.query(
        `INSERT INTO verification_requests (user_id, university_id, document_type, document_url, student_note, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')
         RETURNING *`,
        [req.user.id, req.user.university_id, req.body.documentType, `/private_uploads/proofs/${processed.filename}`, req.body.studentNote || null]
      );

      await notify(
        req.user.id,
        "verification_submitted",
        "Your campus verification request has been submitted",
        "An administrator will review it shortly."
      );
      const admins = await db.query(
        "SELECT id FROM users WHERE role IN ('admin','super_admin') AND (role = 'super_admin' OR university_id = $1)",
        [req.user.university_id]
      );
      await Promise.all(
        admins.rows.map((a) =>
          notify(a.id, "verification_request", "New campus verification request", `${req.user.name} submitted a verification request.`)
        )
      );
      await audit(req.user.id, "verification.submit", "verification_request", rows[0].id, { documentType: req.body.documentType });

      res.status(201).json({ request: requestOut(rows[0]), message: "Your verification request is under review." });
    } catch (err) {
      // Clean up the uploaded file when the row could not be created
      // (e.g. a concurrent duplicate was caught by the unique index).
      if (processed?.filename) {
        require("fs").unlink(require("path").join(__dirname, "..", "..", "..", "private_uploads", "proofs", processed.filename), () => {});
      }
      if (err.code === "23505") throw conflict("You already have a pending verification request", "PENDING_EXISTS");
      throw err;
    }
  })
);

// Current campus-verification status for the signed-in user.
router.get(
  "/me/status",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const user = await db.query(
      "SELECT id, name, email, verified, verification_method FROM users WHERE id = $1",
      [req.user.id]
    );
    const pending = await db.query(
      "SELECT * FROM verification_requests WHERE user_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
      [req.user.id]
    );
    const latest = await db.query(
      `SELECT * FROM verification_requests WHERE user_id = $1 AND status IN ('approved','rejected')
       ORDER BY reviewed_at DESC NULLS LAST, created_at DESC LIMIT 1`,
      [req.user.id]
    );
    res.json({
      verified: user.rows[0].verified,
      verificationMethod: user.rows[0].verification_method,
      hasPending: pending.rows.length > 0,
      pendingRequest: pending.rows[0] ? requestOut(pending.rows[0]) : null,
      latestRequest: latest.rows[0] ? requestOut(latest.rows[0]) : null,
    });
  })
);

// Own request history (newest first).
router.get(
  "/me/requests",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      "SELECT * FROM verification_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20",
      [req.user.id]
    );
    res.json({ requests: rows.map(requestOut) });
  })
);

// The student's OWN document only — another student's request is a 404.
router.get(
  "/me/requests/:id/document",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query("SELECT * FROM verification_requests WHERE id = $1", [req.params.id]);
    const request = rows[0];
    if (!request || request.user_id !== req.user.id) throw notFound("Verification request not found");
    if (!sendDocument(res, request.document_url)) throw notFound("Document is no longer available");
  })
);

module.exports = router;
