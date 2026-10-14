const express = require("express");
const { z } = require("zod");
const db = require("../../db");
const { requireAuth } = require("../../middleware/auth");
const { validate } = require("../../middleware/validate");
const { asyncHandler, badRequest, notFound, forbidden, conflict } = require("../../utils/errors");
const { notify } = require("../../utils/notify");
const payments = require("../../services/payments");

const { scopeTo, assertSameTenant } = require("../../middleware/tenant");
const router = express.Router();

const lateFeePolicySchema = z
  .array(z.object({ upToDays: z.number().int().positive().nullable(), ratePerDay: z.number().nonnegative() }))
  .min(1)
  .optional();

// Phase 2 tiered late-fee escalation (SRS Phase 2 spec, item C). Walks the
// policy tiers in order and sums the fee owed for each day of the overdue
// period, so e.g. a 5-day-late return under
// [{upToDays:2,ratePerDay:0.5},{upToDays:null,ratePerDay:1.0}]
// charges 2 days at 0.5x + 3 days at 1.0x, not a flat rate for the whole
// period. Falls back to the flat Phase 1 default (0.5x/day) when the item
// has no policy configured, so nothing breaks for pre-Phase-2 listings.
function computeLateFee(pricePerDay, policy, daysLate) {
  if (daysLate <= 0) return 0;
  const tiers = Array.isArray(policy) && policy.length ? policy : [{ upToDays: null, ratePerDay: 0.5 }];
  let remaining = daysLate;
  let dayCursor = 0;
  let total = 0;
  for (const tier of tiers) {
    if (remaining <= 0) break;
    const tierLength = tier.upToDays == null ? remaining : Math.max(0, tier.upToDays - dayCursor);
    const daysInTier = Math.min(remaining, tierLength);
    total += daysInTier * Number(pricePerDay) * Number(tier.ratePerDay);
    remaining -= daysInTier;
    dayCursor += daysInTier;
  }
  return Math.round(total * 100) / 100;
}

// FR-019 — search rental items (only overlap-checked against dates if given)
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { q, category, startDate, endDate } = req.query;
    const conditions = ["ri.status = 'active'"];
    const params = [];
    if (q) {
      params.push(`%${q}%`);
      conditions.push(`(ri.title ILIKE $${params.length} OR ri.description ILIKE $${params.length})`);
    }
    if (category) {
      params.push(category);
      conditions.push(`ri.category_id = $${params.length}`);
    }
    if (startDate && endDate) {
      params.push(startDate, endDate);
      conditions.push(`ri.available_from <= $${params.length - 1} AND ri.available_to >= $${params.length}`);
      conditions.push(`NOT EXISTS (
        SELECT 1 FROM rental_bookings b
        WHERE b.rental_item_id = ri.id
          AND b.status IN ('pending_payment','confirmed_awaiting_pickup','active','overdue')
          AND b.start_date <= $${params.length} AND b.end_date >= $${params.length - 1}
      )`);
    }
    scopeTo(req, "ri.university_id", conditions, params);
    const { rows } = await db.query(
      `SELECT ri.*, u.name AS owner_name FROM rental_items ri JOIN users u ON u.id = ri.owner_id
       WHERE ${conditions.join(" AND ")} ORDER BY ri.created_at DESC LIMIT 40`,
      params
    );
    res.json({ items: rows });
  })
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT ri.*, u.name AS owner_name FROM rental_items ri JOIN users u ON u.id = ri.owner_id WHERE ri.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) throw notFound("Rental item not found");
    assertSameTenant(req, rows[0].university_id, "Rental item");
    res.json({ item: rows[0] });
  })
);

