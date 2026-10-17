// Manual payment with proof.
//
// Flow: the student pays the seller's / organizer's own account outside the app,
// uploads a screenshot + the transaction reference (POST /:id/proof), and the
// payment moves to 'under_review'. The payee (or an admin) then approves it —
// which runs the normal finalizer, so the order / ticket / booking is confirmed
// exactly as after an online payment — or rejects it with a reason.
//
// Mounted at /api/payments BEFORE the generic payments router, because that one
// has a catch-all GET /:id.
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { z } = require("zod");
const db = require("../../db");
const { requireAuth } = require("../../middleware/auth");
const { validate } = require("../../middleware/validate");
const { asyncHandler, badRequest, conflict, notFound, forbidden } = require("../../utils/errors");
const { notify, audit } = require("../../utils/notify");
const paymentsService = require("../../services/payments");
const { RATES } = require("../../services/commissions");

const {
  createTempUpload,
  processUpload,
  removeTempFile,
  sendFileSafely,
  UPLOAD_PROFILES,
} = require("../../services/fileUpload");

const router = express.Router();

const PROOF_DIR = UPLOAD_PROFILES.paymentProof.destDir;
fs.mkdirSync(PROOF_DIR, { recursive: true });

const upload = createTempUpload({ maxBytes: UPLOAD_PROFILES.paymentProof.maxBytes });

function removeFile(name) {
  if (name) fs.unlink(path.join(PROOF_DIR, name), () => {});
}

async function loadManualPayment(id) {
  const { rows } = await db.query("SELECT * FROM payments WHERE id = $1 AND provider = 'manual'", [id]);
  return rows[0] || null;
}

function canView(user, payment) {
  if ([payment.payer_id, payment.payee_id].includes(user.id)) return true;
  if (user.role === "super_admin") return true;
  return user.role === "admin" && payment.university_id === user.university_id;
}
function canReview(user, payment) {
  if (!canView(user, payment)) return false;
  if (payment.payer_id === user.id) return false;

  // EVENT TICKETS: ONLY an authorized CampusHub admin can approve or reject!
  // Students cannot approve, organizers cannot approve, merchants cannot approve.
  if (payment.transaction_type === "ticket") {
    if (user.role === "super_admin") return true;
    return user.role === "admin" && payment.university_id === user.university_id;
  }

  // MATERIAL SALES (orders): Merchant confirms payment receipt; admins can also investigate/resolve
  if (payment.transaction_type === "order") {
    if (user.id === payment.payee_id) return true;
    if (user.role === "super_admin") return true;
    return user.role === "admin" && payment.university_id === user.university_id;
  }

  // RENTALS (bookings): Item owner confirms payment receipt; admins can investigate/resolve
  if (payment.transaction_type === "booking") {
    if (user.id === payment.payee_id) return true;
    if (user.role === "super_admin") return true;
    return user.role === "admin" && payment.university_id === user.university_id;
  }

  // Other (P2P): Seller confirms payment receipt
  if (user.id === payment.payee_id) return true;
  if (user.role === "super_admin") return true;
  return user.role === "admin" && payment.university_id === user.university_id;
}

function publicPayment(p) {
  return {
    id: p.id,
    transactionType: p.transaction_type,
    transactionId: p.transaction_id,
    description: p.description,
    amount: Number(p.amount),
    status: p.status,
    expiresAt: p.expires_at,
    proofAttempts: p.proof_attempts,
    maxAttempts: paymentsService.MANUAL_MAX_ATTEMPTS,
    payerId: p.payer_id,
    payeeId: p.payee_id,
    createdAt: p.created_at,
    confirmedAt: p.confirmed_at,
  };
}

// --- Lists -------------------------------------------------------------------

const listQuery = z.object({
  status: z.enum(["pending", "under_review", "confirmed", "failed", "all"]).default("under_review"),
});

const LIST_SQL = `
  SELECT p.*, payer.name AS payer_name, payee.name AS payee_name,
         pr.id AS proof_id, pr.reference_number, pr.status AS proof_status,
         pr.reject_reason, pr.created_at AS proof_submitted_at
    FROM payments p
    JOIN users payer ON payer.id = p.payer_id
    JOIN users payee ON payee.id = p.payee_id
    LEFT JOIN LATERAL (
      SELECT * FROM payment_proofs WHERE payment_id = p.id ORDER BY created_at DESC LIMIT 1
    ) pr ON true`;

