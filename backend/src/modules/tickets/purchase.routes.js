const crypto = require("crypto");
const express = require("express");
const { z } = require("zod");
const db = require("../../db");
const { requireAuth, requireRole } = require("../../middleware/auth");
const { validate } = require("../../middleware/validate");
const { asyncHandler, notFound, forbidden, conflict } = require("../../utils/errors");
const payments = require("../../services/payments");
const { signTicket, generateTicketNumber } = require("../../utils/qr");

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
  validate({ body: z.object({ ticketTypeId: z.string().uuid(), paymentMethod: z.enum(["online", "manual"]).optional() }) }),
  asyncHandler(async (req, res) => {
    if (!req.user.verified) throw forbidden("Verify your student account before buying tickets");

    const result = await db.withTransaction(async (client) => {
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
      if (tt.is_active === false) {
        throw conflict("This ticket type is currently inactive", "TICKET_TYPE_INACTIVE");
      }
      if (tt.sales_start_at && new Date(tt.sales_start_at) > new Date()) {
        throw conflict("Ticket sales for this type have not started yet", "SALES_NOT_STARTED");
      }
      if (tt.sales_end_at && new Date(tt.sales_end_at) < new Date()) {
        throw conflict("Ticket sales for this type have ended", "SALES_ENDED");
      }
      if (tt.quantity_sold >= tt.quantity_total) {
        throw conflict("This ticket type is sold out", "SOLD_OUT");
      }

      if (tt.purchase_limit != null && tt.purchase_limit > 0) {
        const { rows: userTickets } = await client.query(
          "SELECT COUNT(*) AS user_count FROM tickets WHERE ticket_type_id = $1 AND holder_id = $2 AND status IN ('active', 'reserved')",
          [tt.id, req.user.id]
        );
        if (Number(userTickets[0]?.user_count || 0) >= tt.purchase_limit) {
          throw conflict(
            `You have reached the maximum purchase limit of ${tt.purchase_limit} ticket(s) for this tier`,
            "PURCHASE_LIMIT_EXCEEDED"
          );
        }
      }

      if (event.capacity != null) {
        const { rows: soldRows } = await client.query(
          "SELECT COUNT(*) AS total_active FROM tickets WHERE event_id = $1 AND status IN ('active', 'reserved')",
          [event.id]
        );
        if (Number(soldRows[0]?.total_active || 0) >= event.capacity) {
          throw conflict("This event has reached maximum capacity", "EVENT_CAPACITY_REACHED");
        }
      }

      const isFree = Number(tt.price) === 0;

      if (isFree) {
        // Prevent duplicate free ticket claims for the same event
        const { rows: existing } = await client.query(
          "SELECT id FROM tickets WHERE event_id = $1 AND holder_id = $2 AND status = 'active'",
          [event.id, req.user.id]
        );
        if (existing.length) {
          throw conflict("You already have an active ticket for this event", "DUPLICATE_REGISTRATION");
        }

        const ticketId = crypto.randomUUID();
        const signature = signTicket(ticketId);
        const ticketNumber = generateTicketNumber();

        await client.query("UPDATE ticket_types SET quantity_sold = quantity_sold + 1 WHERE id = $1", [tt.id]);
        const { rows } = await client.query(
          `INSERT INTO tickets (id, event_id, ticket_type_id, holder_id, qr_token_hash, status, ticket_number)
           VALUES ($1, $2, $3, $4, $5, 'active', $6) RETURNING *`,
          [ticketId, event.id, tt.id, req.user.id, signature, ticketNumber]
        );
        await client.query("INSERT INTO notifications (user_id, type, title, body) VALUES ($1,'ticket_update',$2,$3)", [
          req.user.id,
          "Your ticket is ready",
          `${event.title} — view your QR code in My Tickets.`,
        ]);
        return { ticket: rows[0], isFree: true, payment: null };
      }

      const ticketNumber = generateTicketNumber();
      await client.query("UPDATE ticket_types SET quantity_sold = quantity_sold + 1 WHERE id = $1", [tt.id]);
      const { rows } = await client.query(
        `INSERT INTO tickets (event_id, ticket_type_id, holder_id, qr_token_hash, status, ticket_number)
         VALUES ($1,$2,$3,'PENDING-' || gen_random_uuid()::text,'reserved', $4) RETURNING *`,
        [event.id, tt.id, req.user.id, ticketNumber]
      );
      return { ticket: rows[0], isFree: false, price: tt.price };
    });

    if (result.isFree) {
      return res.status(201).json({ ticket: result.ticket, isFree: true, payment: null });
    }

    const payment = await payments.initiatePayment({
      transactionType: "ticket",
      transactionId: result.ticket.id,
      amount: result.price,
      buyerId: req.user.id,
      buyerEmail: req.user.email,
      method: req.body.paymentMethod,
    });
    res.status(201).json({ ticket: result.ticket, payment, isFree: false });
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
