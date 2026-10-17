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

// --- CampusHub Official Receiving Accounts Configuration ---
const RECEIVING_METHODS = ["cbe", "telebirr", "awash", "dashen", "abyssinia", "other"];
const receivingBody = z.object({
  method: z.enum(RECEIVING_METHODS),
  accountName: z.string().trim().min(2).max(80),
  accountNumber: z.string().trim().min(4).max(40),
  instructions: z.string().trim().max(300).optional(),
  isDefault: z.boolean().optional(),
});

router.get(
  "/receiving-accounts",
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT * FROM payout_accounts
        WHERE ($1::uuid IS NULL OR university_id = $1) AND is_campus_hub = true AND active
        ORDER BY is_default DESC, created_at`,
      [req.tenant.universityId]
    );
    res.json({ accounts: rows });
  })
);

router.post(
  "/receiving-accounts",
  validate({ body: receivingBody }),
  asyncHandler(async (req, res) => {
    const uniId = req.tenant.universityId || req.user.university_id;
    if (!uniId) throw badRequest("university_id is required");
    const b = req.body;

    const account = await db.withTransaction(async (client) => {
      const makeDefault = b.isDefault === true;
      if (makeDefault) {
        await client.query(
          "UPDATE payout_accounts SET is_default = false WHERE university_id = $1 AND is_campus_hub = true",
          [uniId]
        );
      }
      const { rows } = await client.query(
        `INSERT INTO payout_accounts (university_id, owner_id, method, account_name, account_number, instructions, is_default, is_campus_hub, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,true,true) RETURNING *`,
        [uniId, req.user.id, b.method, b.accountName, b.accountNumber, b.instructions || null, makeDefault]
      );
      return rows[0];
    });

    await audit(req.user.id, "receiving_account.create", "payout_account", account.id, {
      universityId: uniId, method: account.method,
    });
    res.status(201).json({ account });
  })
);

router.patch(
  "/receiving-accounts/:id",
  validate({ body: receivingBody.partial() }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const account = await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        "SELECT * FROM payout_accounts WHERE id = $1 AND is_campus_hub = true AND active FOR UPDATE",
        [req.params.id]
      );
      const acc = rows[0];
      if (!acc) throw notFound("Receiving account not found");
      assertSameTenant(req, acc.university_id, "Receiving account");

      if (b.isDefault === true) {
        await client.query(
          "UPDATE payout_accounts SET is_default = false WHERE university_id = $1 AND is_campus_hub = true",
          [acc.university_id]
        );
      }

      const upd = await client.query(
        `UPDATE payout_accounts SET
           method = COALESCE($2, method), account_name = COALESCE($3, account_name),
           account_number = COALESCE($4, account_number), is_default = COALESCE($5, is_default),
           instructions = COALESCE($6, instructions)
         WHERE id = $1 RETURNING *`,
        [req.params.id, b.method ?? null, b.accountName ?? null, b.accountNumber ?? null, b.isDefault ?? null, b.instructions ?? null]
      );
      return upd.rows[0];
    });

    await audit(req.user.id, "receiving_account.update", "payout_account", account.id, null);
    res.json({ account });
  })
);

router.delete(
  "/receiving-accounts/:id",
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      "SELECT * FROM payout_accounts WHERE id = $1 AND is_campus_hub = true AND active",
      [req.params.id]
    );
    if (!rows[0]) throw notFound("Receiving account not found");
    assertSameTenant(req, rows[0].university_id, "Receiving account");
    await db.query("UPDATE payout_accounts SET active = false, is_default = false WHERE id = $1", [req.params.id]);
    await audit(req.user.id, "receiving_account.delete", "payout_account", req.params.id, null);
    res.json({ ok: true });
  })
);

// --- Event Ticket Payments Review Queue (Admin Only) ---
router.get(
  "/events/tickets/pending",
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT p.id AS payment_id, p.amount, p.status AS payment_status, p.created_at AS payment_date,
              pr.id AS proof_id, pr.reference_number, pr.file_name, pr.created_at AS proof_date,
              t.id AS ticket_id, t.status AS ticket_status,
              e.id AS event_id, e.title AS event_title, e.date_time AS event_date,
              tt.name AS ticket_type, tt.price,
              u.id AS student_id, u.name AS student_name, u.email AS student_email,
              org.id AS organizer_id, org.name AS organizer_name,
              ROUND((p.amount * 0.025), 2) AS commission_amount,
              ROUND(p.amount - ROUND(p.amount * 0.025, 2), 2) AS organizer_payable
         FROM payments p
         JOIN tickets t ON t.id = p.transaction_id
         JOIN events e ON e.id = t.event_id
         JOIN clubs c ON c.id = e.club_id
         JOIN users org ON org.id = c.lead_user_id
         JOIN users u ON u.id = p.payer_id
         JOIN ticket_types tt ON tt.id = t.ticket_type_id
         LEFT JOIN LATERAL (
           SELECT id, reference_number, file_name, created_at
             FROM payment_proofs WHERE payment_id = p.id AND status = 'submitted'
            ORDER BY created_at DESC LIMIT 1
         ) pr ON true
        WHERE p.transaction_type = 'ticket'
          AND p.status = 'under_review'
          AND ($1::uuid IS NULL OR p.university_id = $1)
        ORDER BY p.created_at DESC`,
      [req.tenant.universityId]
    );
    res.json({ tickets: rows, pendingPayments: rows });
  })
);

