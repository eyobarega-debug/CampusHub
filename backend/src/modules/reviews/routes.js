const express = require("express");
const { z } = require("zod");
const db = require("../../db");
const { requireAuth } = require("../../middleware/auth");
const { validate } = require("../../middleware/validate");
const { asyncHandler, badRequest, forbidden } = require("../../utils/errors");

const router = express.Router();

const TARGET_TYPES = ["product", "store", "listing", "user"];

// FR-047 alt flow: block reviews without a qualifying completed transaction,
// to prevent fake reviews. Each target type has a different definition of
// "qualifying" — kept intentionally simple for the Phase 1 demo.
async function hasQualifyingTransaction(userId, targetType, targetId) {
  if (targetType === "product") {
    const { rows } = await db.query(
      `SELECT 1 FROM orders o JOIN order_items oi ON oi.order_id = o.id
       WHERE o.buyer_id = $1 AND oi.product_id = $2 AND o.status = 'completed' LIMIT 1`,
      [userId, targetId]
    );
    return !!rows[0];
  }
  if (targetType === "store") {
    const { rows } = await db.query("SELECT 1 FROM orders WHERE buyer_id=$1 AND store_id=$2 AND status='completed' LIMIT 1", [
      userId,
      targetId,
    ]);
    return !!rows[0];
  }
  if (targetType === "listing") {
    const { rows } = await db.query(
      "SELECT 1 FROM p2p_requests WHERE buyer_id=$1 AND listing_id=$2 AND status='accepted' LIMIT 1",
      [userId, targetId]
    );
    return !!rows[0];
  }
  if (targetType === "user") {
    // reviewing a rental counterpart (lender or borrower) after a completed booking
    const { rows } = await db.query(
      `SELECT 1 FROM rental_bookings b JOIN rental_items ri ON ri.id = b.rental_item_id
       WHERE b.status = 'completed' AND (
         (b.borrower_id = $1 AND ri.owner_id = $2) OR (ri.owner_id = $1 AND b.borrower_id = $2)
       ) LIMIT 1`,
      [userId, targetId]
    );
    return !!rows[0];
  }
  return false;
}

router.post(
  "/",
  requireAuth(),
  validate({
    body: z.object({
      targetType: z.enum(TARGET_TYPES),
      targetId: z.string().uuid(),
      rating: z.number().int().min(1).max(5),
      comment: z.string().max(2000).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const ok = await hasQualifyingTransaction(req.user.id, req.body.targetType, req.body.targetId);
    if (!ok) throw forbidden("You can only review after a completed transaction with this target");

    const { rows } = await db.query(
      "INSERT INTO reviews (author_id, target_type, target_id, rating, comment) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [req.user.id, req.body.targetType, req.body.targetId, req.body.rating, req.body.comment || null]
    );
    res.status(201).json({ review: rows[0] });
  })
);

// FR-049 — list + aggregate rating for a target
router.get(
  "/",
  validate({ query: z.object({ targetType: z.enum(TARGET_TYPES), targetId: z.string().uuid(), page: z.string().optional() }) }),
  asyncHandler(async (req, res) => {
    const { targetType, targetId } = req.query;
    const { rows } = await db.query(
      `SELECT r.*, u.name AS author_name FROM reviews r JOIN users u ON u.id = r.author_id
       WHERE r.target_type = $1 AND r.target_id = $2 ORDER BY r.created_at DESC LIMIT 50`,
      [targetType, targetId]
    );
    const agg = await db.query(
      "SELECT COALESCE(AVG(rating),0)::float AS avg_rating, COUNT(*) AS count FROM reviews WHERE target_type=$1 AND target_id=$2",
      [targetType, targetId]
    );
    res.json({ reviews: rows, avgRating: agg.rows[0].avg_rating, count: Number(agg.rows[0].count) });
  })
);

module.exports = router;
