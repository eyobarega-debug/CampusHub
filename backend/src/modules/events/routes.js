const express = require("express");
const { z } = require("zod");
const db = require("../../db");
const { requireAuth, requireRole } = require("../../middleware/auth");
const { validate } = require("../../middleware/validate");
const { asyncHandler, badRequest, notFound, forbidden, conflict } = require("../../utils/errors");
const { notify, audit } = require("../../utils/notify");
const { cached } = require("../../utils/cache");

const { scopeTo, assertSameTenant } = require("../../middleware/tenant");
const router = express.Router();

async function getLedClub(userId) {
  const { rows } = await db.query("SELECT * FROM clubs WHERE lead_user_id = $1 AND status = 'active'", [userId]);
  return rows[0];
}

const safePosterUrl = z
  .string()
  .trim()
  .max(2048)
  .refine(
    (val) => {
      if (!val) return true;
      if (/^\/uploads\/[a-zA-Z0-9_\-\.]+\.(jpg|jpeg|png|webp|gif)$/i.test(val)) return true;
      try {
        const u = new URL(val);
        return u.protocol === "http:" || u.protocol === "https:";
      } catch (_) {
        return false;
      }
    },
    { message: "Poster URL must be a valid upload path (/uploads/...) or safe http/https URL" }
  )
  .optional()
  .nullable();

// Public — browse published events. Cached for 15s (SRS Section 11: Redis for
// "hot read paths e.g. popular event listings"). Phase 3: the cache key carries
// the tenant, so one campus can never be served another campus's cached list.
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { q, dateFrom, dateTo, category } = req.query;
    const tenantKey = (req.tenant && req.tenant.universityId) || "all";
    const cacheKey = `events:list:${tenantKey}:${q || ""}:${dateFrom || ""}:${dateTo || ""}:${category || ""}`;
    const events = await cached(cacheKey, 15, async () => {
      const conditions = ["e.status = 'published'"];
      const params = [];
      if (q) {
        params.push(`%${q}%`);
        conditions.push(`(e.title ILIKE $${params.length} OR e.description ILIKE $${params.length})`);
      }
      if (dateFrom) {
        params.push(dateFrom);
        conditions.push(`e.date_time >= $${params.length}`);
      }
      if (dateTo) {
        params.push(dateTo);
        conditions.push(`e.date_time <= $${params.length}`);
      }
      if (category) {
        params.push(category);
        conditions.push(`e.category = $${params.length}`);
      }
      scopeTo(req, "e.university_id", conditions, params);
      const { rows } = await db.query(
        `SELECT e.*, c.name AS club_name,
                COALESCE(SUM(tt.quantity_total),0) AS capacity_total,
                COALESCE(SUM(tt.quantity_sold),0) AS capacity_sold
         FROM events e JOIN clubs c ON c.id = e.club_id
         LEFT JOIN ticket_types tt ON tt.event_id = e.id
         WHERE ${conditions.join(" AND ")}
         GROUP BY e.id, c.name ORDER BY e.date_time ASC`,
        params
      );
      return rows;
    });
    res.json({ events });
  })
);