// FR-017 — list an item for rent
router.post(
  "/",
  requireAuth(),
  validate({
    body: z.object({
      title: z.string().min(2),
      description: z.string().optional(),
      categoryId: z.string().uuid().optional(),
      pricePerDay: z.number().nonnegative(),
      deposit: z.number().nonnegative().default(0),
      availableFrom: z.string(),
      availableTo: z.string(),
      images: z.array(z.string()).optional(),
      lateFeePolicy: lateFeePolicySchema,
    }),
  }),
  asyncHandler(async (req, res) => {
    if (!req.user.verified) throw forbidden("Verify your student account before listing a rental item");
    if (new Date(req.body.availableFrom) >= new Date(req.body.availableTo)) {
      throw badRequest("availableFrom must be before availableTo");
    }
    const { rows } = await db.query(
      `INSERT INTO rental_items (owner_id, title, description, category_id, price_per_day, deposit, available_from, available_to, images, late_fee_policy)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        req.user.id,
        req.body.title,
        req.body.description || null,
        req.body.categoryId || null,
        req.body.pricePerDay,
        req.body.deposit,
        req.body.availableFrom,
        req.body.availableTo,
        req.body.images || [],
        req.body.lateFeePolicy ? JSON.stringify(req.body.lateFeePolicy) : null,
      ]
    );
    res.status(201).json({ item: rows[0] });
  })
);

// FR-018 — manage availability/pricing (blocked if it would conflict with an active booking)
router.patch(
  "/:id",
  requireAuth(),
  validate({
    body: z.object({
      pricePerDay: z.number().nonnegative().optional(),
      deposit: z.number().nonnegative().optional(),
      availableFrom: z.string().optional(),
      availableTo: z.string().optional(),
      status: z.enum(["active", "removed"]).optional(),
      lateFeePolicy: lateFeePolicySchema,
    }),
  }),
  asyncHandler(async (req, res) => {
    const { rows: existingRows } = await db.query("SELECT * FROM rental_items WHERE id = $1", [req.params.id]);
    if (!existingRows[0]) throw notFound("Rental item not found");
    if (existingRows[0].owner_id !== req.user.id) throw forbidden();

    if (req.body.availableFrom || req.body.availableTo) {
      const activeBookings = await db.query(
        "SELECT id FROM rental_bookings WHERE rental_item_id = $1 AND status IN ('confirmed_awaiting_pickup','active','overdue')",
        [req.params.id]
      );
      if (activeBookings.rows.length) throw conflict("Cannot change dates while a booking is confirmed or active");
    }

    const b = req.body;
    const { rows } = await db.query(
      `UPDATE rental_items SET
        price_per_day = COALESCE($1,price_per_day), deposit = COALESCE($2,deposit),
        available_from = COALESCE($3,available_from), available_to = COALESCE($4,available_to),
        status = COALESCE($5,status), late_fee_policy = COALESCE($6,late_fee_policy)
       WHERE id = $7 RETURNING *`,
      [b.pricePerDay, b.deposit, b.availableFrom, b.availableTo, b.status, b.lateFeePolicy ? JSON.stringify(b.lateFeePolicy) : null, req.params.id]
    );
    res.json({ item: rows[0] });
  })
);

// FR-019 — book a rental item
router.post(
  "/:id/bookings",
  requireAuth(),
  validate({ body: z.object({ startDate: z.string(), endDate: z.string(), paymentMethod: z.enum(["online", "manual"]).optional() }) }),
  asyncHandler(async (req, res) => {
    if (!req.user.verified) throw forbidden("Verify your student account before booking a rental");
    const { startDate, endDate } = req.body;
    if (new Date(startDate) >= new Date(endDate)) throw badRequest("startDate must be before endDate");

    const booking = await db.withTransaction(async (client) => {
      const { rows: itemRows } = await client.query("SELECT * FROM rental_items WHERE id = $1 FOR UPDATE", [req.params.id]);
      const item = itemRows[0];
      if (!item || item.status !== "active") throw notFound("Rental item not available");
      assertSameTenant(req, item.university_id, "Rental item");
      if (item.owner_id === req.user.id) throw conflict("You cannot book your own rental item");
      if (new Date(startDate) < new Date(item.available_from) || new Date(endDate) > new Date(item.available_to)) {
        throw badRequest("Requested dates fall outside this item's availability window");
      }

      const overlap = await client.query(
        `SELECT id FROM rental_bookings
         WHERE rental_item_id = $1 AND status IN ('pending_payment','confirmed_awaiting_pickup','active','overdue')
           AND start_date <= $3 AND end_date >= $2`,
        [item.id, startDate, endDate]
      );
      if (overlap.rows.length) throw conflict("Those dates were just booked by someone else — please choose different dates", "DATES_UNAVAILABLE");

      const days = Math.max(1, Math.ceil((new Date(endDate) - new Date(startDate)) / 86400000));
      const total = Number(item.price_per_day) * days + Number(item.deposit);

      const { rows } = await client.query(
        `INSERT INTO rental_bookings (rental_item_id, borrower_id, start_date, end_date, status, total_amount)
         VALUES ($1,$2,$3,$4,'pending_payment',$5) RETURNING *`,
        [item.id, req.user.id, startDate, endDate, total]
      );
      return rows[0];
    });

    const payment = await payments.initiatePayment({
      transactionType: "booking",
      transactionId: booking.id,
      amount: booking.total_amount,
      buyerId: req.user.id,
      method: req.body.paymentMethod,
    });
    res.status(201).json({ booking, payment });
  })
);

async function loadBookingWithItem(id) {
  const { rows } = await db.query(
    `SELECT b.*, ri.owner_id, ri.title, ri.price_per_day, ri.deposit, ri.late_fee_policy
     FROM rental_bookings b JOIN rental_items ri ON ri.id = b.rental_item_id WHERE b.id = $1`,
    [id]
  );
  return rows[0];
}

router.get(
  "/bookings/mine",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT b.*, ri.title, ri.owner_id FROM rental_bookings b JOIN rental_items ri ON ri.id = b.rental_item_id
       WHERE b.borrower_id = $1 OR ri.owner_id = $1 ORDER BY b.created_at DESC`,
      [req.user.id]
    );
    // FR-021 — surface overdue status computed at read time
    const now = new Date();
    const withStatus = rows.map((b) => {
      if (b.status === "active" && new Date(b.end_date) < now) return { ...b, status: "overdue" };
      return b;
    });
    res.json({ bookings: withStatus });
  })
);

