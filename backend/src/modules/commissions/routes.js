// Commission ledger views.
//   Seller (student renting out, merchant, organizer): GET /mine — only their own sales and what they owe.
//   Admin: GET /admin/sellers — every seller listed individually, then drill into one seller's ledger
//          and mark it settled once the seller has paid the platform.
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const { z } = require("zod");
const db = require("../../db");
const { requireAuth } = require("../../middleware/auth");
const { validate } = require("../../middleware/validate");
const { asyncHandler, forbidden, notFound, conflict, badRequest } = require("../../utils/errors");
const { notify, audit } = require("../../utils/notify");
const { RATES } = require("../../services/commissions");
const {
  createTempUpload,
  processUpload,
  removeTempFile,
  sendFileSafely,
  UPLOAD_PROFILES,
} = require("../../services/fileUpload");

const upload = createTempUpload({ maxBytes: UPLOAD_PROFILES.paymentProof.maxBytes });

const router = express.Router();

const isAdmin = (u) => u.role === "admin" || u.role === "super_admin";
const requireAdmin = (req, res, next) => (isAdmin(req.user) ? next() : next(forbidden("Admins only")));

// University scoping: an admin only sees their own university; the super admin sees everything.
function scope(user, params, alias = "c") {
  if (user.role === "super_admin") return "";
  params.push(user.university_id);
  return ` AND ${alias}.university_id = $${params.length}`;
}

const entryOut = (r) => ({
  id: r.id,
  transactionType: r.transaction_type,
  description: r.description,
  sellerId: r.payee_id,
  sellerRole: r.payee_role,
  saleAmount: Number(r.gross_amount),
  baseAmount: Number(r.base_amount),
  rate: Number(r.rate),
  commission: Number(r.commission_amount),
  status: r.status,
  settledAt: r.settled_at,
  settleNote: r.settle_note,
  createdAt: r.created_at,
});

const SUMMARY_SQL = `
  count(*) FILTER (WHERE c.status <> 'void')::int AS sales_count,
  COALESCE(SUM(c.gross_amount) FILTER (WHERE c.status <> 'void'), 0)::float AS gross,
  COALESCE(SUM(c.commission_amount) FILTER (WHERE c.status = 'due'), 0)::float AS due,
  COALESCE(SUM(c.commission_amount) FILTER (WHERE c.status = 'settled'), 0)::float AS settled`;

const summaryOut = (s) => ({ salesCount: s.sales_count, grossSales: s.gross, commissionDue: s.due, commissionSettled: s.settled });

const listQuery = z.object({ status: z.enum(["due", "settled", "void", "all"]).default("all") });

router.get("/rates", requireAuth(), (req, res) => {
  res.json({ rates: { order: RATES.order, ticket: RATES.ticket, booking: RATES.booking } });
});

// --- Seller: my own ledger ----------------------------------------------------
router.get(
  "/mine",
  requireAuth(),
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const { rows: s } = await db.query(`SELECT ${SUMMARY_SQL} FROM commissions c WHERE c.payee_id = $1`, [req.user.id]);
    const params = [req.user.id];
    let where = "c.payee_id = $1";
    if (req.query.status !== "all") {
      params.push(req.query.status);
      where += ` AND c.status = $${params.length}`;
    }
    const { rows } = await db.query(`SELECT c.* FROM commissions c WHERE ${where} ORDER BY c.created_at DESC LIMIT 200`, params);
    res.json({ summary: summaryOut(s[0]), entries: rows.map(entryOut) });
  })
);

// --- Admin: every seller individually ----------------------------------------
router.get(
  "/admin/sellers",
  requireAuth(),
  requireAdmin,
  asyncHandler(async (req, res) => {
    const params = [];
    const sc = scope(req.user, params);
    const { rows } = await db.query(
      `SELECT c.payee_id AS user_id, u.name, u.email, u.role, ${SUMMARY_SQL},
              COALESCE(SUM(c.commission_amount) FILTER (WHERE c.status <> 'void' AND c.transaction_type = 'order'), 0)::float AS by_order,
              COALESCE(SUM(c.commission_amount) FILTER (WHERE c.status <> 'void' AND c.transaction_type = 'ticket'), 0)::float AS by_ticket,
              COALESCE(SUM(c.commission_amount) FILTER (WHERE c.status <> 'void' AND c.transaction_type = 'booking'), 0)::float AS by_booking,
              COALESCE(SUM(c.commission_amount) FILTER (WHERE c.status <> 'void' AND c.transaction_type NOT IN ('order','ticket','booking')), 0)::float AS by_other
         FROM commissions c JOIN users u ON u.id = c.payee_id
        WHERE true ${sc}
        GROUP BY c.payee_id, u.name, u.email, u.role
        ORDER BY due DESC, u.name`,
      params
    );
    const sellers = rows.map((r) => ({
      userId: r.user_id,
      name: r.name,
      email: r.email,
      role: r.role,
      ...summaryOut(r),
      byType: { shop: r.by_order, tickets: r.by_ticket, rentals: r.by_booking, other: r.by_other },
    }));
    res.json({ sellers });
  })
);

