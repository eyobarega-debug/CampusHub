const express = require("express");
const { z } = require("zod");
const db = require("../../db");
const { requireAuth, requireRole } = require("../../middleware/auth");
const { validate } = require("../../middleware/validate");
const { rateLimit } = require("../../middleware/rateLimit");
const { asyncHandler, notFound, forbidden, conflict } = require("../../utils/errors");
const { audit, notify } = require("../../utils/notify");
const {
  signTicket,
  generateTicketNumber,
  buildQrPayload,
  buildVerificationUrl,
  parseQrPayload,
  isValidSignature,
  qrPayloadToDataUrl,
} = require("../../utils/qr");
const payments = require("../../services/payments");

const router = express.Router();

// Phase 2 — when a ticket type's capacity frees up (cancellation, or a
// reserved-but-unpaid ticket expiring), pop the oldest waiting entry off
// the waitlist and let them know a spot opened up. First-come-first-served
// by wait time, one notification per freed spot — it does not hold the
// spot for them, since Phase 1's capacity model has no reservation-hold
// concept beyond the payment window itself (see rentals/tickets "reserved"
// status pattern already in place for that).
async function notifyWaitlistIfAvailable(ticketTypeId, client) {
  const exec = client || db;
  const { rows: waiting } = await exec.query(
    `SELECT w.*, e.title AS event_title FROM waitlist_entries w JOIN events e ON e.id = w.event_id
     WHERE w.ticket_type_id = $1 AND w.status = 'waiting' ORDER BY w.created_at ASC LIMIT 1`,
    [ticketTypeId]
  );
  const entry = waiting[0];
  if (!entry) return;
  await exec.query("UPDATE waitlist_entries SET status='notified', notified_at=now() WHERE id=$1", [entry.id]);
  await notify(entry.user_id, "ticket_update", `A spot opened up for "${entry.event_title}"`, "Buy now before it's gone.");
}

// FR-030 — view my tickets (QR is regenerated on demand — see utils/qr.js)
router.get(
  "/mine",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const isAdmin = ["admin", "super_admin"].includes(req.user.role); // admins see all tickets
    const { rows } = await db.query(
      `SELECT t.*,
              e.title AS event_title, e.description AS event_description, e.date_time, e.end_time,
              e.location, e.venue_name, e.venue_address, e.poster_url, e.organizer_name, e.category,
              un.name AS university_name,
              c.name AS club_name,
              u.name AS holder_name, u.email AS holder_email,
              tt.name AS ticket_type, tt.price,
              lp.id AS payment_id, lp.status AS payment_status, lp.provider AS payment_provider,
              lp.reject_reason AS payment_reject_reason
       FROM tickets t
       JOIN events e ON e.id = t.event_id
       LEFT JOIN universities un ON un.id = e.university_id
       JOIN clubs c ON c.id = e.club_id
       JOIN users u ON u.id = t.holder_id
       JOIN ticket_types tt ON tt.id = t.ticket_type_id
       LEFT JOIN LATERAL (
         SELECT p.id, p.status, p.provider,
                (SELECT reject_reason FROM payment_proofs WHERE payment_id = p.id AND status = 'rejected' ORDER BY created_at DESC LIMIT 1) AS reject_reason
           FROM payments p WHERE p.transaction_type = 'ticket' AND p.transaction_id = t.id ORDER BY p.created_at DESC LIMIT 1
       ) lp ON true
       ${isAdmin ? (req.user.role === "admin" ? "WHERE e.university_id = $1" : "WHERE $1::text IS NOT NULL") : "WHERE t.holder_id = $1"}
       ORDER BY t.created_at DESC`,
      [isAdmin ? (req.user.role === "admin" ? req.user.university_id : "all") : req.user.id]
    );
    const withQr = await Promise.all(
      rows.map(async (t) => {
        if (t.status !== "active" && t.status !== "used") return { ...t, qrDataUrl: null, qrUrl: null, qrPayload: null };
        const sig = signTicket(t.id);
        const payload = buildVerificationUrl(t.id, sig);
        const rawPayload = buildQrPayload(t.id, sig);
        return {
          ...t,
          qrPayload: rawPayload,
          qrUrl: payload,
          qrDataUrl: await qrPayloadToDataUrl(payload),
        };
      })
    );
    res.json({ tickets: withQr });
  })
);