// FR-020 — confirm pickup (either party can confirm for this MVP demo; a
// production version might require both parties to tap "confirm")
router.post(
  "/bookings/:id/pickup",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const booking = await loadBookingWithItem(req.params.id);
    if (!booking) throw notFound("Booking not found");
    if (![booking.owner_id, booking.borrower_id].includes(req.user.id)) throw forbidden();
    if (booking.status !== "confirmed_awaiting_pickup") throw conflict("Booking is not awaiting pickup");

    const { rows } = await db.query(
      "UPDATE rental_bookings SET status='active', picked_up_at=now() WHERE id=$1 RETURNING *",
      [booking.id]
    );
    await notify(booking.borrower_id, "rental_update", `Pickup confirmed for "${booking.title}"`, `Due back ${booking.end_date}`);
    res.json({ booking: rows[0] });
  })
);

// FR-022 — confirm return, release deposit, apply tiered late fee (Phase 2)
router.post(
  "/bookings/:id/return",
  requireAuth(),
  validate({ body: z.object({ condition: z.string().optional(), lateFeePerDay: z.number().nonnegative().optional() }) }),
  asyncHandler(async (req, res) => {
    const booking = await loadBookingWithItem(req.params.id);
    if (!booking) throw notFound("Booking not found");
    if (booking.owner_id !== req.user.id) throw forbidden("Only the lender confirms a return");
    if (!["active"].includes(booking.status) && new Date(booking.end_date) >= new Date()) {
      throw conflict("Booking is not active");
    }

    const now = new Date();
    const daysLate = Math.max(0, Math.ceil((now - new Date(booking.end_date)) / 86400000));
    // An explicit lateFeePerDay in the request overrides the item's tiered
    // policy entirely (kept for backward compatibility with Phase 1 callers
    // and as an escape hatch for one-off manual adjustments); otherwise the
    // item's configured tiers apply via computeLateFee.
    const lateFee = req.body.lateFeePerDay != null
      ? Math.round(daysLate * req.body.lateFeePerDay * 100) / 100
      : computeLateFee(booking.price_per_day, booking.late_fee_policy, daysLate);
    const depositReleased = Math.max(0, Number(booking.deposit) - lateFee);
    const depositStatus = lateFee > 0 ? "partially_released" : "released";

    const { rows } = await db.query(
      `UPDATE rental_bookings SET status='completed', returned_at=now(), return_condition=$1,
         late_fee=$2, deposit_status=$3 WHERE id=$4 RETURNING *`,
      [req.body.condition || null, lateFee, depositStatus, booking.id]
    );
    await notify(
      booking.borrower_id,
      "rental_update",
      `Return confirmed for "${booking.title}"`,
      lateFee > 0
        ? `A late fee of ${lateFee} was deducted from your deposit. ${depositReleased} released.`
        : `Your full deposit of ${booking.deposit} has been released.`
    );
    res.json({ booking: rows[0], daysLate, lateFee, depositReleased });
  })
);

