const express = require("express");
const { z } = require("zod");
const db = require("../../db");
const { requireAuth } = require("../../middleware/auth");
const { validate } = require("../../middleware/validate");
const { asyncHandler, forbidden } = require("../../utils/errors");

const router = express.Router();

router.get(
  "/me",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT id, name, email, phone, role, university_id, verified, verification_method, avatar_url, bio,
              notification_prefs, created_at
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    res.json({ user: rows[0] });
  })
);

const updateSchema = z.object({
  name: z.string().min(2).optional(),
  phone: z.string().optional(),
  avatarUrl: z.string().url().optional(),
  bio: z.string().max(1000).optional(),
  notificationPrefs: z.record(z.boolean()).optional(),
  // Explicitly rejected below even if present — FR-005 alt flow: role/
  // verification are admin-only fields.
  role: z.any().optional(),
  verified: z.any().optional(),
});

router.patch(
  "/me",
  requireAuth(),
  validate({ body: updateSchema }),
  asyncHandler(async (req, res) => {
    if (req.body.role !== undefined || req.body.verified !== undefined) {
      throw forbidden("role and verified can only be changed by a university administrator");
    }
    const { name, phone, avatarUrl, bio, notificationPrefs } = req.body;
    const { rows } = await db.query(
      `UPDATE users SET
         name = COALESCE($1, name),
         phone = COALESCE($2, phone),
         avatar_url = COALESCE($3, avatar_url),
         bio = COALESCE($4, bio),
         notification_prefs = COALESCE($5, notification_prefs)
       WHERE id = $6
       RETURNING id, name, email, phone, role, university_id, verified, avatar_url, bio, notification_prefs`,
      [name, phone, avatarUrl, bio, notificationPrefs ? JSON.stringify(notificationPrefs) : null, req.user.id]
    );
    res.json({ user: rows[0] });
  })
);

module.exports = router;
