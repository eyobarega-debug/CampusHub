const express = require("express");
const { z } = require("zod");
const db = require("../../db");
const { requireAuth, requireRole } = require("../../middleware/auth");
const { validate } = require("../../middleware/validate");
const { rateLimit } = require("../../middleware/rateLimit");
const { asyncHandler, notFound, forbidden, conflict } = require("../../utils/errors");
const { audit, notify } = require("../../utils/notify");
const { signTicket, buildQrPayload, parseQrPayload, isValidSignature, qrPayloadToDataUrl } = require("../../utils/qr");
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
      `SELECT t.*, e.title AS event_title, e.date_time, e.location, tt.name AS ticket_type, tt.price,
              lp.id AS payment_id, lp.status AS payment_status, lp.provider AS payment_provider,
              lp.reject_reason AS payment_reject_reason
       FROM tickets t JOIN events e ON e.id = t.event_id JOIN ticket_types tt ON tt.id = t.ticket_type_id
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
        if (t.status !== "active") return { ...t, qrDataUrl: null };
        const payload = buildQrPayload(t.id, signTicket(t.id));
        return { ...t, qrDataUrl: await qrPayloadToDataUrl(payload) };
      })
    );
    res.json({ tickets: withQr });
  })
);

// FR-033 — cancel a ticket (buyer-initiated, within policy — kept simple:
// allowed any time before the event starts, for demo purposes)
router.post(
  "/:id/cancel",
  requireAuth(),
  validate({ body: z.object({ reason: z.string().optional() }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query("SELECT t.*, e.date_time, e.title FROM tickets t JOIN events e ON e.id=t.event_id WHERE t.id=$1", [
      req.params.id,
    ]);
    const ticket = rows[0];
    if (!ticket) throw notFound("Ticket not found");
    if (ticket.holder_id !== req.user.id) throw forbidden();
    if (ticket.status !== "active") throw conflict("Only active tickets can be cancelled");
    if (new Date(ticket.date_time) < new Date()) throw conflict("This event has already started");

    await db.query("UPDATE tickets SET status='cancelled' WHERE id=$1", [ticket.id]);
    await db.query("UPDATE ticket_types SET quantity_sold = GREATEST(0, quantity_sold - 1) WHERE id = $1", [ticket.ticket_type_id]);
    await notifyWaitlistIfAvailable(ticket.ticket_type_id);

    const payRows = await db.query("SELECT * FROM payments WHERE transaction_type='ticket' AND transaction_id=$1 AND status='confirmed'", [
      ticket.id,
    ]);
    if (payRows.rows[0]) {
      await payments.refundPayment(payRows.rows[0].id, null, req.body.reason || "Buyer cancellation", req.user.id);
    }
    res.json({ success: true });
  })
);

// FR-031 / FR-032 — THE critical endpoint: scan-time verification with
// atomic duplicate-use prevention. A single UPDATE ... WHERE status='active'
// is what makes this race-safe: Postgres locks the row for the duration of
// the update, so two near-simultaneous scans of the same ticket cannot both
// see status='active' and both succeed — the second one's WHERE clause will
// simply match zero rows once the first has committed.
// The atomic single-ticket verification core, shared by both the online
// (single-scan) and offline-queue (batch) endpoints below, so there is
// exactly one place implementing the security-critical duplicate-use guard.
async function verifyOneTicket(qrToken, expectedTicketId, scannerUser) {
  const parsed = parseQrPayload(qrToken);
  if (!parsed || (expectedTicketId && parsed.ticketId !== expectedTicketId)) {
    await audit(scannerUser.id, "ticket.verify", "ticket", expectedTicketId, { result: "INVALID", reason: "malformed_token" });
    return { result: "INVALID", reason: "Malformed or mismatched QR token", ticketId: expectedTicketId };
  }
  if (!isValidSignature(parsed.ticketId, parsed.signature)) {
    await audit(scannerUser.id, "ticket.verify", "ticket", parsed.ticketId, { result: "INVALID", reason: "bad_signature" });
    return { result: "INVALID", reason: "This QR code was not issued by CampusHub (signature mismatch)", ticketId: parsed.ticketId };
  }

  const { rows: ticketRows } = await db.query(
    `SELECT t.*, e.title AS event_title, e.club_id, e.date_time FROM tickets t JOIN events e ON e.id=t.event_id WHERE t.id = $1`,
    [parsed.ticketId]
  );
  const ticket = ticketRows[0];
  if (!ticket) return { result: "INVALID", reason: "Ticket does not exist", ticketId: parsed.ticketId };

  if (scannerUser.role === "organizer") {
    const club = await db.query("SELECT id FROM clubs WHERE id = $1 AND lead_user_id = $2", [ticket.club_id, scannerUser.id]);
    if (!club.rows[0]) throw forbidden("You are not authorized to scan tickets for this event");
  }

  if (ticket.status === "used") {
    await audit(scannerUser.id, "ticket.verify", "ticket", ticket.id, { result: "ALREADY_USED" });
    return { result: "ALREADY_USED", ticket, previousScanAt: ticket.used_at };
  }
  if (ticket.status !== "active") {
    await audit(scannerUser.id, "ticket.verify", "ticket", ticket.id, { result: "INVALID", reason: ticket.status });
    return { result: "INVALID", reason: `Ticket status is "${ticket.status}"`, ticketId: ticket.id };
  }

  // The atomic guard: only succeeds if status is STILL 'active' at the moment of the UPDATE.
  const { rows: updated } = await db.query(
    `UPDATE tickets SET status = 'used', used_at = now(), used_by = $1
     WHERE id = $2 AND status = 'active' RETURNING *`,
    [scannerUser.id, ticket.id]
  );

  if (!updated[0]) {
    await audit(scannerUser.id, "ticket.verify", "ticket", ticket.id, { result: "ALREADY_USED", race: true });
    const { rows: reread } = await db.query("SELECT used_at FROM tickets WHERE id = $1", [ticket.id]);
    return { result: "ALREADY_USED", ticket, previousScanAt: reread[0]?.used_at };
  }

  await audit(scannerUser.id, "ticket.verify", "ticket", ticket.id, { result: "ADMIT" });
  return { result: "ADMIT", ticket: updated[0] };
}

router.post(
  "/:id/verify",
  requireAuth(),
  requireRole("organizer", "admin"),
  rateLimit({ windowMs: 60_000, max: 120, keyFn: (req) => `verify:${req.user.id}` }),
  validate({ body: z.object({ qrToken: z.string() }) }),
  asyncHandler(async (req, res) => {
    const result = await verifyOneTicket(req.body.qrToken, req.params.id, req.user);
    res.json(result);
  })
);

// Phase 2 — offline scan queue & sync (SRS Phase 2 spec, item E). An
// organizer's scanning app can keep validating QR codes' *signatures*
// locally while offline (the signature check needs no server round-trip —
// see utils/qr.js), queue the scans, and POST them all here once
// connectivity returns. Entries are processed in client-reported
// chronological order (oldest scannedAt first) so that, within one synced
// batch, the scan that actually happened first is the one that wins
// ADMIT — not whichever happened to reach the server first. This does NOT
// achieve perfect fairness across two different devices syncing at
// different times (that would need a shared queue, which is out of scope
// for Phase 2) — it only guarantees correct ordering within a single
// device's queued batch, which is the case that actually matters (one
// scanner, spotty connectivity, catching up once back online).
router.post(
  "/verify-batch",
  requireAuth(),
  requireRole("organizer", "admin"),
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
      const outcome = await verifyOneTicket(scan.qrToken, scan.ticketId, req.user);
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
  // The organizer who gets paid is the lead of the club running the event.
  getRecipient: async (ticketId) => {
    const { rows } = await db.query(
      `SELECT c.lead_user_id, e.title, tt.name AS ticket_type
         FROM tickets t
         JOIN events e ON e.id = t.event_id
         JOIN clubs c ON c.id = e.club_id
         JOIN ticket_types tt ON tt.id = t.ticket_type_id
        WHERE t.id = $1`,
      [ticketId]
    );
    if (!rows[0]) return null;
    return { userId: rows[0].lead_user_id, description: `Ticket: ${rows[0].title} (${rows[0].ticket_type})` };
  },
  onConfirmed: async (ticketId, client) => {
    const signature = signTicket(ticketId);
    const { rows } = await client.query(
      "UPDATE tickets SET status='active', qr_token_hash=$1 WHERE id=$2 RETURNING *",
      [signature, ticketId]
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
});

module.exports = router;