router.get(
  "/mine",
  requireAuth(),
  requireRole("organizer"),
  asyncHandler(async (req, res) => {
    const club = await getLedClub(req.user.id);
    if (!club) return res.json({ events: [] });
    const { rows } = await db.query(
      `SELECT e.*, c.name AS club_name,
              COALESCE(SUM(tt.quantity_total),0) AS capacity_total,
              COALESCE(SUM(tt.quantity_sold),0) AS capacity_sold
       FROM events e
       JOIN clubs c ON c.id = e.club_id
       LEFT JOIN ticket_types tt ON tt.event_id = e.id
       WHERE e.club_id = $1
       GROUP BY e.id, c.name
       ORDER BY e.created_at DESC`,
      [club.id]
    );
    res.json({ events: rows });
  })
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT e.*, c.name AS club_name, c.lead_user_id
       FROM events e JOIN clubs c ON c.id=e.club_id WHERE e.id=$1`,
      [req.params.id]
    );
    if (!rows[0]) throw notFound("Event not found");
    assertSameTenant(req, rows[0].university_id, "Event");
    const ticketTypes = await db.query(
      "SELECT * FROM ticket_types WHERE event_id = $1 ORDER BY price ASC, name ASC",
      [req.params.id]
    );
    res.json({ event: rows[0], ticketTypes: ticketTypes.rows });
  })
);

// FR-024 — create draft event with ticket types, poster, venue & contact info
router.post(
  "/",
  requireAuth(),
  requireRole("organizer"),
  validate({
    body: z.object({
      title: z.string().min(2),
      description: z.string().optional(),
      dateTime: z.string(),
      endTime: z.string().optional().nullable(),
      location: z.string().optional().nullable(),
      venueName: z.string().optional().nullable(),
      venueAddress: z.string().optional().nullable(),
      organizerName: z.string().optional().nullable(),
      contactInfo: z.string().optional().nullable(),
      category: z.string().optional().nullable(),
      posterUrl: safePosterUrl,
      capacity: z.number().int().positive(),
      ticketTypes: z
        .array(
          z.object({
            name: z.string().default("General"),
            description: z.string().optional().nullable(),
            price: z.number().nonnegative(),
            quantityTotal: z.number().int().positive(),
            purchaseLimit: z.number().int().positive().optional().nullable(),
            salesStartAt: z.string().optional().nullable(),
            salesEndAt: z.string().optional().nullable(),
            isActive: z.boolean().optional(),
          })
        )
        .min(1),
    }),
  }),
  asyncHandler(async (req, res) => {
    const club = await getLedClub(req.user.id);
    if (!club) throw forbidden("You do not lead an approved club");

    const venue = req.body.venueName || req.body.location || null;
    const event = await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO events (
           club_id, title, description, date_time, end_time, location,
           venue_name, venue_address, organizer_name, contact_info,
           category, poster_url, capacity, status
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'draft')
         RETURNING *`,
        [
          club.id,
          req.body.title,
          req.body.description || null,
          req.body.dateTime,
          req.body.endTime || null,
          venue,
          venue,
          req.body.venueAddress || null,
          req.body.organizerName || club.name,
          req.body.contactInfo || null,
          req.body.category || "general",
          req.body.posterUrl || null,
          req.body.capacity,
        ]
      );
      const ev = rows[0];
      for (const tt of req.body.ticketTypes) {
        await client.query(
          `INSERT INTO ticket_types (
             event_id, name, description, price, quantity_total,
             purchase_limit, sales_start_at, sales_end_at, is_active
           )
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            ev.id,
            tt.name,
            tt.description || null,
            tt.price,
            tt.quantityTotal,
            tt.purchaseLimit || 5,
            tt.salesStartAt || null,
            tt.salesEndAt || null,
            tt.isActive !== false,
          ]
        );
      }
      return ev;
    });
    res.status(201).json({ event });
  })
);

// FR-025 — submit for admin approval
router.post(
  "/:id/submit",
  requireAuth(),
  requireRole("organizer"),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query("SELECT e.*, c.lead_user_id FROM events e JOIN clubs c ON c.id=e.club_id WHERE e.id=$1", [
      req.params.id,
    ]);
    const event = rows[0];
    if (!event) throw notFound("Event not found");
    assertSameTenant(req, event.university_id, "Event");
    if (event.lead_user_id !== req.user.id) throw forbidden();
    if (event.status !== "draft") throw conflict("Only draft events can be submitted for review");

    const { rows: updated } = await db.query("UPDATE events SET status='pending_review' WHERE id=$1 RETURNING *", [event.id]);
    const admins = req.user.university_id
      ? await db.query("SELECT id FROM users WHERE role='admin' AND university_id = $1", [req.user.university_id])
      : { rows: [] };
    await Promise.all(admins.rows.map((a) => notify(a.id, "event_review", "New event pending review", event.title)));
    res.json({ event: updated[0] });
  })
);

// FR-026 — organizer manages status and event poster/details
router.patch(
  "/:id",
  requireAuth(),
  validate({
    body: z.object({
      status: z.enum(["published", "postponed", "cancelled"]).optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      dateTime: z.string().optional(),
      endTime: z.string().optional().nullable(),
      location: z.string().optional().nullable(),
      venueName: z.string().optional().nullable(),
      venueAddress: z.string().optional().nullable(),
      organizerName: z.string().optional().nullable(),
      contactInfo: z.string().optional().nullable(),
      category: z.string().optional().nullable(),
      posterUrl: safePosterUrl,
      capacity: z.number().int().positive().optional(),
      ticketTypes: z
        .array(
          z.object({
            id: z.string().uuid().optional(),
            name: z.string(),
            description: z.string().optional().nullable(),
            price: z.number().nonnegative(),
            quantityTotal: z.number().int().positive(),
            purchaseLimit: z.number().int().positive().optional().nullable(),
            isActive: z.boolean().optional(),
          })
        )
        .optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query("SELECT e.*, c.lead_user_id FROM events e JOIN clubs c ON c.id=e.club_id WHERE e.id=$1", [
      req.params.id,
    ]);
    const event = rows[0];
    if (!event) throw notFound("Event not found");
    assertSameTenant(req, event.university_id, "Event");
    const isOwner = req.user.role === "organizer" && event.lead_user_id === req.user.id;
    if (!isOwner && !["admin", "super_admin"].includes(req.user.role)) throw forbidden();

    if (req.body.status === "published" && event.status !== "approved" && !["admin", "super_admin"].includes(req.user.role)) {
      throw conflict("Event must be approved by an administrator before publishing", "NOT_APPROVED");
    }
    if (["completed"].includes(event.status)) throw conflict("Event already took place");

    const cancelling = req.body.status === "cancelled";
    const venue = req.body.venueName !== undefined ? req.body.venueName : req.body.location;

    const updated = await db.withTransaction(async (client) => {
      const { rows: evRows } = await client.query(
        `UPDATE events SET
           status = COALESCE($1, status),
           title = COALESCE($2, title),
           description = COALESCE($3, description),
           date_time = COALESCE($4, date_time),
           end_time = COALESCE($5, end_time),
           location = COALESCE($6, location),
           venue_name = COALESCE($7, venue_name),
           venue_address = COALESCE($8, venue_address),
           organizer_name = COALESCE($9, organizer_name),
           contact_info = COALESCE($10, contact_info),
           category = COALESCE($11, category),
           poster_url = COALESCE($12, poster_url),
           capacity = COALESCE($13, capacity)
         WHERE id = $14 RETURNING *`,
        [
          req.body.status,
          req.body.title,
          req.body.description,
          req.body.dateTime,
          req.body.endTime,
          venue,
          venue,
          req.body.venueAddress,
          req.body.organizerName,
          req.body.contactInfo,
          req.body.category,
          req.body.posterUrl,
          req.body.capacity,
          event.id,
        ]
      );

      // If draft or approved and ticketTypes provided, update/insert ticket types
      if (req.body.ticketTypes && ["draft", "approved"].includes(event.status)) {
        for (const tt of req.body.ticketTypes) {
          if (tt.id) {
            await client.query(
              `UPDATE ticket_types SET
                 name = $1, description = $2, price = $3, quantity_total = $4,
                 purchase_limit = COALESCE($5, purchase_limit), is_active = COALESCE($6, is_active)
               WHERE id = $7 AND event_id = $8`,
              [tt.name, tt.description || null, tt.price, tt.quantityTotal, tt.purchaseLimit, tt.isActive, tt.id, event.id]
            );
          } else {
            await client.query(
              `INSERT INTO ticket_types (event_id, name, description, price, quantity_total, purchase_limit, is_active)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [event.id, tt.name, tt.description || null, tt.price, tt.quantityTotal, tt.purchaseLimit || 5, tt.isActive !== false]
            );
          }
        }
      }

      return evRows[0];
    });

    if (cancelling || req.body.status === "postponed") {
      const tickets = await db.query("SELECT * FROM tickets WHERE event_id = $1 AND status = 'active'", [event.id]);
      for (const t of tickets.rows) {
        await notify(
          t.holder_id,
          "ticket_update",
          cancelling ? `Event "${event.title}" was cancelled` : `Event "${event.title}" was postponed`,
          cancelling ? "Your ticket will be refunded." : "New date to be announced."
        );
      }
      if (cancelling) {
        await db.query("UPDATE tickets SET status='cancelled' WHERE event_id=$1 AND status='active'", [event.id]);
      }
    }
    res.json({ event: updated });
  })
);

