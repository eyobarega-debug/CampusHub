const express = require("express");
const { z } = require("zod");
const db = require("../../db");
const { requireAuth, requireRole } = require("../../middleware/auth");
const { validate } = require("../../middleware/validate");
const { asyncHandler, notFound, forbidden } = require("../../utils/errors");
const paymentsService = require("../../services/payments");

const router = express.Router();

router.get(
  "/:id",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query("SELECT * FROM payments WHERE id = $1", [req.params.id]);
    if (!rows[0]) throw notFound("Payment not found");
    res.json({ payment: rows[0] });
  })
);

// Simulates the payment provider's redirect-based mock checkout completing.
// In production this event would arrive as a signed webhook from the real
// PSP (SRS Section 16.2); here the "signature" is simply that the caller is
// authenticated as the student who owns the payment.
router.post(
  "/mock/:id/complete",
  requireAuth(),
  validate({ body: z.object({ outcome: z.enum(["success", "fail"]).default("success") }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query("SELECT * FROM payments WHERE id = $1", [req.params.id]);
    const payment = rows[0];
    if (!payment) throw notFound("Payment not found");
    // A real webhook has no notion of "the logged-in user" — this check is a
    // stand-in for provider signature verification, appropriate for a local demo.
    if (req.user.role !== "admin") {
      const owns = await verifyOwnership(payment, req.user.id);
      if (!owns) throw forbidden("This payment does not belong to you");
    }
    const result = await paymentsService.handleProviderCallback(payment.id, req.body.outcome);
    res.json({ payment: result });
  })
);

// Confirms the caller is the buyer on this specific payment before letting
// them simulate its outcome — see the comment on POST /mock/:id/complete.
// Written as an explicit switch (not a generic table/column lookup map)
// after a real bug where two new transaction types (promotion, p2p_order)
// were added to services/payments.js without updating this function, and
// the generic map's silent `undefined` table name produced a confusing
// "relation \"undefined\" does not exist" error instead of a clear one.
// An unhandled type now fails loudly instead of silently.
async function verifyOwnership(payment, userId) {
  switch (payment.transaction_type) {
    case "order": {
      const { rows } = await db.query("SELECT 1 FROM orders WHERE id=$1 AND buyer_id=$2", [payment.transaction_id, userId]);
      return !!rows[0];
    }
    case "booking": {
      const { rows } = await db.query("SELECT 1 FROM rental_bookings WHERE id=$1 AND borrower_id=$2", [payment.transaction_id, userId]);
      return !!rows[0];
    }
    case "ticket": {
      const { rows } = await db.query("SELECT 1 FROM tickets WHERE id=$1 AND holder_id=$2", [payment.transaction_id, userId]);
      return !!rows[0];
    }
    case "promotion": {
      const { rows } = await db.query(
        "SELECT 1 FROM products p JOIN stores s ON s.id = p.store_id WHERE p.id = $1 AND s.merchant_id = $2",
        [payment.transaction_id, userId]
      );
      return !!rows[0];
    }
    case "p2p_order": {
      const { rows } = await db.query("SELECT 1 FROM p2p_orders WHERE id=$1 AND buyer_id=$2", [payment.transaction_id, userId]);
      return !!rows[0];
    }
    default:
      throw new Error(`verifyOwnership: no ownership rule defined for transaction_type "${payment.transaction_type}"`);
  }
}

router.post(
  "/:id/refund",
  requireAuth(),
  requireRole("admin"),
  validate({ body: z.object({ amount: z.number().nonnegative().optional(), reason: z.string().optional() }) }),
  asyncHandler(async (req, res) => {
    const payment = await paymentsService.refundPayment(req.params.id, req.body.amount, req.body.reason, req.user.id);
    res.json({ payment });
  })
);

module.exports = router;
