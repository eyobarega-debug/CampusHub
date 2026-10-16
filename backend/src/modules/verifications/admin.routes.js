const express = require("express");
const { z } = require("zod");

const db = require("../../db");
const { requireAuth, requireRole } = require("../../middleware/auth");
const { validate } = require("../../middleware/validate");
const { asyncHandler, notFound, forbidden, conflict } = require("../../utils/errors");
const { notify, audit } = require("../../utils/notify");
const { assertSameTenant } = require("../../middleware/tenant");
const { sendDocument } = require("./proofs");

const router = express.Router();

// Only university admins / super admins ever reach these handlers.
router.use(requireAuth(), requireRole("admin", "super_admin"));

// An admin may never decide their own request (students can't reach this
// router at all — this closes the "admin reviews themself" gap).
function assertNotSelf(req, request) {
  if (request.user_id === req.user.id) {
    throw forbidden("You cannot review your own verification request");
  }
}

function requestOut(r) {
  return {
    id: r.id,
    userId: r.user_id,
    documentType: r.document_type,
    studentNote: r.student_note,
    status: r.status,
    rejectionReason: r.rejection_reason,
    adminReviewerId: r.admin_reviewer_id,
    createdAt: r.created_at,
    reviewedAt: r.reviewed_at,
    studentName: r.student_name,
    studentEmail: r.student_email,
    studentPhone: r.student_phone,
    universityName: r.university_name,
    reviewerName: r.reviewer_name || null,
    hasDocument: !!r.document_url,
  };
}

// Review queue. Default: this university's pending requests, oldest first
// (FIFO). `status=all` puts every pending request ahead of decided ones.
router.get(
  "/requests",
  asyncHandler(async (req, res) => {
    const status = req.query.status === "all" ? "all" : req.query.status || "pending";
    const q = typeof req.query.q === "string" && req.query.q.trim() ? req.query.q.trim() : null;
    const conditions = [];
    const params = [];

    if (status !== "all") {
      params.push(status);
      conditions.push(`vr.status = $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      conditions.push(`(u.name ILIKE $${params.length} OR u.email ILIKE $${params.length})`);
    }
    if (req.tenant && req.tenant.universityId) {
      params.push(req.tenant.universityId);
      conditions.push(`vr.university_id = $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const order =
      status === "all"
        ? "ORDER BY (vr.status = 'pending') DESC, vr.created_at DESC"
        : "ORDER BY vr.created_at ASC";
    params.push(200);

    const { rows } = await db.query(
      `SELECT vr.*, u.name AS student_name, u.email AS student_email, u.phone AS student_phone,
              univ.name AS university_name, reviewer.name AS reviewer_name
         FROM verification_requests vr
         JOIN users u ON u.id = vr.user_id
         JOIN universities univ ON univ.id = vr.university_id
         LEFT JOIN users reviewer ON reviewer.id = vr.admin_reviewer_id
        ${where} ${order} LIMIT $${params.length}`,
      params
    );
    res.json({ requests: rows.map(requestOut) });
  })
);

// One request's full detail (student info + review info).
router.get(
  "/requests/:id",
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT vr.*, u.name AS student_name, u.email AS student_email, u.phone AS student_phone,
              univ.name AS university_name, reviewer.name AS reviewer_name
         FROM verification_requests vr
         JOIN users u ON u.id = vr.user_id
         JOIN universities univ ON univ.id = vr.university_id
         LEFT JOIN users reviewer ON reviewer.id = vr.admin_reviewer_id
        WHERE vr.id = $1`,
      [req.params.id]
    );
    const request = rows[0];
    if (!request) throw notFound("Verification request not found");
    assertSameTenant(req, request.university_id, "Verification request");
    res.json({ request: requestOut(request) });
  })
);

// Secure document view: authenticated admin of the request's university only.
router.get(
  "/requests/:id/document",
  asyncHandler(async (req, res) => {
    const { rows } = await db.query("SELECT * FROM verification_requests WHERE id = $1", [req.params.id]);
    const request = rows[0];
    if (!request) throw notFound("Verification request not found");
    assertSameTenant(req, request.university_id, "Verification request");
    if (!sendDocument(res, request.document_url)) throw notFound("Document is no longer available");
  })
);

router.patch(
  "/requests/:id/approve",
  asyncHandler(async (req, res) => {
    const result = await db.withTransaction(async (client) => {
      const { rows } = await client.query("SELECT * FROM verification_requests WHERE id = $1 FOR UPDATE", [req.params.id]);
      const request = rows[0];
      if (!request) throw notFound("Verification request not found");
      assertSameTenant(req, request.university_id, "Verification request");
      assertNotSelf(req, request);
      if (request.status !== "pending") throw conflict("This verification request has already been decided");

      await client.query(
        "UPDATE verification_requests SET status = 'approved', admin_reviewer_id = $1, reviewed_at = now() WHERE id = $2",
        [req.user.id, request.id]
      );
      // Mark the account campus verified via the manual-document path and keep
      // the document reference on the user row (FR-002's manual fallback field).
      await client.query(
        "UPDATE users SET verified = true, verification_method = 'manual_document', student_id_doc_url = $1 WHERE id = $2 AND verified = false",
        [request.document_url, request.user_id]
      );

      await notify(
        request.user_id,
        "verification_approved",
        "Your campus account has been verified",
        "Your campus verification request has been approved."
      );
      await audit(req.user.id, "verification.approve", "verification_request", request.id, { userId: request.user_id });
      return { requestId: request.id, status: "approved" };
    });
    res.json(result);
  })
);

router.patch(
  "/requests/:id/reject",
  validate({ body: z.object({ rejectionReason: z.string().trim().min(2).max(1000) }) }),
  asyncHandler(async (req, res) => {
    const { rejectionReason } = req.body;
    const result = await db.withTransaction(async (client) => {
      const { rows } = await client.query("SELECT * FROM verification_requests WHERE id = $1 FOR UPDATE", [req.params.id]);
      const request = rows[0];
      if (!request) throw notFound("Verification request not found");
      assertSameTenant(req, request.university_id, "Verification request");
      assertNotSelf(req, request);
      if (request.status !== "pending") throw conflict("This verification request has already been decided");

      await client.query(
        "UPDATE verification_requests SET status = 'rejected', admin_reviewer_id = $1, rejection_reason = $2, reviewed_at = now() WHERE id = $3",
        [req.user.id, rejectionReason, request.id]
      );

      await notify(request.user_id, "verification_rejected", "Your campus verification request was rejected", rejectionReason);
      await audit(req.user.id, "verification.reject", "verification_request", request.id, {
        userId: request.user_id,
        rejectionReason,
      });
      return { requestId: request.id, status: "rejected", rejectionReason };
    });
    res.json(result);
  })
);

module.exports = router;