// Retrieve single ticket by ID with ownership or authorized staff verification
router.get(
  "/:id",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT t.*,
              e.title AS event_title, e.description AS event_description, e.date_time, e.end_time,
              e.location, e.venue_name, e.venue_address, e.poster_url, e.organizer_name, e.category,
              e.university_id,
              un.name AS university_name,
              c.name AS club_name, c.lead_user_id,
              u.name AS holder_name, u.email AS holder_email,
              tt.name AS ticket_type, tt.price,
              lp.id AS payment_id, lp.status AS payment_status, lp.provider AS payment_provider
       FROM tickets t
       JOIN events e ON e.id = t.event_id
       LEFT JOIN universities un ON un.id = e.university_id
       JOIN clubs c ON c.id = e.club_id
       JOIN users u ON u.id = t.holder_id
       JOIN ticket_types tt ON tt.id = t.ticket_type_id
       LEFT JOIN LATERAL (
         SELECT p.id, p.status, p.provider
           FROM payments p WHERE p.transaction_type = 'ticket' AND p.transaction_id = t.id ORDER BY p.created_at DESC LIMIT 1
       ) lp ON true
       WHERE t.id = $1`,
      [req.params.id]
    );
    const t = rows[0];
    if (!t) throw notFound("Ticket not found");

    const isHolder = t.holder_id === req.user.id;
    const isLeadOrganizer = req.user.role === "organizer" && t.lead_user_id === req.user.id;
    const isCampusAdmin = req.user.role === "admin" && t.university_id === req.user.university_id;
    const isSuperAdmin = req.user.role === "super_admin";

    if (!isHolder && !isLeadOrganizer && !isCampusAdmin && !isSuperAdmin) {
      throw forbidden("You are not authorized to view this ticket");
    }

    let qrDataUrl = null;
    let qrUrl = null;
    let qrPayload = null;
    if (t.status === "active" || t.status === "used") {
      const sig = signTicket(t.id);
      qrUrl = buildVerificationUrl(t.id, sig);
      qrPayload = buildQrPayload(t.id, sig);
      qrDataUrl = await qrPayloadToDataUrl(qrUrl);
    }

    res.json({ ticket: { ...t, qrDataUrl, qrUrl, qrPayload } });
  })
);

// FR-033 — cancel a ticket (buyer-initiated, within policy — kept simple:
// allowed any time before the event starts, for demo purposes)
router.post(
  "/:id/cancel",
  requireAuth(),
  validate({ body: z.object({ reason: z.string().optional() }) }),
  asyncHandler(async (req, res) => {
    await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        "SELECT t.*, e.date_time, e.title FROM tickets t JOIN events e ON e.id=t.event_id WHERE t.id=$1 FOR UPDATE",
        [req.params.id]
      );
      const ticket = rows[0];
      if (!ticket) throw notFound("Ticket not found");
      if (ticket.holder_id !== req.user.id) throw forbidden();
      if (ticket.status !== "active") throw conflict("Only active tickets can be cancelled");
      if (new Date(ticket.date_time) < new Date()) throw conflict("This event has already started");

      const { rows: updated } = await client.query(
        "UPDATE tickets SET status='cancelled' WHERE id=$1 AND status='active' RETURNING *",
        [ticket.id]
      );
      if (!updated[0]) throw conflict("Could not cancel ticket (status already changed)");

      await client.query("UPDATE ticket_types SET quantity_sold = GREATEST(0, quantity_sold - 1) WHERE id = $1", [
        ticket.ticket_type_id,
      ]);
      await notifyWaitlistIfAvailable(ticket.ticket_type_id, client);

      const payRows = await client.query(
        "SELECT * FROM payments WHERE transaction_type='ticket' AND transaction_id=$1 AND status='confirmed' FOR UPDATE",
        [ticket.id]
      );
      if (payRows.rows[0]) {
        await payments.refundPayment(payRows.rows[0].id, null, req.body.reason || "Buyer cancellation", req.user.id);
      }
    });
    res.json({ success: true });
  })
);

// Core ticket resolver: extracts and validates the cryptographic signature and loads authoritative data
async function resolveScannerTicket(qrToken, expectedTicketId, scannerUser) {
  const parsed = parseQrPayload(qrToken);
  if (!parsed || (expectedTicketId && parsed.ticketId !== expectedTicketId)) {
    await audit(scannerUser.id, "ticket.scan", "ticket", expectedTicketId || null, { result: "INVALID", reason: "malformed_token" });
    return { errorResult: { result: "INVALID", reason: "Malformed or mismatched QR token", ticketId: expectedTicketId } };
  }
  if (!isValidSignature(parsed.ticketId, parsed.signature)) {
    await audit(scannerUser.id, "ticket.scan", "ticket", parsed.ticketId, { result: "INVALID", reason: "bad_signature" });
    return { errorResult: { result: "INVALID", reason: "This QR code was not issued by Gibiyachin (signature mismatch)", ticketId: parsed.ticketId } };
  }

  const { rows } = await db.query(
    `SELECT t.*,
            e.title AS event_title, e.date_time, e.end_time, e.location, e.venue_name, e.venue_address,
            e.poster_url, e.organizer_name, e.club_id, e.status AS event_status,
            un.name AS university_name,
            tt.name AS ticket_type, tt.price,
            u.name AS holder_name, u.email AS holder_email,
            c.name AS club_name, c.lead_user_id,
            lp.status AS payment_status
     FROM tickets t
     JOIN events e ON e.id = t.event_id
     LEFT JOIN universities un ON un.id = e.university_id
     JOIN clubs c ON c.id = e.club_id
     JOIN users u ON u.id = t.holder_id
     JOIN ticket_types tt ON tt.id = t.ticket_type_id
     LEFT JOIN LATERAL (
       SELECT p.status FROM payments p WHERE p.transaction_type = 'ticket' AND p.transaction_id = t.id ORDER BY p.created_at DESC LIMIT 1
     ) lp ON true
     WHERE t.id = $1`,
    [parsed.ticketId]
  );
  const ticket = rows[0];
  if (!ticket) {
    return { errorResult: { result: "INVALID", reason: "Ticket does not exist", ticketId: parsed.ticketId } };
  }

  if (scannerUser.role === "organizer") {
    if (ticket.lead_user_id !== scannerUser.id) {
      throw forbidden("You are not authorized to scan tickets for this event");
    }
  } else if (scannerUser.role === "admin") {
    if (ticket.university_id !== scannerUser.university_id) {
      throw forbidden("You are not authorized to scan tickets for another university");
    }
  }

  return { ticket, parsed };
}

// 1. Inspect without check-in: allows staff to preview attendee and check eligibility repeatedly
async function inspectOneTicket(qrToken, expectedTicketId, scannerUser) {
  const resolved = await resolveScannerTicket(qrToken, expectedTicketId, scannerUser);
  if (resolved.errorResult) return resolved.errorResult;
  const { ticket } = resolved;

  if (ticket.status === "used") {
    await audit(scannerUser.id, "ticket.inspect", "ticket", ticket.id, { result: "ALREADY_USED" });
    return {
      result: "ALREADY_USED",
      eligible: false,
      ticket,
      attendeeName: ticket.holder_name,
      ticketType: ticket.ticket_type,
      ticketNumber: ticket.ticket_number,
      eventTitle: ticket.event_title,
      previousScanAt: ticket.used_at,
      reason: "Ticket has already been admitted.",
    };
  }

  if (ticket.status === "reserved" || (ticket.payment_status && ticket.payment_status !== "confirmed")) {
    await audit(scannerUser.id, "ticket.inspect", "ticket", ticket.id, { result: "PAYMENT_NOT_APPROVED" });
    return {
      result: "PAYMENT_NOT_APPROVED",
      eligible: false,
      ticket,
      attendeeName: ticket.holder_name,
      ticketType: ticket.ticket_type,
      ticketNumber: ticket.ticket_number,
      eventTitle: ticket.event_title,
      reason: "Payment is pending verification. This ticket is not yet eligible for admission.",
    };
  }

  if (ticket.status === "cancelled") {
    await audit(scannerUser.id, "ticket.inspect", "ticket", ticket.id, { result: "CANCELLED" });
    return {
      result: "CANCELLED",
      eligible: false,
      ticket,
      attendeeName: ticket.holder_name,
      ticketType: ticket.ticket_type,
      ticketNumber: ticket.ticket_number,
      eventTitle: ticket.event_title,
      reason: "Ticket has been cancelled or refunded.",
    };
  }

  if (ticket.event_status === "cancelled") {
    return {
      result: "EVENT_CANCELLED",
      eligible: false,
      ticket,
      attendeeName: ticket.holder_name,
      eventTitle: ticket.event_title,
      reason: "Event has been cancelled.",
    };
  }

  if (ticket.status !== "active") {
    return {
      result: "INVALID",
      eligible: false,
      ticket,
      reason: `Ticket status is "${ticket.status}"`,
    };
  }

  await audit(scannerUser.id, "ticket.inspect", "ticket", ticket.id, { result: "VALID" });
  return {
    result: "VALID",
    eligible: true,
    ticket,
    attendeeName: ticket.holder_name,
    ticketType: ticket.ticket_type,
    ticketNumber: ticket.ticket_number,
    eventTitle: ticket.event_title,
    dateTime: ticket.date_time,
    venue: ticket.venue_name || ticket.location,
  };
}

// 2. Atomic Check-In: ensures only ONE check-in can succeed across concurrent scans
async function checkInOneTicket(qrToken, expectedTicketId, scannerUser, deviceInfo = null) {
  const resolved = await resolveScannerTicket(qrToken, expectedTicketId, scannerUser);
  if (resolved.errorResult) return resolved.errorResult;
  const { ticket } = resolved;

  if (ticket.event_status === "cancelled") {
    await audit(scannerUser.id, "ticket.checkin", "ticket", ticket.id, { result: "EVENT_CANCELLED" });
    return { result: "EVENT_CANCELLED", reason: "Event has been cancelled. Admissions are closed.", ticketId: ticket.id };
  }
  if (ticket.status === "used") {
    await audit(scannerUser.id, "ticket.checkin", "ticket", ticket.id, { result: "ALREADY_USED" });
    return { result: "ALREADY_USED", ticket, previousScanAt: ticket.used_at, reason: "Ticket has already been admitted" };
  }
  if (ticket.status === "cancelled") {
    await audit(scannerUser.id, "ticket.checkin", "ticket", ticket.id, { result: "CANCELLED" });
    return { result: "CANCELLED", reason: "Ticket has been cancelled or refunded", ticketId: ticket.id };
  }
  if (ticket.status === "reserved" || (Number(ticket.price) > 0 && ticket.payment_status && ticket.payment_status !== "confirmed")) {
    await audit(scannerUser.id, "ticket.checkin", "ticket", ticket.id, { result: "PAYMENT_NOT_APPROVED" });
    return { result: "PAYMENT_NOT_APPROVED", reason: "Payment is pending verification. This ticket is not eligible for admission.", ticketId: ticket.id };
  }
  if (ticket.status !== "active") {
    await audit(scannerUser.id, "ticket.checkin", "ticket", ticket.id, { result: "INVALID", reason: ticket.status });
    return { result: "INVALID", reason: `Ticket status is "${ticket.status}"`, ticketId: ticket.id };
  }

  // Atomic UPDATE guard inside transaction: only admits active tickets for non-cancelled events
  const { updated } = await db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE tickets SET status = 'used', used_at = now(), used_by = $1
       WHERE id = $2 AND status = 'active'
         AND (SELECT status FROM events WHERE id = tickets.event_id) != 'cancelled'
       RETURNING *`,
      [scannerUser.id, ticket.id]
    );
    if (!rows[0]) return { updated: null };

    await client.query(
      `INSERT INTO ticket_checkins (ticket_id, event_id, staff_id, device_info)
       VALUES ($1, $2, $3, $4)`,
      [ticket.id, ticket.event_id, scannerUser.id, deviceInfo || null]
    );
    return { updated: rows[0] };
  });

  if (!updated) {
    const { rows: reread } = await db.query(
      `SELECT t.status, t.used_at, e.status AS event_status
       FROM tickets t JOIN events e ON e.id = t.event_id WHERE t.id = $1`,
      [ticket.id]
    );
    if (reread[0]?.event_status === "cancelled") {
      await audit(scannerUser.id, "ticket.checkin", "ticket", ticket.id, { result: "EVENT_CANCELLED" });
      return { result: "EVENT_CANCELLED", reason: "Event has been cancelled. Admissions are closed.", ticketId: ticket.id };
    }
    if (reread[0]?.status === "used") {
      await audit(scannerUser.id, "ticket.checkin", "ticket", ticket.id, { result: "ALREADY_USED", race: true });
      return { result: "ALREADY_USED", ticket, previousScanAt: reread[0]?.used_at, reason: "Ticket has already been admitted" };
    }
    if (reread[0]?.status === "cancelled") {
      await audit(scannerUser.id, "ticket.checkin", "ticket", ticket.id, { result: "CANCELLED" });
      return { result: "CANCELLED", reason: "Ticket has been cancelled or refunded", ticketId: ticket.id };
    }
    return { result: "INVALID", reason: `Ticket status is "${reread[0]?.status || ticket.status}"`, ticketId: ticket.id };
  }

  await audit(scannerUser.id, "ticket.checkin", "ticket", ticket.id, { result: "ADMIT", ticket_number: ticket.ticket_number });
  return { result: "ADMIT", ticket: { ...ticket, ...updated }, checkedInAt: updated.used_at };
}

