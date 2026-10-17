// Phase 3 — Super Administrator API (SRS Section 7, role defined in Phase 1,
// fully implemented here): university onboarding, cross-university config,
// fee schedules, admin account management, and cross-campus analytics.
// Everything here is cross-tenant by design, so it is gated to super_admin only
// and every mutation is written to the audit log.
const express = require("express");
const { z } = require("zod");
const db = require("../../db");
const { requireAuth, requireRole } = require("../../middleware/auth");
const { validate } = require("../../middleware/validate");
const { asyncHandler, notFound, conflict, badRequest } = require("../../utils/errors");
const { hashPassword } = require("../../utils/hash");
const { audit } = require("../../utils/notify");

const router = express.Router();
router.use(requireAuth(), requireRole("super_admin"));

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const domainRe = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

// ------------------------------------------------------------------
// Universities (tenants)
// ------------------------------------------------------------------
router.get(
  "/universities",
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT u.*,
              (SELECT count(*) FROM users WHERE university_id = u.id)::int AS user_count,
              (SELECT count(*) FROM users WHERE university_id = u.id AND role = 'admin')::int AS admin_count
         FROM universities u ORDER BY u.created_at`
    );
    res.json({ universities: rows });
  })
);

router.get(
  "/universities/:id",
  asyncHandler(async (req, res) => {
    const { rows } = await db.query("SELECT * FROM universities WHERE id = $1", [req.params.id]);
    if (!rows[0]) throw notFound("University not found");
    const admins = await db.query(
      "SELECT id, name, email, suspended FROM users WHERE university_id = $1 AND role = 'admin' ORDER BY created_at",
      [req.params.id]
    );
    res.json({ university: rows[0], admins: admins.rows });
  })
);

// University onboarding workflow: one atomic call creates the tenant, its
// first University Administrator and (optionally) its initial clubs — no
// engineering involvement. Merchants onboard themselves through the normal
// merchant-application flow, which the new admin then approves.
router.post(
  "/universities",
  validate({
    body: z.object({
      name: z.string().min(2),
      domain: z.string().regex(domainRe, "Must look like campus.edu.et").optional(),
      permittedDomains: z.array(z.string().regex(domainRe)).optional(),
      slug: z.string().regex(/^[a-z0-9-]{2,60}$/).optional(),
      featureFlags: z.record(z.string(), z.boolean()).optional(),
      admin: z.object({ name: z.string().min(2), email: z.string().email(), password: z.string().min(8), phone: z.string().optional() }),
      initialClubs: z.array(z.string().min(2)).max(50).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { name, domain, permittedDomains, featureFlags, admin, initialClubs } = req.body;
    const slug = req.body.slug || slugify(name);

    const dupEmail = await db.query("SELECT 1 FROM users WHERE email = $1", [admin.email.toLowerCase()]);
    if (dupEmail.rows.length) throw conflict("An account with the admin's email already exists", "EMAIL_TAKEN");

    const resolvedPermitted = permittedDomains && permittedDomains.length
      ? permittedDomains.map((d) => d.toLowerCase())
      : domain
      ? [domain.toLowerCase()]
      : [];

    const passwordHash = await hashPassword(admin.password);
    const result = await db.withTransaction(async (client) => {
      let uni;
      try {
        const r = await client.query(
          `INSERT INTO universities (name, domain, permitted_domains, slug, feature_flags)
           VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [name, domain ? domain.toLowerCase() : null, resolvedPermitted, slug, JSON.stringify(featureFlags || {})]
        );
        uni = r.rows[0];
      } catch (e) {
        if (e.code === "23505") throw conflict("A university with that slug or domain already exists", "UNIVERSITY_EXISTS");
        throw e;
      }
      const a = await client.query(
        `INSERT INTO users (university_id, name, email, phone, password_hash, role, verified, verification_method)
         VALUES ($1,$2,$3,$4,$5,'admin',true,'super_admin_provisioned')
         RETURNING id, name, email, role, university_id`,
        [uni.id, admin.name, admin.email.toLowerCase(), admin.phone || null, passwordHash]
      );
      const clubs = [];
      for (const clubName of initialClubs || []) {
        const c = await client.query(
          "INSERT INTO clubs (university_id, name, status) VALUES ($1,$2,'active') RETURNING id, name",
          [uni.id, clubName]
        );
        clubs.push(c.rows[0]);
      }
      return { university: uni, admin: a.rows[0], clubs };
    });
    await audit(req.user.id, "university.onboard", "university", result.university.id, { name, slug, domain });
    res.status(201).json(result);
  })
);

