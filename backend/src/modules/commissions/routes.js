// Commission ledger views.
//   Seller (student renting out, merchant, organizer): GET /mine — only their own sales and what they owe.
//   Admin: GET /admin/sellers — every seller listed individually, then drill into one seller's ledger
//          and mark it settled once the seller has paid the platform.
const express = require("express");
const { z } = require("zod");
const db = require("../../db");
const { requireAuth } = require("../../middleware/auth");
const { validate } = require("../../middleware/validate");
const { asyncHandler, forbidden, notFound, conflict } = require("../../utils/errors");
const { notify, audit } = require("../../utils/notify");
const { RATES } = require("../../services/commissions");

const router = express.Router();

const isAdmin = (u) => u.role === "admin" || u.role === "super_admin";
const requireAdmin = (req, res, next) => (isAdmin(req.user) ? next() : next(forbidden("Admins only")));

// University scoping: an admin only sees their own university; the super admin sees everything.
function scope(user, params, alias = "c") {
  if (user.role === "super_admin") return "";
  params.push(user.university_id);
  return ` AND ${alias}.university_id = $${params.length}`;
}

const entryOut = (r) => ({
  id: r.id,
  transactionType: r.transaction_type,
  description: r.description,
  sellerId: r.payee_id,
  sellerRole: r.payee_role,
  saleAmount: Number(r.gross_amount),
  baseAmount: Number(r.base_amount),
  rate: Number(r.rate),
  commission: Number(r.commission_amount),
  status: r.status,
  settledAt: r.settled_at,
  settleNote: r.settle_note,
  createdAt: r.created_at,
});

const SUMMARY_SQL = `
  count(*) FILTER (WHERE c.status <> 'void')::int AS sales_count,
  COALESCE(SUM(c.gross_amount) FILTER (WHERE c.status <> 'void'), 0)::float AS gross,
  COALESCE(SUM(c.commission_amount) FILTER (WHERE c.status = 'due'), 0)::float AS due,
  COALESCE(SUM(c.commission_amount) FILTER (WHERE c.status = 'settled'), 0)::float AS settled`;

const summaryOut = (s) => ({ salesCount: s.sales_count, grossSales: s.gross, commissionDue: s.due, commissionSettled: s.settled });

const listQuery = z.object({ status: z.enum(["due", "settled", "void", "all"]).default("all") });

router.get("/rates", requireAuth(), (req, res) => {
  res.json({ rates: { order: RATES.order, ticket: RATES.ticket, booking: RATES.booking } });
});

// --- Seller: my own ledger ----------------------------------------------------
router.get(
  "/mine",
  requireAuth(),
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const { rows: s } = await db.query(`SELECT ${SUMMARY_SQL} FROM commissions c WHERE c.payee_id = $1`, [req.user.id]);
    const params = [req.user.id];
    let where = "c.payee_id = $1";
    if (req.query.status !== "all") {
      params.push(req.query.status);
      where += ` AND c.status = $${params.length}`;
    }
    const { rows } = await db.query(`SELECT c.* FROM commissions c WHERE ${where} ORDER BY c.created_at DESC LIMIT 200`, params);
    res.json({ summary: summaryOut(s[0]), entries: rows.map(entryOut) });
  })
);

// --- Admin: every seller individually ----------------------------------------
router.get(
  "/admin/sellers",
  requireAuth(),
  requireAdmin,
  asyncHandler(async (req, res) => {
    const params = [];
    const sc = scope(req.user, params);
    const { rows } = await db.query(
      `SELECT c.payee_id AS user_id, u.name, u.email, u.role, ${SUMMARY_SQL},
              COALESCE(SUM(c.commission_amount) FILTER (WHERE c.status <> 'void' AND c.transaction_type = 'order'), 0)::float AS by_order,
              COALESCE(SUM(c.commission_amount) FILTER (WHERE c.status <> 'void' AND c.transaction_type = 'ticket'), 0)::float AS by_ticket,
              COALESCE(SUM(c.commission_amount) FILTER (WHERE c.status <> 'void' AND c.transaction_type = 'booking'), 0)::float AS by_booking,
              COALESCE(SUM(c.commission_amount) FILTER (WHERE c.status <> 'void' AND c.transaction_type NOT IN ('order','ticket','booking')), 0)::float AS by_other
         FROM commissions c JOIN users u ON u.id = c.payee_id
        WHERE true ${sc}
        GROUP BY c.payee_id, u.name, u.email, u.role
        ORDER BY due DESC, u.name`,
      params
    );
    const sellers = rows.map((r) => ({
      userId: r.user_id,
      name: r.name,
      email: r.email,
      role: r.role,
      ...summaryOut(r),
      byType: { shop: r.by_order, tickets: r.by_ticket, rentals: r.by_booking, other: r.by_other },
    }));
    res.json({ sellers });
  })
);

router.get(
  "/admin/sellers/:userId",
  requireAuth(),
  requireAdmin,
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const params = [req.params.userId];
    const sc = scope(req.user, params);
    const { rows: seller } = await db.query("SELECT id, name, email, role FROM users WHERE id = $1", [req.params.userId]);
    if (!seller[0]) throw notFound("Seller not found");
    const { rows: s } = await db.query(`SELECT ${SUMMARY_SQL} FROM commissions c WHERE c.payee_id = $1 ${sc}`, params);
    let statusSql = "";
    if (req.query.status !== "all") {
      params.push(req.query.status);
      statusSql = ` AND c.status = $${params.length}`;
    }
    const { rows } = await db.query(
      `SELECT c.* FROM commissions c WHERE c.payee_id = $1 ${sc} ${statusSql} ORDER BY c.created_at DESC LIMIT 500`,
      params
    );
    res.json({ seller: seller[0], summary: summaryOut(s[0]), entries: rows.map(entryOut) });
  })
);

// --- Admin: mark commissions as paid by the seller ----------------------------
const settleBody = z.object({ note: z.string().trim().max(200).optional() });

async function settle(req, res, { where, params, sellerId }) {
  const sc = scope(req.user, params);
  const noteIdx = params.push(req.body.note || null);
  const adminIdx = params.push(req.user.id);
  const { rows } = await db.query(
    `UPDATE commissions c SET status = 'settled', settled_at = now(), settled_by = $${adminIdx}, settle_note = $${noteIdx}
      WHERE ${where} AND c.status = 'due' ${sc} RETURNING c.*`,
    params
  );
  if (!rows.length) throw conflict("There is no unsettled commission to mark as paid", "NOTHING_DUE");
  const total = rows.reduce((t, r) => t + Number(r.commission_amount), 0);
  const seller = sellerId || rows[0].payee_id;
  await audit(req.user.id, "commission.settle", "commission", rows[0].id, { sellerId: seller, count: rows.length, total });
  await notify(seller, "commission_update", "Commission settled", `${rows.length} commission record(s) totalling ${total.toFixed(2)} birr were marked as paid.`);
  res.json({ settled: rows.length, total: Math.round(total * 100) / 100 });
}

router.post(
  "/admin/sellers/:userId/settle",
  requireAuth(),
  requireAdmin,
  validate({ body: settleBody }),
  asyncHandler((req, res) => settle(req, res, { where: "c.payee_id = $1", params: [req.params.userId], sellerId: req.params.userId }))
);

router.post(
  "/admin/:id/settle",
  requireAuth(),
  requireAdmin,
  validate({ body: settleBody }),
  asyncHandler((req, res) => settle(req, res, { where: "c.id = $1", params: [req.params.id] }))
);

module.exports = router;