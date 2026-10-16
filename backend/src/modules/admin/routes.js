const express = require("express");
const { z } = require("zod");
const db = require("../../db");
const { requireAuth, requireRole } = require("../../middleware/auth");
const { validate } = require("../../middleware/validate");
const { asyncHandler, notFound, conflict, badRequest } = require("../../utils/errors");
const { notify, audit } = require("../../utils/notify");
const { toCsv } = require("../../utils/csv");

const { scopeTo, assertSameTenant } = require("../../middleware/tenant");
const router = express.Router();
router.use(requireAuth(), requireRole("admin", "super_admin"));

// Phase 2 — "full reporting suite" (SRS Phase 2 spec, item G): CSV exports so an
// admin can take data out of the dashboard, not just view it. Phase 3: every
// export is scoped to the caller's university (a super admin without
// X-University-Id gets the cross-campus export).
router.get(
  "/reports/export",
  asyncHandler(async (req, res) => {
    const type = req.query.type || "orders";
    const T = [req.tenant.universityId];
    let rows, columns, filename;

    if (type === "orders") {
      const result = await db.query(
        `SELECT o.id, o.status, o.total_amount, o.created_at, s.name AS store_name, u.name AS buyer_name, u.email AS buyer_email
         FROM orders o JOIN stores s ON s.id=o.store_id JOIN users u ON u.id=o.buyer_id
         WHERE ($1::uuid IS NULL OR o.university_id = $1) ORDER BY o.created_at DESC`,
        T
      );
      rows = result.rows;
      columns = [
        { label: "Order ID", value: "id" }, { label: "Status", value: "status" },
        { label: "Total", value: "total_amount" }, { label: "Store", value: "store_name" },
        { label: "Buyer", value: "buyer_name" }, { label: "Buyer Email", value: "buyer_email" },
        { label: "Created At", value: "created_at" },
      ];
      filename = "orders.csv";
    } else if (type === "transactions") {
      const result = await db.query(
        `SELECT t.id, t.type, t.amount, t.created_at, p.transaction_type AS payment_for, p.provider, p.status AS payment_status
         FROM transactions t JOIN payments p ON p.id = t.payment_id
         WHERE ($1::uuid IS NULL OR p.university_id = $1) ORDER BY t.created_at DESC`,
        T
      );
      rows = result.rows;
      columns = [
        { label: "Transaction ID", value: "id" }, { label: "Type", value: "type" },
        { label: "Amount", value: "amount" }, { label: "Payment For", value: "payment_for" },
        { label: "Provider", value: "provider" }, { label: "Payment Status", value: "payment_status" },
        { label: "Created At", value: "created_at" },
      ];
      filename = "transactions.csv";
    } else if (type === "users") {
      const result = await db.query(
        `SELECT id, name, email, role, university_id, verified, suspended, created_at FROM users
         WHERE ($1::uuid IS NULL OR university_id = $1) ORDER BY created_at DESC`,
        T
      );
      rows = result.rows;
      columns = [
        { label: "User ID", value: "id" }, { label: "Name", value: "name" }, { label: "Email", value: "email" },
        { label: "Role", value: "role" }, { label: "University ID", value: "university_id" },
        { label: "Verified", value: "verified" }, { label: "Suspended", value: "suspended" },
        { label: "Created At", value: "created_at" },
      ];
      filename = "users.csv";
    } else {
      throw badRequest(`Unknown export type "${type}" — expected orders, transactions, or users`);
    }

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(toCsv(rows, columns));
  })
);