router.get(
  "/admin/sellers/:userId",
  requireAuth(),
  requireAdmin,
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const sellerQuery = req.user.role === "super_admin"
      ? "SELECT id, name, email, role FROM users WHERE id = $1"
      : "SELECT id, name, email, role FROM users WHERE id = $1 AND university_id = $2";
    const sellerParams = req.user.role === "super_admin" ? [req.params.userId] : [req.params.userId, req.user.university_id];
    const { rows: seller } = await db.query(sellerQuery, sellerParams);
    if (!seller[0]) throw notFound("Seller not found");

    const params = [req.params.userId];
    const sc = scope(req.user, params);
    const { rows: s } = await db.query(`SELECT ${SUMMARY_SQL} FROM commissions c WHERE c.payee_id = $1 ${sc}`, params);
    let statusSql = "";
    if (req.query.status !== "all") {
      params.push(req.query.status);
      statusSql = ` AND c.status = $${params.length}`;
    }
    const { rows } = await db.query(
      `SELECT c.* FROM commissions c WHERE c.payee_id = $1 ${sc} ${statusSql} ORDER BY c.created_at DESC LIMIT 500`,
      params
    );
    res.json({ seller: seller[0], summary: summaryOut(s[0]), entries: rows.map(entryOut) });
  })
);

// --- Admin: mark commissions as paid by the seller ----------------------------
const settleBody = z.object({ note: z.string().trim().max(200).optional() });

