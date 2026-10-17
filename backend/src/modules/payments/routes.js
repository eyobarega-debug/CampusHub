const express = require("express");
const { z } = require("zod");
const db = require("../../db");
const { requireAuth, requireRole } = require("../../middleware/auth");
const { validate } = require("../../middleware/validate");
const { assertSameTenant } = require("../../middleware/tenant");
const { asyncHandler, notFound, forbidden, badRequest, conflict } = require("../../utils/errors");
const paymentsService = require("../../services/payments");

const router = express.Router();

router.get(
  "/:id",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query("SELECT * FROM payments WHERE id = $1", [req.params.id]);
    const payment = rows[0];
    if (!payment) throw notFound("Payment not found");
    assertSameTenant(req, payment.university_id, "Payment");

    const isPlatformAdmin = req.user.role === "super_admin";
    const isCampusAdmin = req.user.role === "admin";
    if (!isPlatformAdmin && !isCampusAdmin) {
      const isPayer = payment.payer_id === req.user.id || (await verifyOwnership(payment, req.user.id).catch(() => false));
      const isPayee = payment.payee_id === req.user.id;
      if (!isPayer && !isPayee) {
        throw notFound("Payment not found");
      }
    }

    res.json({ payment });
  })
);

// Simulates the payment provider's redirect-based mock checkout completing.
// Only allowed in non-production environments for payments with provider === 'mock'.
router.post(
  "/mock/:id/complete",
  requireAuth(),
  validate({ body: z.object({ outcome: z.enum(["success", "fail"]).default("success") }) }),
  asyncHandler(async (req, res) => {
    if (process.env.NODE_ENV === "production") {
      throw forbidden("Mock payment completion is disabled in production", "MOCK_PAYMENTS_DISABLED");
    }

    const { rows } = await db.query("SELECT * FROM payments WHERE id = $1", [req.params.id]);
    const payment = rows[0];
    if (!payment) throw notFound("Payment not found");
    assertSameTenant(req, payment.university_id, "Payment");

    // Only allow mock completion when the payment's actual provider is 'mock'
    if (payment.provider !== "mock") {
      throw badRequest(`Mock completion is not allowed for provider "${payment.provider}"`, "INVALID_PAYMENT_PROVIDER");
    }

    // Prevent repeated completion, replay, and invalid state transitions
    if (payment.status !== "pending") {
      throw conflict(`Payment cannot be completed because status is "${payment.status}"`, "PAYMENT_NOT_PENDING");
    }

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
async function verifyOwnership(payment, userId) {
  if (payment.payer_id) {
    return payment.payer_id === userId;
  }
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
  requireRole("admin", "super_admin"),
  validate({ body: z.object({ amount: z.number().nonnegative().optional(), reason: z.string().optional() }) }),
  asyncHandler(async (req, res) => {
        const { rows } = await db.query("SELECT university_id FROM payments WHERE id = $1", [req.params.id]);
    if (!rows[0]) throw notFound("Payment not found");
    assertSameTenant(req, rows[0].university_id, "Payment"); // an admin can only refund their own university's payments
    const payment = await paymentsService.refundPayment(req.params.id, req.body.amount, req.body.reason, req.user.id);
    res.json({ payment });
  })
);

module.exports = router;