function rowOut(r) {
  return {
    ...publicPayment(r),
        commissionRate: RATES[r.transaction_type] ?? null,
    payerName: r.payer_name,
    payeeName: r.payee_name,
    proof: r.proof_id
      ? { id: r.proof_id, referenceNumber: r.reference_number, status: r.proof_status, rejectReason: r.reject_reason, submittedAt: r.proof_submitted_at }
      : null,
  };
}

// Payments waiting on / handled by me as the seller or organizer (admins: their university).
router.get(
  "/manual/incoming",
  requireAuth(),
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const params = [];
    const where = ["p.provider = 'manual'"];
    if (req.user.role === "super_admin") {
      // platform-wide
    } else if (req.user.role === "admin") {
      params.push(req.user.university_id);
      where.push(`p.university_id = $${params.length}`);
    } else {
      params.push(req.user.id);
      where.push(`p.payee_id = $${params.length}`);
    }
    if (req.query.status !== "all") {
      params.push(req.query.status);
      where.push(`p.status = $${params.length}`);
    }
    const { rows } = await db.query(`${LIST_SQL} WHERE ${where.join(" AND ")} ORDER BY p.created_at DESC LIMIT 100`, params);
    res.json({ payments: rows.map(rowOut) });
  })
);

// Payments I made (so a student can resume one they left half-way).
router.get(
  "/manual/mine",
  requireAuth(),
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const params = [req.user.id];
    const where = ["p.provider = 'manual'", "p.payer_id = $1"];
    if (req.query.status !== "all") {
      params.push(req.query.status);
      where.push(`p.status = $${params.length}`);
    }
    const { rows } = await db.query(`${LIST_SQL} WHERE ${where.join(" AND ")} ORDER BY p.created_at DESC LIMIT 100`, params);
    res.json({ payments: rows.map(rowOut) });
  })
);

// --- One payment -------------------------------------------------------------

router.get(
  "/:id/manual",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const payment = await loadManualPayment(req.params.id);
    if (!payment || !canView(req.user, payment)) throw notFound("Payment not found");
    const { rows: proofs } = await db.query(
      `SELECT id, reference_number, status, reject_reason, reviewed_at, created_at
         FROM payment_proofs WHERE payment_id = $1 ORDER BY created_at DESC`,
      [payment.id]
    );
    const { rows: names } = await db.query("SELECT id, name FROM users WHERE id = ANY($1)", [[payment.payer_id, payment.payee_id]]);
    const nameOf = (id) => names.find((n) => n.id === id)?.name;
    res.json({
      payment: publicPayment(payment),
      payerName: nameOf(payment.payer_id),
      payeeName: nameOf(payment.payee_id),
      // The account details are only ever shown to the payer, the payee and admins.
      payeeAccounts: (payment.payee_accounts || []).map((a) => ({
        id: a.id, method: a.method, accountName: a.account_name, accountNumber: a.account_number,
        instructions: a.instructions, isDefault: a.is_default,
      })),
      proofs: proofs.map((p) => ({
        id: p.id, referenceNumber: p.reference_number, status: p.status, rejectReason: p.reject_reason,
        reviewedAt: p.reviewed_at, submittedAt: p.created_at,
      })),
      viewerRole: req.user.id === payment.payee_id ? "payee" : req.user.id === payment.payer_id ? "payer" : "admin",
    });
  })
);

// Screenshots show bank details, so they are never served statically: only the
// payer, the payee and admins can fetch them, through this authenticated route.
router.get(
  "/:id/proof/image",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const payment = await loadManualPayment(req.params.id);
    if (!payment || !canView(req.user, payment)) throw notFound("Payment not found");
    const { rows } = await db.query(
      "SELECT file_name FROM payment_proofs WHERE payment_id = $1 ORDER BY created_at DESC LIMIT 1",
      [payment.id]
    );
    if (!rows[0]) throw notFound("No proof has been uploaded for this payment");
    if (!sendFileSafely(res, PROOF_DIR, rows[0].file_name)) throw notFound("Proof image is no longer available");
  })
);

// --- Student: submit proof ---------------------------------------------------

const proofBody = z.object({ referenceNumber: z.string().trim().min(4, "Enter the transaction reference from your receipt").max(60) });

