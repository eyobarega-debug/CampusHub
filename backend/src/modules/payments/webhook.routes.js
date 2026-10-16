const express = require("express");
const { asyncHandler, unauthorized } = require("../../utils/errors");
const paymentsService = require("../../services/payments");

const router = express.Router();

/**
 * POST /api/payments/webhook
 *
 * Chapa external payment gateway webhook receiver.
 * Unauthenticated by user JWT — authenticated cryptographically via HMAC-SHA256 signature
 * header (`x-chapa-signature` or `chapa-signature`).
 *
 * Before fulfilling, performs server-side transaction verification against Chapa API
 * (amount, currency ETB, reference, and success status) and safely updates the DB
 * using row-level locking for concurrency protection and idempotency.
 */
router.post(
  ["/", ""],
  asyncHandler(async (req, res) => {
    const signature = req.headers["x-chapa-signature"] || req.headers["chapa-signature"];
    if (!signature) {
      throw unauthorized("Missing webhook signature header", "MISSING_SIGNATURE");
    }

    const result = await paymentsService.processChapaWebhook({
      rawBody: req.rawBody,
      signature,
      payload: req.body,
    });

    res.json(result);
  })
);

module.exports = router;