// verifyOneTicket continues to execute atomic check-in for full backward compatibility with legacy tests
async function verifyOneTicket(qrToken, expectedTicketId, scannerUser) {
  return checkInOneTicket(qrToken, expectedTicketId, scannerUser);
}

// Staff scanner lookup & check-in endpoint (scans from camera or manual entry)
router.post(
  "/scan",
  requireAuth(),
  requireRole("organizer", "admin", "super_admin"),
  rateLimit({ windowMs: 60_000, max: 120, keyFn: (req) => `scan:${req.user.id}` }),
  validate({
    body: z.object({
      qrToken: z.string().min(1),
      action: z.enum(["inspect", "check_in"]).default("inspect"),
      deviceInfo: z.string().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    if (req.body.action === "check_in") {
      const result = await checkInOneTicket(req.body.qrToken, null, req.user, req.body.deviceInfo);
      return res.json(result);
    }
    const result = await inspectOneTicket(req.body.qrToken, null, req.user);
    res.json(result);
  })
);

// Explicit Check-In endpoint for a specific ticket
router.post(
  "/:id/check-in",
  requireAuth(),
  requireRole("organizer", "admin", "super_admin"),
  rateLimit({ windowMs: 60_000, max: 120, keyFn: (req) => `checkin:${req.user.id}` }),
  validate({
    body: z.object({
      qrToken: z.string(),
      deviceInfo: z.string().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const result = await checkInOneTicket(req.body.qrToken, req.params.id, req.user, req.body.deviceInfo);
    res.json(result);
  })
);

// Authorized Check-In Reversal (Staff / Admin reversal with reason and audit trail)
router.post(
  "/:id/reverse-checkin",
  requireAuth(),
  requireRole("organizer", "admin", "super_admin"),
  validate({ body: z.object({ reason: z.string().min(2) }) }),
  asyncHandler(async (req, res) => {
    const updated = await db.withTransaction(async (client) => {
      const { rows: tRows } = await client.query(
        `SELECT t.*, e.club_id, e.university_id, e.status AS event_status, c.lead_user_id,
                tt.price,
                lp.status AS payment_status
         FROM tickets t
         JOIN events e ON e.id = t.event_id
         JOIN clubs c ON c.id = e.club_id
         JOIN ticket_types tt ON tt.id = t.ticket_type_id
         LEFT JOIN LATERAL (
           SELECT p.status FROM payments p WHERE p.transaction_type = 'ticket' AND p.transaction_id = t.id ORDER BY p.created_at DESC LIMIT 1
         ) lp ON true
         WHERE t.id = $1 FOR UPDATE OF t`,
        [req.params.id]
      );
      const ticket = tRows[0];
      if (!ticket) throw notFound("Ticket not found");

      if (req.user.role === "organizer" && ticket.lead_user_id !== req.user.id) throw forbidden();
      if (req.user.role === "admin" && ticket.university_id !== req.user.university_id) throw forbidden();
      if (ticket.status !== "used") throw conflict("Only used tickets can have check-in reversed");
      if (ticket.event_status === "cancelled") throw conflict("Cannot reverse check-in for a cancelled event");
      if (ticket.payment_status === "refunded") throw conflict("Cannot reverse check-in for a refunded ticket");
      if (Number(ticket.price) > 0 && ticket.payment_status && ticket.payment_status !== "confirmed") {
        throw conflict("Cannot reverse check-in for an unpaid ticket");
      }

      const { rows: updRows } = await client.query(
        `UPDATE tickets SET status = 'active', used_at = NULL, used_by = NULL
         WHERE id = $1 AND status = 'used'
           AND (SELECT status FROM events WHERE id = tickets.event_id) != 'cancelled'
           AND NOT EXISTS (
             SELECT 1 FROM payments p WHERE p.transaction_type = 'ticket' AND p.transaction_id = tickets.id AND p.status IN ('refunded', 'failed')
           )
         RETURNING *`,
        [ticket.id]
      );
      if (!updRows[0]) throw conflict("Could not reverse check-in (event cancelled or payment refunded)");

      await client.query(
        `INSERT INTO ticket_checkins (ticket_id, event_id, staff_id, is_reversal, reversed_by, reversed_at, notes)
         VALUES ($1, $2, $3, true, $4, now(), $5)`,
        [ticket.id, ticket.event_id, req.user.id, req.user.id, req.body.reason]
      );
      return updRows[0];
    });

    await audit(req.user.id, "ticket.reverse_checkin", "ticket", req.params.id, { reason: req.body.reason });
    res.json({ success: true, ticket: updated });
  })
);

// Event check-ins log for organizers and administrators
router.get(
  "/event/:eventId/checkins",
  requireAuth(),
  requireRole("organizer", "admin", "super_admin"),
  asyncHandler(async (req, res) => {
    const { rows: evRows } = await db.query(
      `SELECT e.*, c.lead_user_id FROM events e JOIN clubs c ON c.id=e.club_id WHERE e.id=$1`,
      [req.params.eventId]
    );
    const event = evRows[0];
    if (!event) throw notFound("Event not found");
    if (req.user.role === "organizer" && event.lead_user_id !== req.user.id) throw forbidden();
    if (req.user.role === "admin" && event.university_id !== req.user.university_id) throw forbidden();

    const { rows: checkins } = await db.query(
      `SELECT tc.*, u.name AS staff_name, t.ticket_number, tt.name AS ticket_type, hu.name AS holder_name
       FROM ticket_checkins tc
       JOIN users u ON u.id = tc.staff_id
       JOIN tickets t ON t.id = tc.ticket_id
       JOIN ticket_types tt ON tt.id = t.ticket_type_id
       JOIN users hu ON hu.id = t.holder_id
       WHERE tc.event_id = $1
       ORDER BY tc.checked_in_at DESC LIMIT 50`,
      [req.params.eventId]
    );
    res.json({ checkins });
  })
);

// Legacy/Compatibility verification endpoint: supports both check-in (default) and inspection
router.post(
  "/:id/verify",
  requireAuth(),
  requireRole("organizer", "admin", "super_admin"),
  rateLimit({ windowMs: 60_000, max: 120, keyFn: (req) => `verify:${req.user.id}` }),
  validate({
    body: z.object({
      qrToken: z.string(),
      action: z.enum(["inspect", "check_in"]).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    if (req.body.action === "inspect" || req.query.inspect === "true") {
      const result = await inspectOneTicket(req.body.qrToken, req.params.id, req.user);
      return res.json(result);
    }
    const result = await checkInOneTicket(req.body.qrToken, req.params.id, req.user);
    res.json(result);
  })
);

// Phase 2 — offline scan queue & sync (SRS Phase 2 spec, item E)
router.post(
  "/verify-batch",
  requireAuth(),
  requireRole("organizer", "admin", "super_admin"),
  rateLimit({ windowMs: 60_000, max: 20, keyFn: (req) => `verify-batch:${req.user.id}` }),
  validate({
    body: z.object({
      scans: z
        .array(z.object({ ticketId: z.string(), qrToken: z.string(), scannedAt: z.string().optional() }))
        .min(1)
        .max(200),
    }),
  }),
  asyncHandler(async (req, res) => {
    const ordered = [...req.body.scans].sort((a, b) => new Date(a.scannedAt || 0) - new Date(b.scannedAt || 0));
    const results = [];
    for (const scan of ordered) {
      const outcome = await checkInOneTicket(scan.qrToken, scan.ticketId, req.user);
      results.push({ ticketId: scan.ticketId, scannedAt: scan.scannedAt, ...outcome });
    }
    res.json({ results });
  })
);

payments.registerFinalizer("ticket", {
    isOpen: async (ticketId, client) => {
    const { rows } = await client.query("SELECT status FROM tickets WHERE id = $1", [ticketId]);
    return rows[0]?.status === "reserved";
  },
  // For event tickets: student pays the CampusHub admin's designated receiving account.
  // Payments must not go directly to the event organizer.
  getRecipient: async (ticketId) => {
    const { rows } = await db.query(
      `SELECT e.id AS event_id, e.university_id, e.title, tt.name AS ticket_type, c.lead_user_id,
              (SELECT id FROM users WHERE role = 'admin' AND university_id = e.university_id ORDER BY created_at LIMIT 1) AS admin_id
         FROM tickets t
         JOIN events e ON e.id = t.event_id
         JOIN clubs c ON c.id = e.club_id
         JOIN ticket_types tt ON tt.id = t.ticket_type_id
        WHERE t.id = $1`,
      [ticketId]
    );
    if (!rows[0]) return null;
    const r = rows[0];
    let adminUserId = r.admin_id;
    if (!adminUserId) {
      const { rows: superAdmin } = await db.query("SELECT id FROM users WHERE role = 'super_admin' ORDER BY created_at LIMIT 1");
      adminUserId = superAdmin[0]?.id;
    }
    return {
      userId: adminUserId,
      organizerId: r.lead_user_id,
      universityId: r.university_id,
      isCampusHub: true,
      description: `Event Ticket: ${r.title} (${r.ticket_type})`,
    };
  },
  onConfirmed: async (ticketId, client) => {
    const signature = signTicket(ticketId);
    const ticketNumber = generateTicketNumber();
    const { rows } = await client.query(
      "UPDATE tickets SET status='active', qr_token_hash=$1, ticket_number=COALESCE(ticket_number, $3) WHERE id=$2 RETURNING *",
      [signature, ticketId, ticketNumber]
    );
    const ticket = rows[0];
    const ev = await client.query("SELECT title FROM events WHERE id = $1", [ticket.event_id]);
    await client.query("INSERT INTO notifications (user_id, type, title, body) VALUES ($1,'ticket_update',$2,$3)", [
      ticket.holder_id,
      "Your ticket is ready",
      `${ev.rows[0].title} — view your QR code in My Tickets.`,
    ]);
  },
  onFailed: async (ticketId, client) => {
    const { rows } = await client.query("UPDATE tickets SET status='cancelled' WHERE id=$1 RETURNING *", [ticketId]);
    const ticket = rows[0];
    await client.query("UPDATE ticket_types SET quantity_sold = GREATEST(0, quantity_sold - 1) WHERE id = $1", [ticket.ticket_type_id]);
    await client.query("INSERT INTO notifications (user_id, type, title, body) VALUES ($1,'ticket_update',$2,$3)", [
      ticket.holder_id,
      "Ticket payment failed",
      "Your reserved ticket was released. Please try again.",
    ]);
    await notifyWaitlistIfAvailable(ticket.ticket_type_id, client);
  },
  onRefunded: async (ticketId, client, { reason, actorId } = {}) => {
    const { rows } = await client.query("SELECT * FROM tickets WHERE id = $1 FOR UPDATE", [ticketId]);
    const ticket = rows[0];
    if (!ticket) return;
    if (["active", "reserved", "used"].includes(ticket.status)) {
      const wasUsed = ticket.status === "used";
      await client.query("UPDATE tickets SET status='cancelled' WHERE id=$1", [ticketId]);
      if (!wasUsed) {
        await client.query("UPDATE ticket_types SET quantity_sold = GREATEST(0, quantity_sold - 1) WHERE id = $1", [
          ticket.ticket_type_id,
        ]);
        await notifyWaitlistIfAvailable(ticket.ticket_type_id, client);
      }
      const ev = await client.query("SELECT title FROM events WHERE id = $1", [ticket.event_id]);
      const eventTitle = ev.rows[0]?.title || "Event";
      await client.query("INSERT INTO notifications (user_id, type, title, body) VALUES ($1,'ticket_update',$2,$3)", [
        ticket.holder_id,
        "Ticket refunded",
        `Your ticket for "${eventTitle}" was refunded and cancelled.`,
      ]);
    }
  },
});

module.exports = router;
