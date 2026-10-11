const express = require("express");
const { z } = require("zod");
const db = require("../../db");
const { requireAuth } = require("../../middleware/auth");
const { validate } = require("../../middleware/validate");
const { asyncHandler, notFound, forbidden, conflict } = require("../../utils/errors");
const { notify } = require("../../utils/notify");
const payments = require("../../services/payments");

const { scopeTo, assertSameTenant } = require("../../middleware/tenant");
const router = express.Router();

// A tiny content screen standing in for FR-012's "automated content
// screening" — flags obviously prohibited terms for manual review instead
// of publishing immediately. Real implementation would be a proper
// moderation service/model.
const BLOCKED_TERMS = ["stolen", "fake id", "weapon", "drugs"];
function needsReview(text) {
  const lower = (text || "").toLowerCase();
  return BLOCKED_TERMS.some((t) => lower.includes(t));
}

// FR-014 — browse/search
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { q, category, condition, minPrice, maxPrice } = req.query;
    const conditions = ["l.status = 'active'"];
    const params = [];
    if (q) {
      params.push(`%${q}%`);
      conditions.push(`(l.title ILIKE $${params.length} OR l.description ILIKE $${params.length})`);
    }
    if (category) {
      params.push(category);
      conditions.push(`l.category_id = $${params.length}`);
    }
    if (condition) {
      params.push(condition);
      conditions.push(`l.condition = $${params.length}`);
    }
    if (minPrice) {
      params.push(minPrice);
      conditions.push(`l.price >= $${params.length}`);
    }
    if (maxPrice) {
      params.push(maxPrice);
      conditions.push(`l.price <= $${params.length}`);
    }
    scopeTo(req, "l.university_id", conditions, params);
    const { rows } = await db.query(
      `SELECT l.*, u.name AS seller_name FROM p2p_listings l JOIN users u ON u.id = l.seller_id
       WHERE ${conditions.join(" AND ")} ORDER BY l.created_at DESC LIMIT 40`,
      params
    );
    res.json({ listings: rows });
  })
);

router.get(
  "/mine",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query("SELECT * FROM p2p_listings WHERE seller_id = $1 ORDER BY created_at DESC", [req.user.id]);
    res.json({ listings: rows });
  })
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT l.*, u.name AS seller_name FROM p2p_listings l JOIN users u ON u.id = l.seller_id WHERE l.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) throw notFound("Listing not found");
    assertSameTenant(req, rows[0].university_id, "Listing");
    res.json({ listing: rows[0] });
  })
);

