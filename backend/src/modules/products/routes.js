const express = require("express");
const { z } = require("zod");
const db = require("../../db");
const { requireAuth, requireRole, optionalAuth } = require("../../middleware/auth");
const { validate } = require("../../middleware/validate");
const { asyncHandler, notFound, forbidden } = require("../../utils/errors");
const payments = require("../../services/payments");

const { scopeTo, assertSameTenant } = require("../../middleware/tenant");
const router = express.Router();

const { getFees } = require("../../services/fees");
const FEATURED_RATE_PER_DAY = Number(process.env.FEATURED_RATE_PER_DAY || 20); // illustrative — SRS Section 18

// FR-006 — browse & search
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { q, category, minPrice, maxPrice, storeId, page = "1" } = req.query;
    const conditions = ["p.status = 'active'"];
    const params = [];

    if (q) {
      params.push(`%${q}%`);
      conditions.push(`(p.title ILIKE $${params.length} OR p.description ILIKE $${params.length})`);
    }
    if (category) {
      params.push(category);
      conditions.push(`p.category_id = $${params.length}`);
    }
    if (storeId) {
      params.push(storeId);
      conditions.push(`p.store_id = $${params.length}`);
    }
    if (minPrice) {
      params.push(minPrice);
      conditions.push(`p.price >= $${params.length}`);
    }
    if (maxPrice) {
      params.push(maxPrice);
      conditions.push(`p.price <= $${params.length}`);
    }

    scopeTo(req, "s.university_id", conditions, params);
    const limit = 20;
    const offset = (Math.max(1, Number(page)) - 1) * limit;
    params.push(limit, offset);

    const { rows } = await db.query(
      `SELECT p.*, s.name AS store_name,
              (p.featured_until IS NOT NULL AND p.featured_until > now()) AS is_featured,
              COALESCE(AVG(r.rating),0)::float AS avg_rating, COUNT(r.id) AS review_count
       FROM products p
       JOIN stores s ON s.id = p.store_id
       LEFT JOIN reviews r ON r.target_type = 'product' AND r.target_id = p.id
       WHERE ${conditions.join(" AND ")}
       GROUP BY p.id, s.name
       ORDER BY is_featured DESC, p.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ products: rows, page: Number(page) });
  })
);

// FR-007 — product detail
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT p.*, s.name AS store_name, s.id AS store_id, s.university_id,
              COALESCE(AVG(r.rating),0)::float AS avg_rating, COUNT(r.id) AS review_count
       FROM products p JOIN stores s ON s.id = p.store_id
       LEFT JOIN reviews r ON r.target_type = 'product' AND r.target_id = p.id
       WHERE p.id = $1 AND p.status <> 'removed'
       GROUP BY p.id, s.name, s.id, s.university_id`,
      [req.params.id]
    );
    if (!rows[0]) throw notFound("This product is no longer available");
    assertSameTenant(req, rows[0].university_id, "Product");
    res.json({ product: rows[0] });
  })
);

async function getOwnedStoreId(userId) {
  const { rows } = await db.query("SELECT id FROM stores WHERE merchant_id = $1", [userId]);
  return rows[0]?.id;
}

const productSchema = z.object({
  title: z.string().min(2),
  description: z.string().optional(),
  price: z.number().nonnegative(),
  stock: z.number().int().nonnegative().default(0),
  categoryId: z.string().uuid().optional(),
  images: z.array(z.string()).optional(),
});

// FR-039 (merchant module) — create product
router.post(
  "/",
  requireAuth(),
  requireRole("merchant"),
  validate({ body: productSchema }),
  asyncHandler(async (req, res) => {
    const storeId = await getOwnedStoreId(req.user.id);
    if (!storeId) throw forbidden("Merchant has no store yet");
    const { title, description, price, stock, categoryId, images } = req.body;
    const { rows } = await db.query(
      `INSERT INTO products (store_id, category_id, title, description, price, stock, images, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $6::int > 0 THEN 'active' ELSE 'out_of_stock' END)
       RETURNING *`,
      [storeId, categoryId || null, title, description || null, price, stock, images || []]
    );
    res.status(201).json({ product: rows[0] });
  })
);