// Section 15 — read access to the append-only audit log (writes happen
// throughout the codebase via src/utils/notify.js `audit()`).
router.get(
  "/audit-logs",
  asyncHandler(async (req, res) => {
    const { targetType, actorId, page = "1" } = req.query;
    const limit = 50;
    const offset = (Math.max(1, Number(page)) - 1) * limit;
    const conditions = [];
    const params = [];
    if (targetType) {
      params.push(targetType);
      conditions.push(`a.target_type = $${params.length}`);
    }
    if (actorId) {
      params.push(actorId);
      conditions.push(`a.actor_id = $${params.length}`);
    }
    scopeTo(req, "a.university_id", conditions, params);
    params.push(limit, offset);
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await db.query(
      `SELECT a.*, u.name AS actor_name, u.email AS actor_email
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
       ${where} ORDER BY a.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ logs: rows });
  })
);

// FR-043 — platform analytics
router.get(
  "/analytics",
  asyncHandler(async (req, res) => {
    const T = [req.tenant.universityId];
    const [users, merchants, orders, tickets, bookings, listings] = await Promise.all([
      db.query("SELECT role, COUNT(*) FROM users WHERE ($1::uuid IS NULL OR university_id = $1) GROUP BY role", T),
      db.query("SELECT COUNT(*) FROM stores WHERE ($1::uuid IS NULL OR university_id = $1)", T),
      db.query("SELECT COUNT(*) AS n, COALESCE(SUM(total_amount) FILTER (WHERE status='completed'),0) AS revenue FROM orders WHERE ($1::uuid IS NULL OR university_id = $1)", T),
      db.query("SELECT COUNT(*) FROM tickets t JOIN events e ON e.id = t.event_id WHERE t.status IN ('active','used') AND ($1::uuid IS NULL OR e.university_id = $1)", T),
      db.query("SELECT COUNT(*) FROM rental_bookings b JOIN rental_items r ON r.id = b.rental_item_id WHERE b.status <> 'cancelled' AND ($1::uuid IS NULL OR r.university_id = $1)", T),
      db.query("SELECT COUNT(*) FROM p2p_listings WHERE status = 'active' AND ($1::uuid IS NULL OR university_id = $1)", T),
    ]);
    res.json({
      usersByRole: Object.fromEntries(users.rows.map((r) => [r.role, Number(r.count)])),
      storeCount: Number(merchants.rows[0].count),
      orders: { count: Number(orders.rows[0].n), completedRevenue: Number(orders.rows[0].revenue) },
      activeTickets: Number(tickets.rows[0].count),
      activeBookings: Number(bookings.rows[0].count),
      activeListings: Number(listings.rows[0].count),
    });
  })
);

// Supporting endpoint: list events awaiting admin decision (FR-040 needs a
// queue to decide from, same idea as the merchant-applications queue above).
router.get(
  "/events",
  asyncHandler(async (req, res) => {
    const status = req.query.status || "pending_review";
    const { rows } = await db.query(
      `SELECT e.*, c.name AS club_name FROM events e JOIN clubs c ON c.id = e.club_id
       WHERE ($1::text IS NULL OR e.status = $1) AND ($2::uuid IS NULL OR e.university_id = $2) ORDER BY e.created_at DESC`,
      [status === "all" ? null : status, req.tenant.universityId]
    );
    res.json({ events: rows });
  })
);

// FR-041 / FR-044 — reports & disputes queue
router.get(
  "/reports",
  asyncHandler(async (req, res) => {
    const status = req.query.status || "open";
    const { rows } = await db.query(
      `SELECT r.*, u.name AS reporter_name FROM reports r JOIN users u ON u.id = r.reporter_id
       WHERE ($1::text IS NULL OR r.status = $1) AND ($2::uuid IS NULL OR r.university_id = $2) ORDER BY r.created_at DESC`,
      [status === "all" ? null : status, req.tenant.universityId]
    );
    const disputes = await db.query(
      `SELECT d.*, u.name AS raised_by_name, ri.title FROM disputes d
       JOIN users u ON u.id = d.raised_by
       JOIN rental_bookings b ON b.id = d.booking_id JOIN rental_items ri ON ri.id = b.rental_item_id
       WHERE ($1::text IS NULL OR d.status = $1) AND ($2::uuid IS NULL OR d.university_id = $2) ORDER BY d.created_at DESC`,
      [status === "all" ? null : status, req.tenant.universityId]
    );
    res.json({ reports: rows, disputes: disputes.rows });
  })
);

router.patch(
  "/reports/:id/resolve",
  validate({
    body: z.object({
      resolution: z.string().min(2),
      action: z.enum(["remove_listing", "warn", "suspend", "refund", "dismiss"]),
      notes: z.string().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query("SELECT * FROM reports WHERE id = $1", [req.params.id]);
    const report = rows[0];
    if (!report) throw notFound("Report not found");
    assertSameTenant(req, report.university_id, "Report");
    if (report.status !== "open") throw conflict("This report has already been resolved");

    if (req.body.action === "remove_listing") {
      // Scoped to the report's own university: a report can name any UUID, so the
      // target must also belong to that tenant or the action is a no-op.
      if (report.target_type === "product") {
        await db.query("UPDATE products SET status = 'removed' WHERE id = $1 AND store_id IN (SELECT id FROM stores WHERE university_id = $2)", [report.target_id, report.university_id]);
      } else if (report.target_type === "listing") {
        await db.query("UPDATE p2p_listings SET status = 'removed' WHERE id = $1 AND university_id = $2", [report.target_id, report.university_id]);
      }
    }
    if (req.body.action === "suspend" && report.target_type === "user") {
      await db.query("UPDATE users SET suspended = true WHERE id = $1 AND university_id = $2 AND role <> 'super_admin'", [report.target_id, report.university_id]);
    }

    const status = req.body.action === "dismiss" ? "dismissed" : "resolved";
    await db.query("UPDATE reports SET status=$1, resolution=$2 WHERE id=$3", [status, req.body.resolution, report.id]);
    await notify(report.reporter_id, "report_update", "Your report was reviewed", `Action taken: ${req.body.action}`);
    await audit(req.user.id, "report.resolve", report.target_type, report.target_id, { action: req.body.action, notes: req.body.notes });
    res.json({ success: true });
  })
);

router.patch(
  "/disputes/:id/resolve",
  validate({ body: z.object({ resolution: z.string().min(2) }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query("SELECT * FROM disputes WHERE id = $1", [req.params.id]);
    if (!rows[0]) throw notFound("Dispute not found");
    assertSameTenant(req, rows[0].university_id, "Dispute");
    await db.query("UPDATE disputes SET status='resolved', resolution=$1 WHERE id=$2", [req.body.resolution, req.params.id]);
    await audit(req.user.id, "dispute.resolve", "dispute", req.params.id, { resolution: req.body.resolution });
    res.json({ success: true });
  })
);

// FR-041 — moderate a listing/product directly (not just via a report)
router.patch(
  "/moderate",
  validate({
    body: z.object({
      targetType: z.enum(["product", "listing"]),
      targetId: z.string().uuid(),
      action: z.enum(["remove", "restore"]),
    }),
  }),
  asyncHandler(async (req, res) => {
    const table = req.body.targetType === "product" ? "products" : "p2p_listings";
    const status = req.body.action === "remove" ? "removed" : "active";
    const scope = req.body.targetType === "product" ? "store_id IN (SELECT id FROM stores WHERE ($3::uuid IS NULL OR university_id = $3))" : "($3::uuid IS NULL OR university_id = $3)";
    const { rows } = await db.query(`UPDATE ${table} SET status = $1 WHERE id = $2 AND ${scope} RETURNING *`, [status, req.body.targetId, req.tenant.universityId]);
    if (!rows[0]) throw notFound("Target not found");
    await audit(req.user.id, "content.moderate", req.body.targetType, req.body.targetId, { action: req.body.action });
    res.json({ success: true, item: rows[0] });
  })
);

// FR-042 / FR-046 — manage users & roles
router.get(
  "/users",
  asyncHandler(async (req, res) => {
    const { q, role } = req.query;
    const conditions = [];
    const params = [];
    if (q) {
      params.push(`%${q}%`);
      conditions.push(`(name ILIKE $${params.length} OR email ILIKE $${params.length})`);
    }
    if (role) {
      params.push(role);
      conditions.push(`role = $${params.length}`);
    }
    scopeTo(req, "university_id", conditions, params);
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await db.query(
      `SELECT id, name, email, role, university_id, verified, suspended, created_at FROM users ${where} ORDER BY created_at DESC LIMIT 100`,
      params
    );
    res.json({ users: rows });
  })
);

router.get(
  "/users/:id",
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT u.id, u.name, u.email, u.phone, u.role, u.university_id, u.verified, u.verification_method,
              u.avatar_url, u.cover_image_url, u.bio, u.department, u.year,
              u.privacy_settings, u.notification_prefs, u.email_verified, u.suspended, u.created_at,
              uni.name AS university_name
       FROM users u
       LEFT JOIN universities uni ON uni.id = u.university_id
       WHERE u.id = $1 AND ($2::uuid IS NULL OR u.university_id = $2)`,
      [req.params.id, req.tenant.universityId]
    );
    const user = rows[0];
    if (!user) throw notFound("User not found");

    const [reportsRes, verifRes, ordersCount, listingsCount] = await Promise.all([
      db.query("SELECT * FROM reports WHERE target_type = 'user' AND target_id = $1 ORDER BY created_at DESC LIMIT 5", [user.id]),
      db.query("SELECT * FROM verification_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1", [user.id]),
      db.query("SELECT count(*)::int AS count FROM orders WHERE buyer_id = $1", [user.id]),
      db.query("SELECT count(*)::int AS count FROM p2p_listings WHERE seller_id = $1", [user.id]),
    ]);

    res.json({
      user,
      recentReports: reportsRes.rows,
      verificationRequest: verifRes.rows[0] || null,
      activity: {
        ordersCount: ordersCount.rows[0]?.count || 0,
        listingsCount: listingsCount.rows[0]?.count || 0,
      },
    });
  })
);