async function settle(req, res, { where, params, sellerId }) {
  const result = await db.withTransaction(async (client) => {
    // 1. If sellerId provided, ensure seller belongs to admin's university
    let targetUniId = req.user.university_id;
    if (sellerId) {
      const { rows: uRows } = await client.query(
        "SELECT id, university_id FROM users WHERE id = $1 AND ($2::uuid IS NULL OR university_id = $2)",
        [sellerId, req.user.role === "super_admin" ? null : req.user.university_id]
      );
      if (!uRows[0]) throw notFound("Seller not found");
      targetUniId = uRows[0].university_id;
    }

    // 2. Lock due commissions to prevent concurrent settlement
    const sc = scope(req.user, params);
    const { rows } = await client.query(
      `SELECT c.id, c.commission_amount, c.university_id, c.payee_id
         FROM commissions c
        WHERE ${where} AND c.status = 'due' ${sc}
        ORDER BY c.created_at ASC
        FOR UPDATE`,
      params
    );
    if (!rows.length) throw conflict("There is no unsettled commission to mark as paid", "NOTHING_DUE");

    const total = Math.round(rows.reduce((t, r) => t + Number(r.commission_amount), 0) * 100) / 100;
    const seller = sellerId || rows[0].payee_id;
    const uni = targetUniId || rows[0].university_id;

    // 3. Create an auditable record in commission_payments for this manual settlement
    const refNum = `MANUAL-SETTLE-${Date.now()}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
    const { rows: cpRows } = await client.query(
      `INSERT INTO commission_payments
         (university_id, merchant_id, amount, reference_number, status, reviewer_id, reviewed_at, verified_amount, notes)
       VALUES ($1, $2, $3, $4, 'verified', $5, now(), $3, $6)
       RETURNING *`,
      [uni, seller, total, refNum, req.user.id, req.body.note ? `Manual settlement: ${req.body.note.trim()}` : "Direct administrative manual settlement"]
    );
    const cp = cpRows[0];

    // 4. Update commissions to settled referencing this payment
    const settledIds = rows.map((r) => r.id);
    const note = req.body.note ? ` (${req.body.note.trim()})` : "";
    await client.query(
      `UPDATE commissions
          SET status = 'settled', settled_at = now(), settled_by = $2,
              settle_note = 'Verified via manual admin settlement #' || $3::text || $4
        WHERE id = ANY($1)`,
      [settledIds, req.user.id, cp.id, note]
    );

    return { settledCount: rows.length, total, paymentId: cp.id, referenceNumber: refNum, sellerId: seller };
  });

  await audit(req.user.id, "commission.settle", "commission_payment", result.paymentId, {
    sellerId: result.sellerId, count: result.settledCount, total: result.total, referenceNumber: result.referenceNumber,
  });
  await notify(
    result.sellerId,
    "commission_update",
    "Commission settled",
    `${result.settledCount} commission record(s) totalling ${result.total.toFixed(2)} birr were marked as paid by administrator.`
  );
  res.json({ settled: result.settledCount, total: result.total, referenceNumber: result.referenceNumber });
}

router.post(
  "/admin/sellers/:userId/settle",
  requireAuth(),
  requireAdmin,
  validate({ body: settleBody }),
  asyncHandler((req, res) => settle(req, res, { where: "c.payee_id = $1", params: [req.params.userId], sellerId: req.params.userId }))
);

router.post(
  "/admin/:id/settle",
  requireAuth(),
  requireAdmin,
  validate({ body: settleBody }),
  asyncHandler((req, res) => settle(req, res, { where: "c.id = $1", params: [req.params.id] }))
);

// --- Merchant: view official CampusHub receiving accounts to pay commission to ---
router.get(
  "/receiving-accounts",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const universityId = req.user.university_id;
    const { rows } = await db.query(
      `SELECT id, method, account_name, account_number, instructions, is_default
         FROM payout_accounts
        WHERE ($1::uuid IS NULL OR university_id = $1) AND is_campus_hub = true AND active = true
        ORDER BY is_default DESC, created_at ASC`,
      [universityId]
    );
    res.json({ accounts: rows });
  })
);

// --- Merchant: submit commission payment proof to CampusHub ---
router.post(
  "/submit-payment",
  requireAuth(),
  upload.single("screenshot"),
  asyncHandler(async (req, res) => {
    let proofResult = null;
    try {
      if (!req.file) throw badRequest("Attach a screenshot of your commission payment");
      const amount = Number(req.body.amount);
      if (!amount || amount <= 0 || !Number.isFinite(amount)) throw badRequest("Enter a valid commission payment amount");
      const referenceNumber = String(req.body.referenceNumber || "").trim();
      if (!referenceNumber || referenceNumber.length < 4) {
        throw badRequest("Enter the transaction reference from your payment receipt");
      }

      // Check for duplicate active or verified commission payment with same reference
      const { rows: existingRef } = await db.query(
        "SELECT id FROM commission_payments WHERE university_id = $1 AND lower(trim(reference_number)) = lower($2) AND status <> 'rejected'",
        [req.user.university_id, referenceNumber]
      );
      if (existingRef.length > 0) {
        throw conflict("This transaction reference has already been submitted for a commission payment", "DUPLICATE_REFERENCE");
      }

      proofResult = await processUpload({
        tempPath: req.file.path,
        destDir: UPLOAD_PROFILES.paymentProof.destDir,
        allowedTypes: UPLOAD_PROFILES.paymentProof.allowedTypes,
        maxBytes: UPLOAD_PROFILES.paymentProof.maxBytes,
      });

      let rows;
      try {
        const result = await db.query(
          `INSERT INTO commission_payments (university_id, merchant_id, amount, reference_number, proof_file_name, status, notes)
           VALUES ($1, $2, $3, $4, $5, 'submitted', $6) RETURNING *`,
          [req.user.university_id, req.user.id, amount, referenceNumber, proofResult.filename, req.body.notes || null]
        );
        rows = result.rows;
      } catch (insertErr) {
        if (insertErr.code === "23505" && String(insertErr.constraint || insertErr.message || "").toLowerCase().includes("commission_payments")) {
          throw conflict("This transaction reference has already been submitted for a commission payment", "DUPLICATE_REFERENCE");
        }
        throw insertErr;
      }

      await audit(req.user.id, "commission.payment_submitted", "commission_payment", rows[0].id, {
        amount, referenceNumber,
      });

      // Notify university admins of pending commission payment
      const { rows: admins } = await db.query(
        "SELECT id FROM users WHERE role = 'admin' AND university_id = $1",
        [req.user.university_id]
      );
      for (const admin of admins) {
        await notify(
          admin.id,
          "commission_update",
          "Merchant commission payment submitted",
          `${req.user.name} submitted proof for ${amount.toFixed(2)} birr commission payment. Reference: ${referenceNumber}.`
        );
      }

      res.status(201).json({ payment: rows[0] });
    } catch (err) {
      if (proofResult?.filename) {
        const p = path.join(UPLOAD_PROFILES.paymentProof.destDir, proofResult.filename);
        fs.unlink(p, () => {});
      }
      throw err;
    } finally {
      await removeTempFile(req.file?.path);
    }
  })
);

// --- Merchant: view my submitted commission payments ---
router.get(
  "/payments/mine",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT * FROM commission_payments WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json({ payments: rows });
  })
);

// --- Admin: view submitted commission payments queue ---
router.get(
  "/admin/payments",
  requireAuth(),
  requireAdmin,
  asyncHandler(async (req, res) => {
    const params = [];
    const sc = scope(req.user, params, "cp");
    const { rows } = await db.query(
      `SELECT cp.*, u.name AS merchant_name, u.email AS merchant_email, rev.name AS reviewer_name
         FROM commission_payments cp
         JOIN users u ON u.id = cp.merchant_id
         LEFT JOIN users rev ON rev.id = cp.reviewer_id
        WHERE true ${sc}
        ORDER BY cp.created_at DESC LIMIT 100`,
      params
    );
    res.json({ payments: rows });
  })
);

// --- Admin: verify merchant commission payment and settle due balances ---
router.post(
  "/admin/payments/:id/verify",
  requireAuth(),
  requireAdmin,
  validate({
    body: z.object({
      notes: z.string().optional(),
      verifiedAmount: z.number().positive().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const result = await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        "SELECT * FROM commission_payments WHERE id = $1 FOR UPDATE",
        [req.params.id]
      );
      const cp = rows[0];
      if (!cp) throw notFound("Commission payment not found");
      if (req.user.role !== "super_admin" && cp.university_id !== req.user.university_id) {
        throw forbidden("Not authorized for this university");
      }
      if (cp.status !== "submitted") {
        throw conflict(`This commission payment is already ${cp.status}`, "ALREADY_DECIDED");
      }

      // Fetch all outstanding due commissions for this merchant, row-locked to prevent concurrent settlement
      const { rows: dueRows } = await client.query(
        `SELECT id, commission_amount FROM commissions WHERE payee_id = $1 AND status = 'due' ORDER BY created_at ASC FOR UPDATE`,
        [cp.merchant_id]
      );
      if (dueRows.length === 0) {
        throw conflict("Merchant has no outstanding commissions due for settlement", "NO_COMMISSIONS_DUE");
      }

      const totalOutstanding = dueRows.reduce((sum, r) => sum + Number(r.commission_amount), 0);
      const oldestDueAmount = Number(dueRows[0].commission_amount);

      // Determine verified amount
      const submittedAmount = Number(cp.amount);
      const verifiedAmount = req.body.verifiedAmount != null ? Number(req.body.verifiedAmount) : submittedAmount;

      if (!Number.isFinite(verifiedAmount) || verifiedAmount <= 0) {
        throw badRequest("Enter a valid verified settlement amount", "INVALID_VERIFIED_AMOUNT");
      }
      if (verifiedAmount > submittedAmount) {
        throw badRequest(
          `Verified amount (${verifiedAmount.toFixed(2)}) cannot exceed the submitted payment amount (${submittedAmount.toFixed(2)})`,
          "VERIFIED_AMOUNT_EXCEEDS_SUBMITTED"
        );
      }
      if (verifiedAmount > totalOutstanding) {
        throw badRequest(
          `Verified amount (${verifiedAmount.toFixed(2)}) cannot exceed the merchant's outstanding commission balance (${totalOutstanding.toFixed(2)})`,
          "VERIFIED_AMOUNT_EXCEEDS_BALANCE"
        );
      }

      // Reject partial settlement if amount cannot fully cover even the oldest single entry
      if (verifiedAmount < oldestDueAmount) {
        throw badRequest(
          `Payment amount (${verifiedAmount.toFixed(2)} birr) is insufficient to cover the oldest outstanding commission entry (${oldestDueAmount.toFixed(2)} birr)`,
          "INSUFFICIENT_PAYMENT_AMOUNT"
        );
      }

      let remaining = verifiedAmount;
      const settledIds = [];
      let allocatedSum = 0;
      for (const due of dueRows) {
        const amt = Number(due.commission_amount);
        if (remaining >= amt) {
          remaining = Math.round((remaining - amt) * 100) / 100;
          allocatedSum = Math.round((allocatedSum + amt) * 100) / 100;
          settledIds.push(due.id);
        } else {
          break;
        }
      }

      if (settledIds.length === 0) {
        throw badRequest(
          "Payment amount is insufficient to fully settle any outstanding commission entry",
          "INSUFFICIENT_PAYMENT_AMOUNT"
        );
      }

      if (remaining > 0) {
        throw badRequest(
          `Verified amount (${verifiedAmount.toFixed(2)} birr) leaves an unallocated surplus of ${remaining.toFixed(2)} birr. Partial commission entry settlement is not supported. Please verify an amount (${allocatedSum.toFixed(2)} birr) that exactly settles whole commission entries, or reject the payment and request the full balance.`,
          "UNALLOCATED_SURPLUS"
        );
      }

      await client.query(
        `UPDATE commission_payments
            SET status = 'verified', reviewer_id = $2, reviewed_at = now(),
                verified_amount = $3, notes = COALESCE($4, notes)
          WHERE id = $1`,
        [cp.id, req.user.id, verifiedAmount, req.body.notes || null]
      );

      await client.query(
        `UPDATE commissions SET status = 'settled', settled_at = now(), settled_by = $2,
                settle_note = 'Verified via commission payment #' || $3::text
         WHERE id = ANY($1)`,
        [settledIds, req.user.id, cp.id]
      );

      return {
        ...cp,
        status: "verified",
        amount: submittedAmount,
        verified_amount: verifiedAmount,
        settledCount: settledIds.length,
      };
    });

    await audit(req.user.id, "commission.payment_verified", "commission_payment", result.id, {
      merchantId: result.merchant_id, amount: Number(result.amount), verifiedAmount: Number(result.verified_amount),
    });
    await notify(
      result.merchant_id,
      "commission_update",
      "Commission payment verified",
      `Your commission payment has been verified for ${Number(result.verified_amount).toFixed(2)} birr by the administrator.`
    );
    res.json({ payment: result });
  })
);