// FR-044 (admin) — approve/reject a submitted event
router.patch(
  "/:id/admin-decision",
  requireAuth(),
  requireRole("admin", "super_admin"),
  validate({ body: z.object({ decision: z.enum(["approve", "reject"]), reason: z.string().optional() }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query("SELECT e.*, c.lead_user_id FROM events e JOIN clubs c ON c.id=e.club_id WHERE e.id=$1", [
      req.params.id,
    ]);
    const event = rows[0];
    if (!event) throw notFound("Event not found");
    assertSameTenant(req, event.university_id, "Event");
    if (event.status !== "pending_review") throw conflict("Event is not pending review");

    const status = req.body.decision === "approve" ? "approved" : "draft";
    const { rows: updated } = await db.query("UPDATE events SET status=$1, reject_reason=$2 WHERE id=$3 RETURNING *", [
      status,
      req.body.decision === "reject" ? req.body.reason || "Not specified" : null,
      event.id,
    ]);
    await notify(
      event.lead_user_id,
      "event_review",
      req.body.decision === "approve" ? `"${event.title}" was approved — you can publish it now` : `"${event.title}" needs changes`,
      req.body.reason
    );
    await audit(req.user.id, "event.decision", "event", event.id, { decision: req.body.decision, reason: req.body.reason });
    res.json({ event: updated[0] });
  })
);

// FR-027 — ticket sales / attendee list
router.get(
  "/:id/attendees",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query("SELECT e.*, c.lead_user_id FROM events e JOIN clubs c ON c.id=e.club_id WHERE e.id=$1", [
      req.params.id,
    ]);
    const event = rows[0];
    if (!event) throw notFound("Event not found");
    assertSameTenant(req, event.university_id, "Event");
    if (!["admin", "super_admin"].includes(req.user.role) && event.lead_user_id !== req.user.id) throw forbidden();

    const attendees = await db.query(
      `SELECT t.id, t.status, t.used_at, u.name AS holder_name, u.email AS holder_email, tt.name AS ticket_type
       FROM tickets t JOIN users u ON u.id = t.holder_id JOIN ticket_types tt ON tt.id = t.ticket_type_id
       WHERE t.event_id = $1 ORDER BY t.created_at DESC`,
      [req.params.id]
    );
    const sales = await db.query(
      "SELECT tt.name, tt.price, tt.quantity_total, tt.quantity_sold FROM ticket_types tt WHERE tt.event_id = $1",
      [req.params.id]
    );
    res.json({ attendees: attendees.rows, sales: sales.rows });
  })
);

