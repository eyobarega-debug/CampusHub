const express = require("express");
const db = require("../../db");
const { requireAuth } = require("../../middleware/auth");
const { asyncHandler, notFound, forbidden } = require("../../utils/errors");

const router = express.Router();

router.get(
  "/",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const unreadOnly = req.query.unreadOnly === "true";
    const { rows } = await db.query(
      `SELECT * FROM notifications WHERE user_id = $1 ${unreadOnly ? "AND read_at IS NULL" : ""}
       ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    const unread = await db.query("SELECT COUNT(*) FROM notifications WHERE user_id=$1 AND read_at IS NULL", [req.user.id]);
    res.json({ notifications: rows, unreadCount: Number(unread.rows[0].count) });
  })
);

router.patch(
  "/:id/read",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query("SELECT * FROM notifications WHERE id = $1", [req.params.id]);
    if (!rows[0]) throw notFound("Notification not found");
    if (rows[0].user_id !== req.user.id) throw forbidden();
    await db.query("UPDATE notifications SET read_at = now() WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  })
);

router.post(
  "/read-all",
  requireAuth(),
  asyncHandler(async (req, res) => {
    await db.query("UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL", [req.user.id]);
    res.json({ success: true });
  })
);

module.exports = router;