router.patch(
  "/universities/:id",
  validate({
    body: z.object({
      name: z.string().min(2).optional(),
      domain: z.string().regex(domainRe).nullable().optional(),
      permittedDomains: z.array(z.string().regex(domainRe)).optional(),
      status: z.enum(["active", "suspended"]).optional(),
      isolationMode: z.enum(["shared", "dedicated"]).optional(),
      isolationReason: z.string().min(5).optional(),
      featureFlags: z.record(z.string(), z.boolean()).optional(), // merged into existing flags
    }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    // SRS 21.2: dedicated-DB isolation is the exception, so it must be justified
    // (data residency, contract, ...) — recorded here rather than applied by default.
    if (b.isolationMode === "dedicated" && !b.isolationReason) {
      throw badRequest("isolationReason is required when marking a university as 'dedicated' (e.g. data-residency requirement, contractual obligation)");
    }
    let rows;
    try {
      ({ rows } = await db.query(
        `UPDATE universities SET
           name = COALESCE($1, name),
           domain = CASE WHEN $2::boolean THEN $3 ELSE domain END,
           permitted_domains = CASE WHEN $4::boolean THEN $5 ELSE permitted_domains END,
           status = COALESCE($6, status),
           isolation_mode = COALESCE($7, isolation_mode),
           isolation_reason = CASE WHEN $7 = 'shared' THEN NULL ELSE COALESCE($8, isolation_reason) END,
           feature_flags = feature_flags || COALESCE($9::jsonb, '{}'::jsonb),
           updated_at = now()
         WHERE id = $10 RETURNING *`,
        [
          b.name ?? null,
          b.domain !== undefined,
          b.domain === undefined ? null : b.domain && b.domain.toLowerCase(),
          b.permittedDomains !== undefined,
          b.permittedDomains ? b.permittedDomains.map((d) => d.toLowerCase()) : null,
          b.status ?? null,
          b.isolationMode ?? null,
          b.isolationReason ?? null,
          b.featureFlags ? JSON.stringify(b.featureFlags) : null,
          req.params.id,
        ]
      ));
    } catch (e) {
      if (e.code === "23505") throw conflict("That domain is already used by another university", "DOMAIN_TAKEN");
      throw e;
    }
    if (!rows[0]) throw notFound("University not found");
    await audit(req.user.id, "university.update", "university", rows[0].id, b);
    res.json({ university: rows[0] });
  })
);

// ------------------------------------------------------------------
// University administrators
// ------------------------------------------------------------------
router.get(
  "/admins",
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT u.id, u.name, u.email, u.suspended, u.university_id, un.name AS university_name
         FROM users u LEFT JOIN universities un ON un.id = u.university_id
        WHERE u.role = 'admin' ORDER BY un.name, u.name`
    );
    res.json({ admins: rows });
  })
);

// Promote an existing user to University Administrator of THEIR university
// (this is the "distinct approval step" the Phase 1 admin API refers to).
router.post(
  "/admins/promote",
  validate({ body: z.object({ userId: z.string().uuid() }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query("SELECT id, role, university_id FROM users WHERE id = $1", [req.body.userId]);
    const target = rows[0];
    if (!target) throw notFound("User not found");
    if (target.role === "super_admin") throw badRequest("Cannot change a Super Administrator here");
    if (!target.university_id) throw badRequest("User is not attached to a university");
    const upd = await db.query(
      "UPDATE users SET role = 'admin', verified = true WHERE id = $1 RETURNING id, name, email, role, university_id",
      [target.id]
    );
    await audit(req.user.id, "admin.promote", "user", target.id, { universityId: target.university_id, previousRole: target.role });
    res.json({ user: upd.rows[0] });
  })
);

router.post(
  "/admins/demote",
  validate({ body: z.object({ userId: z.string().uuid() }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query("SELECT id, role, university_id FROM users WHERE id = $1", [req.body.userId]);
    const target = rows[0];
    if (!target || target.role !== "admin") throw notFound("Administrator not found");
    const others = await db.query(
      "SELECT count(*)::int AS n FROM users WHERE university_id = $1 AND role = 'admin' AND suspended = false AND id <> $2",
      [target.university_id, target.id]
    );
    if (others.rows[0].n === 0) {
      throw conflict("This is the university's only active administrator — promote another first", "LAST_ADMIN");
    }
    await db.query("UPDATE users SET role = 'student' WHERE id = $1", [target.id]);
    await audit(req.user.id, "admin.demote", "user", target.id, { universityId: target.university_id });
    res.json({ success: true });
  })
);

// ------------------------------------------------------------------
// Fee schedules (append-only; newest effective row wins)
// ------------------------------------------------------------------
router.get(
  "/fee-schedules",
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT f.*, u.name AS university_name FROM fee_schedules f
         LEFT JOIN universities u ON u.id = f.university_id
        ORDER BY (f.university_id IS NOT NULL), u.name, f.effective_from DESC`
    );
    res.json({ feeSchedules: rows });
  })
);