router.post(
  "/:id/proof",
  requireAuth(),
  upload.single("screenshot"),
  asyncHandler(async (req, res) => {
    let proofResult = null;
    try {
      if (!req.file) throw badRequest("Attach a screenshot of your payment (field 'screenshot')");
      const parsed = proofBody.safeParse(req.body);
      if (!parsed.success) throw badRequest(parsed.error.issues.map((i) => i.message).join("; "), "VALIDATION_ERROR");
      const { referenceNumber } = parsed.data;

      try {
        proofResult = await processUpload({
          tempPath: req.file.path,
          destDir: PROOF_DIR,
          allowedTypes: UPLOAD_PROFILES.paymentProof.allowedTypes,
          maxBytes: UPLOAD_PROFILES.paymentProof.maxBytes,
        });
      } catch (uploadErr) {
        if (uploadErr.uploadError) throw badRequest(uploadErr.message);
        throw uploadErr;
      }

      const sha = crypto.createHash("sha256").update(fs.readFileSync(path.join(PROOF_DIR, proofResult.filename))).digest("hex");

      const payment = await db.withTransaction(async (client) => {
        const { rows } = await client.query("SELECT * FROM payments WHERE id = $1 AND provider = 'manual' FOR UPDATE", [req.params.id]);
        const p = rows[0];
        if (!p) throw notFound("Payment not found");
        const isPayer = p.payer_id === req.user.id;
        const isPayee = p.payee_id === req.user.id;
        const isAdminUser = ["admin", "super_admin"].includes(req.user.role) && (req.user.role === "super_admin" || p.university_id === req.user.university_id);
        if (!isPayer && !isPayee && !isAdminUser) throw forbidden("Not authorized to submit proof for this payment");
        if (p.status === "under_review" && isPayer) throw conflict("Your proof is already waiting for approval", "ALREADY_UNDER_REVIEW");
        if (p.status !== "pending" && p.status !== "under_review") throw conflict(`This payment is already ${p.status}`, "PAYMENT_NOT_PENDING");
        if (new Date(p.expires_at) < new Date() && isPayer) {
          throw conflict("The payment window has expired. Please place the order again.", "PAYMENT_EXPIRED");
        }
        if (p.proof_attempts >= paymentsService.MANUAL_MAX_ATTEMPTS && isPayer) {
          throw conflict("Too many rejected proofs for this payment.", "TOO_MANY_ATTEMPTS");
        }

        await client.query(
          `INSERT INTO payment_proofs (university_id, payment_id, payer_id, payee_id, file_name, image_sha256, reference_number)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [p.university_id, p.id, p.payer_id, p.payee_id, proofResult.filename, sha, referenceNumber]
        );
        const upd = await client.query(
          "UPDATE payments SET status = 'under_review', proof_attempts = proof_attempts + 1 WHERE id = $1 RETURNING *",
          [p.id]
        );
        return upd.rows[0];
      });

      await audit(req.user.id, "payment.proof_submitted", payment.transaction_type, payment.transaction_id, {
        paymentId: payment.id, referenceNumber,
      });

      if (payment.transaction_type === "ticket") {
        const { rows: admins } = await db.query(
          "SELECT id FROM users WHERE role = 'admin' AND university_id = $1",
          [payment.university_id]
        );
        for (const admin of admins) {
          await notify(
            admin.id,
            "payment_update",
            "Event ticket payment to review",
            `${req.user.name} submitted payment proof for ${payment.description || "event ticket"}. Check receiving account and approve or reject.`
          );
        }
      } else {
        await notify(
          payment.payee_id,
          "payment_update",
          "Payment proof to review",
          `${req.user.name} says they paid ${Number(payment.amount).toFixed(2)} birr for ${payment.description || "an order"}. Check your account, then approve or reject.`
        );
      }
      res.status(201).json({ payment: publicPayment(payment) });
    } catch (err) {
      if (proofResult?.filename) removeFile(proofResult.filename);
      if (err && err.code === "23505") {
        const reusedImage = String(err.constraint || "").includes("hash");
        return res.status(409).json({
          error: {
            code: reusedImage ? "PROOF_REUSED" : "REFERENCE_REUSED",
            message: reusedImage
              ? "This screenshot was already submitted for another payment."
              : "This transaction reference was already used for another payment to this seller.",
          },
        });
      }
      throw err;
    } finally {
      await removeTempFile(req.file?.path);
    }
  })
);

// --- Student: give up while still unpaid -------------------------------------
// Only before a proof is submitted: once it is under review the buyer may already have paid,
// so the seller decides (reject + cancel) rather than the buyer walking away.
router.post(
  "/:id/cancel",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const payment = await loadManualPayment(req.params.id);
    if (!payment || payment.payer_id !== req.user.id) throw notFound("Payment not found");
    if (payment.status !== "pending") {
      throw conflict("Only a payment that is still waiting for your proof can be cancelled", "NOT_CANCELLABLE");
    }
    // Releases the stock / seat / dates through the same finalizer an expired payment uses.
    await paymentsService.handleProviderCallback(payment.id, "fail");
    await audit(req.user.id, "payment.manual_cancelled", payment.transaction_type, payment.transaction_id, { paymentId: payment.id });
    res.json({ payment: { id: payment.id, status: "failed" } });
  })
);

// --- Payee / admin: decide ---------------------------------------------------

async function loadForReview(req) {
  const payment = await loadManualPayment(req.params.id);
  if (!payment) throw notFound("Payment not found");

  if (payment.transaction_type === "ticket" && !["admin", "super_admin"].includes(req.user.role)) {
    throw forbidden("Only an authorized CampusHub administrator can approve or reject event ticket payments");
  }

  if (!canReview(req.user, payment)) throw forbidden("You are not authorized to review this payment");

  if (payment.status !== "under_review") {
    throw conflict(`This payment is ${payment.status}, there is nothing to review`, "NOT_UNDER_REVIEW");
  }
  return payment;
}

router.post(
  "/:id/approve",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const payment = await loadForReview(req);
    const result = await paymentsService.handleProviderCallback(payment.id, "success", async (client) => {
      await client.query(
        `UPDATE payment_proofs SET status = 'approved', reviewer_id = $2, reviewed_at = now()
          WHERE id = (SELECT id FROM payment_proofs WHERE payment_id = $1 AND status = 'submitted' ORDER BY created_at DESC LIMIT 1)`,
        [payment.id, req.user.id]
      );
    });
    if (result.notOpen) {
      throw conflict("The buyer cancelled this order/ticket, so the payment can no longer be approved", "NOT_OPEN");
    }
    await audit(req.user.id, "payment.manual_approved", payment.transaction_type, payment.transaction_id, {
      paymentId: payment.id, amount: Number(payment.amount), byPayee: req.user.id === payment.payee_id,
    });
    res.json({ payment: { id: result.id, status: result.status } });
  })
);

router.post(
  "/:id/reject",
  requireAuth(),
  validate({
    body: z.object({
      reason: z.string().trim().min(3, "Tell the student why (e.g. amount doesn't match)").max(300),
      // true = cancel the whole purchase and release the stock / seat; default lets the student re-upload.
      cancelPayment: z.boolean().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const payment = await loadForReview(req);
    const { reason } = req.body;
    const cancel = req.body.cancelPayment === true || payment.proof_attempts >= paymentsService.MANUAL_MAX_ATTEMPTS;

    const markProof = async (client) => {
      await client.query(
        `UPDATE payment_proofs SET status = 'rejected', reject_reason = $2, reviewer_id = $3, reviewed_at = now()
          WHERE id = (SELECT id FROM payment_proofs WHERE payment_id = $1 AND status = 'submitted' ORDER BY created_at DESC LIMIT 1)`,
        [payment.id, reason, req.user.id]
      );
    };

    let status;
    if (cancel) {
      await paymentsService.handleProviderCallback(payment.id, "fail", markProof); // finalizer releases the hold
      status = "failed";
    } else {
      await db.withTransaction(async (client) => {
        await markProof(client);
        // Back to 'pending' with a fresh window so the student can fix and resubmit.
        await client.query(
          "UPDATE payments SET status = 'pending', expires_at = now() + ($2 || ' hours')::interval WHERE id = $1",
          [payment.id, String(paymentsService.MANUAL_WINDOW_HOURS)]
        );
      });
      status = "pending";
    }

    await audit(req.user.id, "payment.manual_rejected", payment.transaction_type, payment.transaction_id, {
      paymentId: payment.id, reason, cancelled: cancel,
    });
    await notify(
      payment.payer_id,
      "payment_update",
      cancel ? "Payment rejected" : "Payment proof rejected",
      cancel
        ? `${payment.description || "Your purchase"} was cancelled: ${reason}`
        : `${reason}. You can upload a corrected screenshot before the payment window closes.`
    );
    res.json({ payment: { id: payment.id, status } });
  })
);

// Multer errors (file too large) -> readable 400.
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({ error: { code: "FILE_TOO_LARGE", message: "Screenshot must be under 5MB" } });
  }
  next(err);
});

module.exports = router;