router.patch(
  "/:id",
  requireAuth(),
  requireRole("merchant", "admin"),
  validate({ body: productSchema.partial() }),
  asyncHandler(async (req, res) => {
    const { rows: existingRows } = await db.query("SELECT * FROM products WHERE id = $1", [req.params.id]);
    const existing = existingRows[0];
    if (!existing) throw notFound("Product not found");

    if (req.user.role === "merchant") {
      const storeId = await getOwnedStoreId(req.user.id);
      if (existing.store_id !== storeId) throw forbidden("You do not own this product");
    }

    const b = req.body;
    let status = existing.status;
    if (b.stock !== undefined) status = b.stock > 0 ? (status === "removed" ? status : "active") : "out_of_stock";

    const { rows } = await db.query(
      `UPDATE products SET
         title = COALESCE($1,title), description = COALESCE($2,description),
         price = COALESCE($3,price), stock = COALESCE($4,stock),
         category_id = COALESCE($5,category_id), images = COALESCE($6,images), status = $7
       WHERE id = $8 RETURNING *`,
      [b.title, b.description, b.price, b.stock, b.categoryId, b.images, status, req.params.id]
    );
    res.json({ product: rows[0] });
  })
);

router.delete(
  "/:id",
  requireAuth(),
  requireRole("merchant", "admin"),
  asyncHandler(async (req, res) => {
    const { rows: existingRows } = await db.query("SELECT * FROM products WHERE id = $1", [req.params.id]);
    const existing = existingRows[0];
    if (!existing) throw notFound("Product not found");
    if (req.user.role === "merchant") {
      const storeId = await getOwnedStoreId(req.user.id);
      if (existing.store_id !== storeId) throw forbidden("You do not own this product");
    }
    await db.query("UPDATE products SET status = 'removed' WHERE id = $1", [req.params.id]);
    res.status(204).send();
  })
);

// FR-010 — favorites
router.post(
  "/:id/favorite",
  requireAuth(),
  asyncHandler(async (req, res) => {
    await db.query(
      "INSERT INTO favorites (user_id, product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [req.user.id, req.params.id]
    );
    res.status(201).json({ favorited: true });
  })
);

router.delete(
  "/:id/favorite",
  requireAuth(),
  asyncHandler(async (req, res) => {
    await db.query("DELETE FROM favorites WHERE user_id = $1 AND product_id = $2", [req.user.id, req.params.id]);
    res.status(204).send();
  })
);

router.get(
  "/me/favorites",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT p.* FROM favorites f JOIN products p ON p.id = f.product_id WHERE f.user_id = $1 ORDER BY f.created_at DESC`,
      [req.user.id]
    );
    res.json({ products: rows });
  })
);

// FR-038 — merchant pays to feature a product for N days. Reuses the same
// Payment Gateway Abstraction Layer as orders/rentals/tickets (SRS Section
// 16) rather than a bespoke "promotions billing" path.
router.post(
  "/:id/promote",
  requireAuth(),
  requireRole("merchant"),
  validate({ body: z.object({ days: z.number().int().positive().max(30).default(7) }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query("SELECT p.*, s.merchant_id FROM products p JOIN stores s ON s.id=p.store_id WHERE p.id=$1", [
      req.params.id,
    ]);
    const product = rows[0];
    if (!product) throw notFound("Product not found");
    if (product.merchant_id !== req.user.id) throw forbidden("You do not own this product");

    const { rows: st } = await db.query("SELECT university_id FROM stores WHERE id = $1", [product.store_id]);
    const { featuredRatePerDay } = await getFees(st[0].university_id);
    const amount = featuredRatePerDay * req.body.days;
    const payment = await payments.initiatePayment({
      transactionType: "promotion",
      transactionId: product.id,
      amount,
      buyerId: req.user.id,
    });
    await db.query("UPDATE payments SET details = $2 WHERE id = $1", [payment.paymentId, JSON.stringify({ days: req.body.days, ratePerDay: featuredRatePerDay })]);
    res.status(201).json({ payment, days: req.body.days, ratePerDay: featuredRatePerDay });
  })
);

payments.registerFinalizer("promotion", {
  onConfirmed: async (productId, client) => {
    // Days-purchased isn't on the Payment row itself; recompute from the
    // amount charged so this stays correct even if FEATURED_RATE_PER_DAY
    // changes between initiation and confirmation.
    const { rows } = await client.query(
      "SELECT amount, details FROM payments WHERE transaction_type='promotion' AND transaction_id=$1 ORDER BY created_at DESC LIMIT 1",
      [productId]
    );
    // Phase 3: days are recorded on the payment (rates differ per university and can change).
    const days = rows[0]?.details?.days
      ? Number(rows[0].details.days)
      : Math.max(1, Math.round(Number(rows[0]?.amount || FEATURED_RATE_PER_DAY) / FEATURED_RATE_PER_DAY));
    await client.query(
      `UPDATE products SET featured_until = GREATEST(COALESCE(featured_until, now()), now()) + ($2 || ' days')::interval
       WHERE id = $1`,
      [productId, days]
    );
  },
  onFailed: async () => {
    // Nothing was held/reserved for a promotion purchase — no cleanup needed.
  },
});

module.exports = router;
