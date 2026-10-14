// Payout accounts: where a merchant / event organizer / seller wants students to
// send money for manual payments. Students see these only through a specific
// payment they started (see manual.routes.js), never as a public directory.
const express = require("express");
const { z } = require("zod");
const db = require("../../db");
const { requireAuth } = require("../../middleware/auth");
const { validate } = require("../../middleware/validate");
const { asyncHandler, notFound, badRequest } = require("../../utils/errors");
const { audit } = require("../../utils/notify");

const router = express.Router();

const METHODS = ["cbe", "telebirr", "awash", "dashen", "abyssinia", "other"];
const accountBody = z.object({
  method: z.enum(METHODS),
  accountName: z.string().trim().min(2).max(80),
  accountNumber: z.string().trim().min(4).max(40),
  instructions: z.string().trim().max(300).optional(),
  isDefault: z.boolean().optional(),
});

const out = (a) => ({
  id: a.id, method: a.method, accountName: a.account_name, accountNumber: a.account_number,
  instructions: a.instructions, isDefault: a.is_default, createdAt: a.created_at,
});

router.get(
  "/",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      "SELECT * FROM payout_accounts WHERE owner_id = $1 AND active ORDER BY is_default DESC, created_at",
      [req.user.id]
    );
    res.json({ accounts: rows.map(out) });
  })
);

router.post(
  "/",
  requireAuth(),
  validate({ body: accountBody }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const account = await db.withTransaction(async (client) => {
      const { rows: existing } = await client.query("SELECT count(*)::int AS n FROM payout_accounts WHERE owner_id = $1 AND active", [req.user.id]);
      if (existing[0].n >= 5) throw badRequest("You can save up to 5 payout accounts");
      const makeDefault = b.isDefault === true || existing[0].n === 0;
      if (makeDefault) await client.query("UPDATE payout_accounts SET is_default = false WHERE owner_id = $1", [req.user.id]);
      const { rows } = await client.query(
        `INSERT INTO payout_accounts (university_id, owner_id, method, account_name, account_number, instructions, is_default)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [req.user.university_id, req.user.id, b.method, b.accountName, b.accountNumber, b.instructions || null, makeDefault]
      );
      return rows[0];
    });
    await audit(req.user.id, "payout_account.create", "payout_account", account.id, { method: account.method });
    res.status(201).json({ account: out(account) });
  })
);

router.patch(
  "/:id",
  requireAuth(),
  validate({ body: accountBody.partial() }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const account = await db.withTransaction(async (client) => {
      const { rows } = await client.query("SELECT * FROM payout_accounts WHERE id = $1 AND owner_id = $2 AND active FOR UPDATE", [req.params.id, req.user.id]);
      if (!rows[0]) throw notFound("Payout account not found");
      if (b.isDefault === true) await client.query("UPDATE payout_accounts SET is_default = false WHERE owner_id = $1", [req.user.id]);
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
    await audit(req.user.id, "payout_account.update", "payout_account", account.id, null);
    res.json({ account: out(account) });
  })
);

// Soft delete: payments already started keep their own snapshot of the details.
router.delete(
  "/:id",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      "UPDATE payout_accounts SET active = false, is_default = false WHERE id = $1 AND owner_id = $2 AND active RETURNING id",
      [req.params.id, req.user.id]
    );
    if (!rows[0]) throw notFound("Payout account not found");
    await audit(req.user.id, "payout_account.delete", "payout_account", rows[0].id, null);
    res.json({ ok: true });
  })
);

module.exports = router;