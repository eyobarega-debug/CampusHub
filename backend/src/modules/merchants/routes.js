const express = require("express");
const { z } = require("zod");
const db = require("../../db");
const { requireAuth, requireRole } = require("../../middleware/auth");
const { validate } = require("../../middleware/validate");
const { asyncHandler, badRequest, notFound, forbidden, conflict } = require("../../utils/errors");
const { notify, audit } = require("../../utils/notify");
const { toCsv } = require("../../utils/csv");

const { assertSameTenant } = require("../../middleware/tenant");
const router = express.Router();

// FR-034 — apply for a merchant account
router.post(
  "/apply",
  requireAuth(),
  validate({
    body: z.object({
      businessName: z.string().min(2),
      category: z.string().optional(),
      contactInfo: z.string().optional(),
      documentUrls: z.array(z.string()).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const existing = await db.query(
      "SELECT id FROM merchant_applications WHERE user_id = $1 AND status = 'pending_review'",
      [req.user.id]
    );
    if (existing.rows.length) throw conflict("You already have a pending merchant application");

    const { rows } = await db.query(
      `INSERT INTO merchant_applications (user_id, business_name, category, contact_info, document_urls)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.user.id, req.body.businessName, req.body.category || null, req.body.contactInfo || null, req.body.documentUrls || []]
    );

    const admins = await db.query("SELECT id FROM users WHERE role = 'admin'");
    await Promise.all(
      admins.rows.map((a) => notify(a.id, "merchant_application", "New merchant application", `${req.body.businessName} applied to sell on CampusHub.`))
    );

    res.status(201).json({ application: rows[0] });
  })
);

// Admin: list applications (supporting endpoint for the admin dashboard)
router.get(
  "/applications",
  requireAuth(),
  requireRole("admin", "super_admin"),
  asyncHandler(async (req, res) => {
    const status = req.query.status || "pending_review";
    const { rows } = await db.query(
      `SELECT ma.*, u.name AS applicant_name, u.email AS applicant_email
       FROM merchant_applications ma JOIN users u ON u.id = ma.user_id
       WHERE ($1::text IS NULL OR ma.status = $1) AND ($2::uuid IS NULL OR ma.university_id = $2) ORDER BY ma.created_at DESC`,
      [status === "all" ? null : status, req.tenant.universityId]
    );
    res.json({ applications: rows });
  })
);

// FR-039 / UC-10 — admin approves or rejects a merchant application
router.patch(
  "/:id/decision",
  requireAuth(),
  requireRole("admin", "super_admin"),
  validate({ body: z.object({ decision: z.enum(["approve", "reject"]), reason: z.string().optional() }) }),
  asyncHandler(async (req, res) => {
    const result = await db.withTransaction(async (client) => {
      const { rows } = await client.query("SELECT * FROM merchant_applications WHERE id = $1 FOR UPDATE", [req.params.id]);
      const app = rows[0];
      if (!app) throw notFound("Application not found");
      assertSameTenant(req, app.university_id, "Application");
      if (app.status !== "pending_review") throw conflict("This application has already been decided");

      const status = req.body.decision === "approve" ? "approved" : "rejected";
      await client.query("UPDATE merchant_applications SET status=$1, reason=$2, decided_at=now() WHERE id=$3", [
        status,
        req.body.reason || null,
        app.id,
      ]);

      let store = null;
      if (status === "approved") {
        await client.query("UPDATE users SET role = 'merchant' WHERE id = $1", [app.user_id]);
        const storeRes = await client.query(
          "INSERT INTO stores (merchant_id, name, description) VALUES ($1,$2,$3) RETURNING *",
          [app.user_id, app.business_name, `Storefront for ${app.business_name}`]
        );
        store = storeRes.rows[0];
      }

      await notify(
        app.user_id,
        "merchant_decision",
        status === "approved" ? "Your merchant application was approved!" : "Your merchant application was declined",
        req.body.reason || (status === "approved" ? "You can now create products." : undefined)
      );
      await audit(req.user.id, "merchant.decision", "merchant_application", app.id, { status, reason: req.body.reason });

      return { application: { ...app, status }, store };
    });
    res.json(result);
  })
);

router.get(
  "/stores/mine",
  requireAuth(),
  requireRole("merchant", "admin", "super_admin"),
  asyncHandler(async (req, res) => {
    if (["admin", "super_admin"].includes(req.user.role)) {
      const params = [];
      const conds = [];
      if (req.query.storeId) { params.push(req.query.storeId); conds.push(`id = $${params.length}`); }
      if (req.user.role === "admin") { params.push(req.user.university_id); conds.push(`university_id = $${params.length}`); }
      const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
      const { rows } = await db.query(`SELECT * FROM stores ${where} ORDER BY created_at DESC LIMIT 1`, params);
      if (!rows[0]) throw notFound("No store found");
      return res.json({ store: rows[0] });
    }
    const { rows } = await db.query("SELECT * FROM stores WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 1", [req.user.id]);
    if (!rows[0]) throw notFound("No store found for this merchant yet");
    res.json({ store: rows[0] });
  })
);

router.patch(
  "/stores/mine",
  requireAuth(),
  requireRole("merchant"),
  validate({
    body: z.object({
      name: z.string().min(2).optional(),
      description: z.string().optional(),
      logoUrl: z.string().optional(),
      coverImageUrl: z.string().optional(),
      category: z.string().optional(),
      publicEmail: z.union([z.string().email(), z.literal("")]).optional(),
      publicPhone: z.string().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    // Nullable text fields use CASE so that: omitted (undefined -> NULL) keeps
    // the current value, while an explicit empty string clears the field. This
    // is what lets "remove cover image" work without a separate endpoint.
    const { rows } = await db.query(
      `UPDATE stores SET
         name            = COALESCE($1, name),
         description     = CASE WHEN $2::text IS NULL THEN description     ELSE NULLIF($2,'') END,
         logo_url        = CASE WHEN $3::text IS NULL THEN logo_url        ELSE NULLIF($3,'') END,
         cover_image_url = CASE WHEN $4::text IS NULL THEN cover_image_url ELSE NULLIF($4,'') END,
         category        = CASE WHEN $5::text IS NULL THEN category        ELSE NULLIF($5,'') END,
         public_email    = CASE WHEN $6::text IS NULL THEN public_email    ELSE NULLIF($6,'') END,
         public_phone    = CASE WHEN $7::text IS NULL THEN public_phone    ELSE NULLIF($7,'') END
       WHERE merchant_id = $8 RETURNING *`,
      [
        req.body.name,
        req.body.description,
        req.body.logoUrl,
        req.body.coverImageUrl,
        req.body.category,
        req.body.publicEmail,
        req.body.publicPhone,
        req.user.id,
      ]
    );
    if (!rows[0]) throw notFound("No store found for this merchant yet");
    res.json({ store: rows[0] });
  })
);

// FR-037 — sales analytics (merchant sees their own store; admin can view any)
router.get(
  "/:storeId/analytics",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const { rows: storeRows } = await db.query("SELECT * FROM stores WHERE id = $1", [req.params.storeId]);
    const store = storeRows[0];
    if (!store) throw notFound("Store not found");
    if (req.user.role !== "admin" && store.merchant_id !== req.user.id) throw forbidden();

    const totals = await db.query(
      `SELECT COUNT(*) FILTER (WHERE status <> 'cancelled') AS order_count,
              COALESCE(SUM(total_amount) FILTER (WHERE status = 'completed'), 0) AS revenue
       FROM orders WHERE store_id = $1`,
      [store.id]
    );
    const topProducts = await db.query(
      `SELECT p.id, p.title, COALESCE(SUM(oi.quantity),0) AS units_sold
       FROM products p
       LEFT JOIN order_items oi ON oi.product_id = p.id
       LEFT JOIN orders o ON o.id = oi.order_id AND o.status = 'completed'
       WHERE p.store_id = $1
       GROUP BY p.id, p.title ORDER BY units_sold DESC LIMIT 5`,
      [store.id]
    );
    res.json({
      orderCount: Number(totals.rows[0].order_count),
      revenue: Number(totals.rows[0].revenue),
      topProducts: topProducts.rows.map((r) => ({ ...r, units_sold: Number(r.units_sold) })),
    });
  })
);

// Phase 2 — merchant order export (companion to the admin export above).
router.get(
  "/:storeId/orders/export",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const { rows: storeRows } = await db.query("SELECT * FROM stores WHERE id = $1", [req.params.storeId]);
    const store = storeRows[0];
    if (!store) throw notFound("Store not found");
    assertSameTenant(req, store.university_id, "Store");
    if (!["admin", "super_admin"].includes(req.user.role) && store.merchant_id !== req.user.id) throw forbidden();

    const { rows } = await db.query(
      `SELECT o.id, o.status, o.total_amount, o.created_at, u.name AS buyer_name, u.email AS buyer_email
       FROM orders o JOIN users u ON u.id = o.buyer_id WHERE o.store_id = $1 ORDER BY o.created_at DESC`,
      [store.id]
    );
    const csv = toCsv(rows, [
      { label: "Order ID", value: "id" }, { label: "Status", value: "status" },
      { label: "Total", value: "total_amount" }, { label: "Buyer", value: "buyer_name" },
      { label: "Buyer Email", value: "buyer_email" }, { label: "Created At", value: "created_at" },
    ]);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${store.name.replace(/[^a-z0-9]/gi, "_")}_orders.csv"`);
    res.send(csv);
  })
);

module.exports = router;