router.patch(
  "/users/:id",
  validate({
    body: z.object({
      role: z.enum(["student", "merchant", "organizer", "admin"]).optional(),
      verified: z.boolean().optional(),
      suspended: z.boolean().optional(),
      clearAvatar: z.boolean().optional(),
      clearCover: z.boolean().optional(),
      clearBio: z.boolean().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    if (req.body.role === "admin") {
      // Mirrors SRS FR-042 alt flow: elevating to the highest available role
      // in this deployment needs a distinct approval step, not a routine PATCH.
      throw badRequest("Promoting a user to admin requires a Super Administrator (POST /api/super/admins/promote).");
    }

    const { role, verified, suspended, clearAvatar, clearCover, clearBio } = req.body;
    const existing = await db.query(
      "SELECT * FROM users WHERE id = $1 AND role NOT IN ('super_admin') AND ($2::uuid IS NULL OR university_id = $2)",
      [req.params.id, req.tenant.universityId]
    );
    if (!existing.rows[0]) throw notFound("User not found");

    const updates = [];
    const values = [];

    if (role !== undefined) {
      values.push(role);
      updates.push(`role = $${values.length}`);
    }
    if (verified !== undefined) {
      values.push(verified);
      updates.push(`verified = $${values.length}`);
    }
    if (suspended !== undefined) {
      values.push(suspended);
      updates.push(`suspended = $${values.length}`);
    }
    if (clearAvatar) {
      updates.push(`avatar_url = NULL`);
    }
    if (clearCover) {
      updates.push(`cover_image_url = NULL`);
    }
    if (clearBio) {
      updates.push(`bio = NULL`);
    }

    if (updates.length > 0) {
      values.push(req.params.id);
      values.push(req.tenant.universityId);
      const { rows } = await db.query(
        `UPDATE users SET ${updates.join(", ")}
         WHERE id = $${values.length - 1} AND role NOT IN ('super_admin') AND ($${values.length}::uuid IS NULL OR university_id = $${values.length})
         RETURNING id, name, email, role, verified, suspended, avatar_url, cover_image_url, bio`,
        values
      );
      await audit(req.user.id, "user.update", "user", req.params.id, req.body);
      return res.json({ user: rows[0] });
    }

    res.json({ user: existing.rows[0] });
  })
);

// Club registry (supporting FR-024's "approved club" precondition)
router.post(
  "/clubs",
  validate({ body: z.object({ name: z.string().min(2), leadUserId: z.string().uuid(), universityId: z.string().uuid().optional() }) }),
  asyncHandler(async (req, res) => {
    const uniId = req.tenant.universityId || req.body.universityId;
    if (!uniId) throw badRequest("universityId is required (send X-University-Id or include it in the body)");
    if (req.tenant.universityId && req.body.universityId && req.body.universityId !== req.tenant.universityId) {
      throw badRequest("universityId does not match your university");
    }
    // The club lead must belong to the same university as the club.
    const lead = await db.query("SELECT 1 FROM users WHERE id = $1 AND university_id = $2", [req.body.leadUserId, uniId]);
    if (!lead.rows.length) throw notFound("Lead user not found in this university");
    await db.query("UPDATE users SET role = 'organizer' WHERE id = $1", [req.body.leadUserId]);
    const { rows } = await db.query(
      "INSERT INTO clubs (university_id, name, lead_user_id, status) VALUES ($1,$2,$3,'active') RETURNING *",
      [uniId, req.body.name, req.body.leadUserId]
    );
    res.status(201).json({ club: rows[0] });
  })
);

router.get(
  "/clubs",
  asyncHandler(async (req, res) => {
    const { rows } = await db.query("SELECT c.*, u.name AS lead_name FROM clubs c JOIN users u ON u.id=c.lead_user_id WHERE ($1::uuid IS NULL OR c.university_id = $1) ORDER BY c.created_at DESC", [req.tenant.universityId]);
    res.json({ clubs: rows });
  })
);

module.exports = router;