// FR-023 — dispute
router.post(
  "/bookings/:id/dispute",
  requireAuth(),
  validate({ body: z.object({ reason: z.string().min(3), evidenceUrls: z.array(z.string()).optional() }) }),
  asyncHandler(async (req, res) => {
    const booking = await loadBookingWithItem(req.params.id);
    if (!booking) throw notFound("Booking not found");
    if (![booking.owner_id, booking.borrower_id].includes(req.user.id)) throw forbidden();

    const { rows } = await db.query(
      "INSERT INTO disputes (booking_id, raised_by, reason, evidence) VALUES ($1,$2,$3,$4) RETURNING *",
      [booking.id, req.user.id, req.body.reason, req.body.evidenceUrls || []]
    );
    await db.query("UPDATE rental_bookings SET status='disputed' WHERE id=$1 AND status NOT IN ('completed','cancelled')", [booking.id]);
    res.status(201).json({ dispute: rows[0] });
  })
);

payments.registerFinalizer("booking", {
    isOpen: async (bookingId, client) => {
    const { rows } = await client.query("SELECT status FROM rental_bookings WHERE id = $1", [bookingId]);
    return rows[0]?.status === "pending_payment";
  },
  getRecipient: async (bookingId) => {
    const { rows } = await db.query(
      `SELECT ri.owner_id, ri.title, b.start_date, b.end_date
         FROM rental_bookings b JOIN rental_items ri ON ri.id = b.rental_item_id WHERE b.id = $1`,
      [bookingId]
    );
    if (!rows[0]) return null;
    return { userId: rows[0].owner_id, description: `Rental: ${rows[0].title} (${rows[0].start_date} to ${rows[0].end_date})` };
  },
  onConfirmed: async (bookingId, client) => {
    const { rows } = await client.query(
      "UPDATE rental_bookings SET status='confirmed_awaiting_pickup' WHERE id=$1 RETURNING *",
      [bookingId]
    );
    const booking = rows[0];
    const item = await client.query("SELECT owner_id, title FROM rental_items WHERE id = $1", [booking.rental_item_id]);
    await client.query("INSERT INTO notifications (user_id, type, title, body) VALUES ($1,'rental_update',$2,$3)", [
      item.rows[0].owner_id,
      "New rental booking",
      `"${item.rows[0].title}" booked for ${booking.start_date} to ${booking.end_date}`,
    ]);
    await client.query("INSERT INTO notifications (user_id, type, title, body) VALUES ($1,'rental_update',$2,$3)", [
      booking.borrower_id,
      "Booking confirmed",
      `Arrange pickup for "${item.rows[0].title}"`,
    ]);
  },
  onFailed: async (bookingId, client) => {
    await client.query("UPDATE rental_bookings SET status='cancelled' WHERE id=$1", [bookingId]);
  },
});

module.exports = router;
