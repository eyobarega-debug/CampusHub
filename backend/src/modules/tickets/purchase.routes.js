const express = require("express");
const { z } = require("zod");
const db = require("../../db");
const { requireAuth, requireRole } = require("../../middleware/auth");
const { validate } = require("../../middleware/validate");
const { asyncHandler, notFound, forbidden, conflict } = require("../../utils/errors");
const payments = require("../../services/payments");

const { assertSameTenant } = require("../../middleware/tenant");
const router = express.Router();

// FR-028 — purchase a ticket, mounted at POST /api/events/:eventId/tickets
// (kept in its own file so it can be mounted under /api/events while
// tickets/routes.js is mounted separately under /api/tickets).
// Quantity is fixed at 1 per call in this Phase 1 build for simplicity;
// buying multiple = calling this endpoint multiple times. See README
// "Simplifications".
router.post(
  "/:eventId/tickets",
  requireAuth(),
  requireRole("student"),
  validate({ body: z.object({ ticketTypeId: z.string().uuid() }) }),
  asyncHandler(async (req, res) => {
    if (!req.user.verified) throw forbidden("Verify your student account before buying tickets");

    const ticket = await db.withTransaction(async (client) => {
      const { rows: eventRows } = await client.query("SELECT * FROM events WHERE id = $1", [req.params.eventId]);
      const event = eventRows[0];
      if (!event || event.status !== "published") throw notFound("Event not found or not open for ticket sales");
      assertSameTenant(req, event.university_id, "Event");

      const { rows: ttRows } = await client.query("SELECT * FROM ticket_types WHERE id = $1 AND event_id = $2 FOR UPDATE", [
        req.body.ticketTypeId,
        event.id,
      ]);
      const tt = ttRows[0];
      if (!tt) throw notFound("Ticket type not found");
      if (tt.quantity_sold >= tt.quantity_total) {
        throw conflict("This ticket type is sold out", "SOLD_OUT");
      }

      await client.query("UPDATE ticket_types SET quantity_sold = quantity_sold + 1 WHERE id = $1", [tt.id]);
      const { rows } = await client.query(
        `INSERT INTO tickets (event_id, ticket_type_id, holder_id, qr_token_hash, status)
         VALUES ($1,$2,$3,'PENDING','reserved') RETURNING *`,
        [event.id, tt.id, req.user.id]
      );
      return rows[0];
    });

    const { rows: ttRows2 } = await db.query("SELECT price FROM ticket_types WHERE id = $1", [req.body.ticketTypeId]);
    const payment = await payments.initiatePayment({
      transactionType: "ticket",
      transactionId: ticket.id,
      amount: ttRows2[0].price,
      buyerId: req.user.id,
    });
    res.status(201).json({ ticket, payment });
  })
);

// Phase 2 — join the waitlist for a sold-out ticket type (SRS Phase 2 spec,
// item D). Only accepted while the type is actually sold out, so the
// waitlist can't be used to skip the line on an available type.
router.post(
  "/:eventId/waitlist",
  requireAuth(),
  requireRole("student"),
  validate({ body: z.object({ ticketTypeId: z.string().uuid() }) }),
  asyncHandler(async (req, res) => {
    const { rows: evRows } = await db.query("SELECT university_id FROM events WHERE id = $1", [req.params.eventId]);
    if (!evRows[0]) throw notFound("Event not found");
    assertSameTenant(req, evRows[0].university_id, "Event");
    const { rows: ttRows } = await db.query("SELECT * FROM ticket_types WHERE id = $1 AND event_id = $2", [
      req.body.ticketTypeId,
      req.params.eventId,
    ]);
    const tt = ttRows[0];
    if (!tt) throw notFound("Ticket type not found");
    if (tt.quantity_sold < tt.quantity_total) {
      throw conflict("This ticket type still has availability — just buy it directly.", "NOT_SOLD_OUT");
    }
    const { rows } = await db.query(
      `INSERT INTO waitlist_entries (event_id, ticket_type_id, user_id)
       VALUES ($1,$2,$3) ON CONFLICT (ticket_type_id, user_id) DO NOTHING RETURNING *`,
      [req.params.eventId, tt.id, req.user.id]
    );
    res.status(201).json({ entry: rows[0] || { alreadyOnWaitlist: true } });
  })
);

router.get(
  "/waitlist/mine",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT w.*, e.title AS event_title, e.date_time, tt.name AS ticket_type
       FROM waitlist_entries w JOIN events e ON e.id = w.event_id JOIN ticket_types tt ON tt.id = w.ticket_type_id
       WHERE w.user_id = $1 ORDER BY w.created_at DESC`,
      [req.user.id]
    );
    res.json({ entries: rows });
  })
);

module.exports = router;