// --- Admin: reject merchant commission payment ---
router.post(
  "/admin/payments/:id/reject",
  requireAuth(),
  requireAdmin,
  validate({ body: z.object({ reason: z.string().min(3) }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      "SELECT * FROM commission_payments WHERE id = $1",
      [req.params.id]
    );
    const cp = rows[0];
    if (!cp) throw notFound("Commission payment not found");
    if (req.user.role !== "super_admin" && cp.university_id !== req.user.university_id) {
      throw forbidden("Not authorized for this university");
    }
    if (cp.status !== "submitted") {
      throw conflict(`This commission payment is already ${cp.status}`, "ALREADY_DECIDED");
    }

    const { rows: upd } = await db.query(
      `UPDATE commission_payments SET status = 'rejected', reviewer_id = $2, reviewed_at = now(), notes = $3
       WHERE id = $1 RETURNING *`,
      [cp.id, req.user.id, req.body.reason]
    );

    await audit(req.user.id, "commission.payment_rejected", "commission_payment", cp.id, {
      merchantId: cp.merchant_id, reason: req.body.reason,
    });
    await notify(
      cp.merchant_id,
      "commission_update",
      "Commission payment rejected",
      `Your commission payment proof was rejected: ${req.body.reason}`
    );
    res.json({ payment: upd[0] });
  })
);

// --- View commission payment proof image safely ---
router.get(
  "/payments/:id/image",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query("SELECT * FROM commission_payments WHERE id = $1", [req.params.id]);
    const cp = rows[0];
    if (!cp) throw notFound("Payment record not found");
    const canViewProof =
      req.user.id === cp.merchant_id ||
      req.user.role === "super_admin" ||
      (req.user.role === "admin" && req.user.university_id === cp.university_id);
    if (!canViewProof) throw forbidden("Not authorized to view this proof");
    if (!sendFileSafely(res, UPLOAD_PROFILES.paymentProof.destDir, cp.proof_file_name)) {
      throw notFound("Proof image is no longer available");
    }
  })
);

module.exports = router;