router.post(
  "/fee-schedules",
  validate({
    body: z.object({
      universityId: z.string().uuid().nullable().optional(), // omit/null = platform default
      commissionRate: z.number().min(0).max(0.5),
      featuredRatePerDay: z.number().min(0),
      effectiveFrom: z.string().datetime().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    if (b.universityId) {
      const u = await db.query("SELECT 1 FROM universities WHERE id = $1", [b.universityId]);
      if (!u.rows.length) throw notFound("University not found");
    }
    const { rows } = await db.query(
      `INSERT INTO fee_schedules (university_id, commission_rate, featured_rate_per_day, effective_from, created_by)
       VALUES ($1,$2,$3,COALESCE($4::timestamptz, now()),$5) RETURNING *`,
      [b.universityId || null, b.commissionRate, b.featuredRatePerDay, b.effectiveFrom || null, req.user.id]
    );
    await audit(req.user.id, "fee_schedule.create", "fee_schedule", rows[0].id, b);
    res.status(201).json({ feeSchedule: rows[0] });
  })
);

// ------------------------------------------------------------------
// Cross-university analytics (SRS Section 8.6 KPIs, per campus + rolled up)
// ------------------------------------------------------------------
async function kpisPerUniversity() {
  const { rows } = await db.query(
    `SELECT u.id, u.name, u.slug, u.status,
       (SELECT count(*) FROM users          WHERE university_id = u.id)::int AS users,
       (SELECT count(*) FROM stores         WHERE university_id = u.id)::int AS stores,
       (SELECT count(*) FROM orders         WHERE university_id = u.id)::int AS orders,
       (SELECT COALESCE(SUM(total_amount),0) FROM orders WHERE university_id = u.id AND status = 'completed')::float AS gmv,
       (SELECT count(*) FROM p2p_listings   WHERE university_id = u.id AND status = 'active')::int AS active_listings,
       (SELECT count(*) FROM rental_bookings b JOIN rental_items r ON r.id = b.rental_item_id
          WHERE r.university_id = u.id AND b.status <> 'cancelled')::int AS rental_bookings,
       (SELECT count(*) FROM events         WHERE university_id = u.id AND status = 'published')::int AS published_events,
       (SELECT count(*) FROM tickets t JOIN events e ON e.id = t.event_id
          WHERE e.university_id = u.id AND t.status IN ('active','used'))::int AS tickets_sold,
       (SELECT COALESCE(SUM(t2.amount),0) FROM transactions t2 JOIN payments p ON p.id = t2.payment_id
          WHERE p.university_id = u.id AND t2.type = 'commission')::float AS commission_earned
     FROM universities u ORDER BY u.name`
  );
  return rows;
}

router.get(
  "/analytics/compare",
  asyncHandler(async (req, res) => {
    res.json({ universities: await kpisPerUniversity() });
  })
);

router.get(
  "/analytics/overview",
  asyncHandler(async (req, res) => {
    const per = await kpisPerUniversity();
    const keys = ["users", "stores", "orders", "gmv", "active_listings", "rental_bookings", "published_events", "tickets_sold", "commission_earned"];
    const totals = Object.fromEntries(keys.map((k) => [k, per.reduce((s, r) => s + Number(r[k]), 0)]));
    res.json({ universityCount: per.length, activeUniversityCount: per.filter((r) => r.status === "active").length, totals });
  })
);

module.exports = router;