// --- Event Organizer Payouts Management ---
router.get(
  "/payouts/organizers",
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT org.id AS organizer_id, org.name AS organizer_name, org.email AS organizer_email,
              COUNT(p.id)::int AS tickets_sold,
              COALESCE(SUM(p.amount), 0)::float AS total_ticket_revenue,
              COALESCE(SUM(ROUND(p.amount * 0.025, 2)), 0)::float AS commission_earned,
              COALESCE(SUM(ROUND(p.amount - ROUND(p.amount * 0.025, 2), 2)), 0)::float AS organizer_amount_owed,
              COALESCE((
                SELECT SUM(op.amount) FROM organizer_payouts op
                 WHERE op.organizer_id = org.id AND op.status = 'completed'
              ), 0)::float AS amount_paid
         FROM users org
         JOIN clubs c ON c.lead_user_id = org.id
         JOIN events e ON e.club_id = c.id
         JOIN tickets t ON t.event_id = e.id
         JOIN payments p ON p.transaction_id = t.id AND p.transaction_type = 'ticket' AND p.status = 'confirmed'
        WHERE ($1::uuid IS NULL OR e.university_id = $1)
          AND t.status IN ('active', 'used')
          AND e.status <> 'cancelled'
        GROUP BY org.id, org.name, org.email
        ORDER BY (COALESCE(SUM(ROUND(p.amount - ROUND(p.amount * 0.025, 2), 2)), 0) - COALESCE((
          SELECT SUM(op.amount) FROM organizer_payouts op WHERE op.organizer_id = org.id AND op.status = 'completed'
        ), 0)) DESC`,
      [req.tenant.universityId]
    );

    const organizers = rows.map((r) => {
      const netPayable = Math.round(r.organizer_amount_owed * 100) / 100;
      const paidOut = Math.round(r.amount_paid * 100) / 100;
      const currentBalance = Math.max(0, Math.round((netPayable - paidOut) * 100) / 100);
      return {
        ...r,
        total_sales: r.total_ticket_revenue,
        platform_commission: r.commission_earned,
        net_payable: netPayable,
        paid_out: paidOut,
        current_balance: currentBalance,
        remainingOwed: currentBalance,
      };
    });
    res.json({ organizers });
  })
);

router.post(
  "/payouts/organizers/:organizerId",
  validate({
    body: z.object({
      amount: z.number().positive(),
      referenceNumber: z.string().trim().min(3),
      notes: z.string().optional(),
      eventId: z.string().uuid().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { amount, referenceNumber, notes, eventId } = req.body;
    const normRef = referenceNumber.trim();

    if (!Number.isFinite(amount) || amount <= 0) {
      throw badRequest("Enter a valid positive payout amount", "INVALID_AMOUNT");
    }

    const payout = await db.withTransaction(async (client) => {
      // 1. Lock organizer record row to prevent concurrent race conditions on payout calculation
      const { rows: orgRows } = await client.query(
        "SELECT id, name, email, university_id FROM users WHERE id = $1 AND ($2::uuid IS NULL OR university_id = $2) FOR UPDATE",
        [req.params.organizerId, req.tenant.universityId]
      );
      const organizer = orgRows[0];
      if (!organizer) throw notFound("Organizer not found");

      // FIX 2: Authoritative university determination
      const targetUniId = organizer.university_id;
      if (!targetUniId) {
        throw badRequest("Organizer is not associated with any university", "NO_ORGANIZER_UNIVERSITY");
      }
      if (req.user.role !== "super_admin" && req.user.university_id !== targetUniId) {
        throw forbidden("Not authorized for this university's payouts");
      }

      // 2. Check for duplicate completed payout reference
      const { rows: existingRef } = await client.query(
        "SELECT id FROM organizer_payouts WHERE university_id = $1 AND lower(trim(reference_number)) = lower($2) AND status = 'completed'",
        [targetUniId, normRef]
      );
      if (existingRef.length > 0) {
        throw conflict("A payout with this transfer reference has already been recorded", "DUPLICATE_TRANSFER_REFERENCE");
      }

      // 3. Calculate organizer's net payable from confirmed uncancelled tickets for published/completed events
      // (Collected ticket amount minus rounded 2.5% platform commission)
      const { rows: revRows } = await client.query(
        `SELECT COALESCE(SUM(ROUND(p.amount - ROUND(p.amount * 0.025, 2), 2)), 0)::numeric(12,2) AS total_payable
           FROM tickets t
           JOIN events e ON e.id = t.event_id
           JOIN clubs c ON c.id = e.club_id
           JOIN payments p ON p.transaction_id = t.id AND p.transaction_type = 'ticket' AND p.status = 'confirmed'
          WHERE c.lead_user_id = $1
            AND e.university_id = $2
            AND t.status IN ('active', 'used')
            AND e.status <> 'cancelled'`,
        [organizer.id, targetUniId]
      );
      const totalPayable = Number(revRows[0]?.total_payable || 0);

      // 4. Calculate total previously completed payouts for this organizer and university
      const { rows: paidRows } = await client.query(
        `SELECT COALESCE(SUM(amount), 0)::numeric(12,2) AS total_paid
           FROM organizer_payouts
          WHERE organizer_id = $1 AND status = 'completed' AND university_id = $2`,
        [organizer.id, targetUniId]
      );
      const totalPaid = Number(paidRows[0]?.total_paid || 0);
      const currentBalance = Math.max(0, Math.round((totalPayable - totalPaid) * 100) / 100);

      if (currentBalance <= 0) {
        throw conflict("Organizer has no outstanding balance owed", "NO_OUTSTANDING_BALANCE");
      }

      const requestedAmount = Math.round(amount * 100) / 100;
      if (requestedAmount > currentBalance) {
        throw badRequest(
          `Payout amount (${requestedAmount.toFixed(2)} birr) exceeds outstanding balance of ${currentBalance.toFixed(2)} birr`,
          "EXCESSIVE_PAYOUT"
        );
      }

      // 5. Insert completed payout record with normalized reference and non-null university_id
      let inserted;
      try {
        const insertRes = await client.query(
          `INSERT INTO organizer_payouts
             (university_id, organizer_id, event_id, amount, status, reference_number, notes, recorded_by, created_at, completed_at)
           VALUES ($1, $2, $3, $4, 'completed', $5, $6, $7, now(), now())
           RETURNING *`,
          [targetUniId, organizer.id, eventId || null, requestedAmount, normRef, notes || null, req.user.id]
        );
        inserted = insertRes.rows[0];
      } catch (insertErr) {
        if (insertErr.code === "23505" && String(insertErr.constraint || insertErr.message || "").toLowerCase().includes("organizer_payouts")) {
          throw conflict("A payout with this transfer reference has already been recorded", "DUPLICATE_TRANSFER_REFERENCE");
        }
        throw insertErr;
      }

      return { payout: inserted, organizer, remainingBalance: Math.round((currentBalance - requestedAmount) * 100) / 100 };
    });

    await audit(req.user.id, "organizer_payout.recorded", "organizer_payout", payout.payout.id, {
      organizerId: payout.organizer.id, amount, referenceNumber: normRef,
    });

    await notify(
      payout.organizer.id,
      "payout_update",
      "Organizer payout confirmed",
      `A payout of ${amount.toFixed(2)} birr has been recorded (Reference: ${normRef}).`
    );

    res.status(201).json({ payout: payout.payout, remainingBalance: payout.remainingBalance });
  })
);

router.get(
  "/payouts/history",
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT op.*, u.name AS organizer_name, u.email AS organizer_email, admin.name AS recorded_by_name
         FROM organizer_payouts op
         JOIN users u ON u.id = op.organizer_id
         JOIN users admin ON admin.id = op.recorded_by
        WHERE ($1::uuid IS NULL OR op.university_id = $1)
        ORDER BY op.created_at DESC LIMIT 100`,
      [req.tenant.universityId]
    );
    res.json({ payouts: rows });
  })
);

module.exports = router;
