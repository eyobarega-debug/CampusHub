const express = require("express");
const db = require("../../db");
const { asyncHandler } = require("../../utils/errors");

const router = express.Router();

router.get(
  "/universities",
  asyncHandler(async (req, res) => {
    const { rows } = await db.query("SELECT id, name, domain FROM universities WHERE status = 'active' ORDER BY name");
    res.json({ universities: rows });
  })
);

router.get(
  "/categories",
  asyncHandler(async (req, res) => {
    const { rows } = await db.query("SELECT id, name, parent_category_id FROM categories ORDER BY name");
    res.json({ categories: rows });
  })
);

module.exports = router;