// Phase 2 — generate recurring occurrences of a published event (SRS Phase
// 2 spec, item D: "recurring events ... without recreating the event from
// scratch each time"). Occurrences are pre-approved (they inherit the
// template's 'published' status directly) on the reasoning that the
// recurring series was already vetted once by an admin — a weekly club
// meetup shouldn't need re-review every single week. Each occurrence gets
// its own fresh ticket_types cloned from the template (quantity_sold
// reset to 0) so capacity is tracked independently per occurrence.
router.post(
  "/:id/generate-occurrences",
  requireAuth(),
  requireRole("organizer"),
  validate({
    body: z.object({
      count: z.number().int().min(1).max(12),
      intervalDays: z.number().int().min(1).max(90).default(7),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query("SELECT e.*, c.lead_user_id FROM events e JOIN clubs c ON c.id=e.club_id WHERE e.id=$1", [
      req.params.id,
    ]);
    const template = rows[0];
    if (!template) throw notFound("Event not found");
    if (template.lead_user_id !== req.user.id) throw forbidden();
    assertSameTenant(req, template.university_id, "Event");
    if (template.status !== "published") throw conflict("Only a published event can be used as a recurrence template");

    const ticketTypes = await db.query("SELECT * FROM ticket_types WHERE event_id = $1", [template.id]);

    const created = await db.withTransaction(async (client) => {
      if (template.recurrence_rule === "none") {
        await client.query("UPDATE events SET recurrence_rule = 'weekly' WHERE id = $1", [template.id]);
      }
      const occurrences = [];
      for (let i = 1; i <= req.body.count; i++) {
        const { rows: occRows } = await client.query(
          `INSERT INTO events (club_id, title, description, date_time, location, capacity, status, recurrence_rule, parent_event_id)
           VALUES ($1,$2,$3,$4::timestamptz + ($5 || ' days')::interval,$6,$7,'published','none',$8)
           RETURNING *`,
          [
            template.club_id, template.title, template.description, template.date_time,
            req.body.intervalDays * i, template.location, template.capacity, template.id,
          ]
        );
        const occ = occRows[0];
        for (const tt of ticketTypes.rows) {
          await client.query("INSERT INTO ticket_types (event_id, name, price, quantity_total) VALUES ($1,$2,$3,$4)", [
            occ.id, tt.name, tt.price, tt.quantity_total,
          ]);
        }
        occurrences.push(occ);
      }
      return occurrences;
    });

    res.status(201).json({ occurrences: created });
  })
);

// Phase 2 — list occurrences generated from a recurring template.
router.get(
  "/:id/occurrences",
  asyncHandler(async (req, res) => {
    const { rows: parentRows } = await db.query("SELECT university_id FROM events WHERE id = $1", [req.params.id]);
    if (!parentRows[0]) throw notFound("Event not found");
    assertSameTenant(req, parentRows[0].university_id, "Event");
    const conditions = ["parent_event_id = $1"];
    const params = [req.params.id];
    scopeTo(req, "university_id", conditions, params);
    const { rows } = await db.query(
      `SELECT * FROM events WHERE ${conditions.join(" AND ")} ORDER BY date_time ASC`,
      params
    );
    res.json({ occurrences: rows });
  })
);

module.exports = router;
