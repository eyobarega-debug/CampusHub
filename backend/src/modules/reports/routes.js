const express = require("express");
const { z } = require("zod");
const db = require("../../db");
const { requireAuth } = require("../../middleware/auth");
const { validate } = require("../../middleware/validate");
const { asyncHandler } = require("../../utils/errors");
const { notify } = require("../../utils/notify");

const router = express.Router();

router.post(
  "/",
  requireAuth(),
  validate({
    body: z.object({
      targetType: z.enum(["product", "listing", "user", "store", "event"]),
      targetId: z.string().uuid(),
      reason: z.string().min(2),
      details: z.string().max(2000).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      "INSERT INTO reports (reporter_id, target_type, target_id, reason, details) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [req.user.id, req.body.targetType, req.body.targetId, req.body.reason, req.body.details || null]
    );
    const admins = await db.query("SELECT id FROM users WHERE role = 'admin'");
    await Promise.all(admins.rows.map((a) => notify(a.id, "report", "New report filed", `${req.body.targetType}: ${req.body.reason}`)));
    res.status(201).json({ report: rows[0] });
  })
);

module.exports = router;