// FR-012 / FR-013 — create listing (images already-uploaded URLs, per SRS'
// simplified MVP image handling — see README)
router.post(
  "/",
  requireAuth(),
  validate({
    body: z.object({
      title: z.string().min(2),
      description: z.string().optional(),
      price: z.number().nonnegative(),
      condition: z.string().optional(),
      categoryId: z.string().uuid().optional(),
      images: z.array(z.string()).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    if (!req.user.verified) throw forbidden("Verify your student account before listing an item");
    const flagged = needsReview(`${req.body.title} ${req.body.description || ""}`);
    const { rows } = await db.query(
      `INSERT INTO p2p_listings (seller_id, title, description, price, condition, category_id, images, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        req.user.id,
        req.body.title,
        req.body.description || null,
        req.body.price,
        req.body.condition || null,
        req.body.categoryId || null,
        req.body.images || [],
        flagged ? "pending_review" : "active",
      ]
    );
    res.status(201).json({ listing: rows[0], flaggedForReview: flagged });
  })
);

// FR-016 — edit or close own listing
router.patch(
  "/:id",
  requireAuth(),
  validate({
    body: z.object({
      title: z.string().optional(),
      description: z.string().optional(),
      price: z.number().nonnegative().optional(),
      condition: z.string().optional(),
      images: z.array(z.string()).optional(),
      status: z.enum(["active", "sold", "removed"]).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { rows: existingRows } = await db.query("SELECT * FROM p2p_listings WHERE id = $1", [req.params.id]);
    if (!existingRows[0]) throw notFound("Listing not found");
    if (existingRows[0].seller_id !== req.user.id) throw forbidden("You do not own this listing");

    const b = req.body;
    const { rows } = await db.query(
      `UPDATE p2p_listings SET
        title = COALESCE($1,title), description = COALESCE($2,description), price = COALESCE($3,price),
        condition = COALESCE($4,condition), images = COALESCE($5,images), status = COALESCE($6,status)
       WHERE id = $7 RETURNING *`,
      [b.title, b.description, b.price, b.condition, b.images, b.status, req.params.id]
    );
    res.json({ listing: rows[0] });
  })
);

// FR-015 — buy/contact request
router.post(
  "/:id/requests",
  requireAuth(),
  validate({ body: z.object({ message: z.string().optional() }) }),
  asyncHandler(async (req, res) => {
    const { rows: listingRows } = await db.query("SELECT * FROM p2p_listings WHERE id = $1", [req.params.id]);
    const listing = listingRows[0];
    if (!listing) throw notFound("Listing not found");
    assertSameTenant(req, listing.university_id, "Listing");
    if (listing.status !== "active") throw conflict("This listing is no longer active");
    if (listing.seller_id === req.user.id) throw conflict("You cannot request to buy your own listing");

    const { rows } = await db.query(
      "INSERT INTO p2p_requests (listing_id, buyer_id, message) VALUES ($1,$2,$3) RETURNING *",
      [listing.id, req.user.id, req.body.message || null]
    );
    await notify(listing.seller_id, "p2p_request", `New interest in "${listing.title}"`, req.body.message || "A student wants to buy this item.");
    res.status(201).json({ request: rows[0] });
  })
);

router.get(
  "/:id/requests",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const { rows: listingRows } = await db.query("SELECT * FROM p2p_listings WHERE id = $1", [req.params.id]);
    if (!listingRows[0]) throw notFound("Listing not found");
    if (listingRows[0].seller_id !== req.user.id) throw forbidden();
    const { rows } = await db.query(
      `SELECT r.*, u.name AS buyer_name FROM p2p_requests r JOIN users u ON u.id = r.buyer_id
       WHERE r.listing_id = $1 ORDER BY r.created_at DESC`,
      [req.params.id]
    );
    res.json({ requests: rows });
  })
);

// Buyer-side companion to the seller view above: "what's the status of my
// own request on this listing" so the buyer's page can show a Pay button
// after reload, without needing to remember the request id client-side.
router.get(
  "/:id/my-request",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      "SELECT * FROM p2p_requests WHERE listing_id = $1 AND buyer_id = $2 ORDER BY created_at DESC LIMIT 1",
      [req.params.id, req.user.id]
    );
    if (!rows[0]) return res.json({ request: null, order: null });
    const orderRows = await db.query("SELECT * FROM p2p_orders WHERE request_id = $1", [rows[0].id]);
    res.json({ request: rows[0], order: orderRows.rows[0] || null });
  })
);

router.patch(
  "/requests/:requestId",
  requireAuth(),
  validate({ body: z.object({ status: z.enum(["accepted", "declined"]) }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT r.*, l.seller_id, l.title, l.price, l.status AS listing_status
       FROM p2p_requests r JOIN p2p_listings l ON l.id = r.listing_id WHERE r.id = $1`,
      [req.params.requestId]
    );
    const request = rows[0];
    if (!request) throw notFound("Request not found");
    if (request.seller_id !== req.user.id) throw forbidden();
    if (request.status !== "pending") throw conflict("This request has already been decided");

    let order = null;
    if (req.body.status === "accepted") {
      if (request.listing_status !== "active") throw conflict("This listing is no longer active");
      const { rows: orderRows } = await db.query(
        `INSERT INTO p2p_orders (listing_id, request_id, buyer_id, seller_id, amount)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [request.listing_id, request.id, request.buyer_id, request.seller_id, request.price]
      );
      order = orderRows[0];
    }

    await db.query("UPDATE p2p_requests SET status = $1 WHERE id = $2", [req.body.status, request.id]);
    await notify(
      request.buyer_id,
      "p2p_request",
      `Your request on "${request.title}" was ${req.body.status}`,
      req.body.status === "accepted"
        ? "You can now pay in-app, or coordinate a handover with the seller directly."
        : undefined
    );
    res.json({ success: true, order });
  })
);

// Phase 2 — optional in-app payment for an accepted P2P request. Reuses the
// same Payment Gateway Abstraction Layer as orders/rentals/tickets (SRS
// Section 16); Phase 1 only supported off-platform handover.
router.post(
  "/requests/:requestId/pay",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query("SELECT * FROM p2p_orders WHERE request_id = $1", [req.params.requestId]);
    const order = rows[0];
    if (!order) throw notFound("No payable order exists for this request yet — has the seller accepted it?");
    if (order.buyer_id !== req.user.id) throw forbidden();
    if (order.status !== "pending_payment") throw conflict(`This order is already ${order.status}`);

    const payment = await payments.initiatePayment({
      transactionType: "p2p_order",
      transactionId: order.id,
      amount: order.amount,
      buyerId: req.user.id,
    });
    res.status(201).json({ order, payment });
  })
);

router.get(
  "/requests/:requestId/order",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query("SELECT * FROM p2p_orders WHERE request_id = $1", [req.params.requestId]);
    const order = rows[0];
    if (!order) return res.json({ order: null });
    if (![order.buyer_id, order.seller_id].includes(req.user.id)) throw forbidden();
    res.json({ order });
  })
);

payments.registerFinalizer("p2p_order", {
  onConfirmed: async (orderId, client) => {
    const { rows } = await client.query("UPDATE p2p_orders SET status='paid' WHERE id=$1 RETURNING *", [orderId]);
    const order = rows[0];
    await client.query("UPDATE p2p_listings SET status='sold' WHERE id=$1", [order.listing_id]);
    const listing = await client.query("SELECT title FROM p2p_listings WHERE id = $1", [order.listing_id]);
    await client.query("INSERT INTO notifications (user_id, type, title, body) VALUES ($1,'p2p_request',$2,$3)", [
      order.seller_id,
      "Payment received",
      `"${listing.rows[0].title}" was paid for in-app. Arrange handover with the buyer.`,
    ]);
  },
  onFailed: async () => {
    // Left in 'pending_payment' deliberately — a failed attempt shouldn't
    // burn the buyer's only chance to pay; they can just retry.
  },
});

module.exports = router;
