const express = require("express");
const db = require("../../db");
const { optionalAuth } = require("../../middleware/auth");
const { asyncHandler, notFound } = require("../../utils/errors");
const { assertSameTenant } = require("../../middleware/tenant");

const router = express.Router();

const LISTING_LIMIT = 12;

function verificationFor(store, applicationStatus) {
  const campusVerified = !!store.owner_verified;
  if (store.owner_suspended) {
    return { status: "suspended", label: "Suspended", verified: false, campusVerified };
  }
  if (applicationStatus === "approved" || store.store_status === "active") {
    return { status: "verified", label: "Verified Seller", verified: true, campusVerified };
  }
  if (applicationStatus === "pending_review") {
    return { status: "pending", label: "Verification Pending", verified: false, campusVerified };
  }
  return { status: "unverified", label: "Not Verified", verified: false, campusVerified };
}

function breakdownFor(rows) {
  const counts = {};
  for (const row of rows) counts[row.rating] = Number(row.count);
  return [5, 4, 3, 2, 1].map((rating) => ({ rating, count: counts[rating] || 0 }));
}

// FR-006/FR-007 companion — public seller (store) profile. This is a
// read-only, unauthenticated-by-default view that shares exactly the data the
// marketplace already exposes per product, plus the store's published contact
// details. It never returns the merchant's email unless the merchant chose to
// publish one in `stores.public_email`.
router.get(
  "/:id",
  optionalAuth(),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT s.id, s.name, s.description, s.logo_url, s.cover_image_url, s.category,
              s.public_email, s.public_phone, s.status AS store_status, s.created_at,
              s.merchant_id, s.university_id,
              u.name AS owner_name, u.created_at AS owner_since, u.verified AS owner_verified,
              u.suspended AS owner_suspended,
              un.name AS university_name, un.slug AS university_slug
       FROM stores s
       JOIN users u ON u.id = s.merchant_id
       LEFT JOIN universities un ON un.id = s.university_id
       WHERE s.id = $1`,
      [req.params.id]
    );
    const store = rows[0];
    if (!store) throw notFound("Seller not found");
    assertSameTenant(req, store.university_id, "Seller");

    const application = await db.query(
      "SELECT status FROM merchant_applications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
      [store.merchant_id]
    );

    const stats = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM products WHERE store_id = $1 AND status = 'active')::int AS active_listings,
         (SELECT COUNT(*) FROM orders  WHERE store_id = $1 AND status = 'completed')::int AS completed_sales`,
      [store.id]
    );

    const aggregate = await db.query(
      `SELECT COALESCE(AVG(rating),0)::float AS avg_rating, COUNT(*)::int AS review_count
       FROM reviews WHERE target_type = 'store' AND target_id = $1`,
      [store.id]
    );
    const ratingRows = await db.query(
      `SELECT rating, COUNT(*)::int AS count FROM reviews
       WHERE target_type = 'store' AND target_id = $1 GROUP BY rating`,
      [store.id]
    );

    const listings = await db.query(
      `SELECT p.id, p.title, p.price, p.stock, p.images, p.created_at, p.featured_until,
              c.name AS category_name, p.category_id,
              (p.featured_until IS NOT NULL AND p.featured_until > now()) AS is_featured,
              COALESCE(AVG(r.rating),0)::float AS avg_rating, COUNT(r.id)::int AS review_count
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN reviews r ON r.target_type = 'product' AND r.target_id = p.id
       WHERE p.store_id = $1 AND p.status = 'active'
       GROUP BY p.id, c.name
       ORDER BY is_featured DESC, p.created_at DESC
       LIMIT ${LISTING_LIMIT}`,
      [store.id]
    );

    res.json({
      seller: {
        id: store.id,
        name: store.name,
        description: store.description,
        logoUrl: store.logo_url,
        coverImageUrl: store.cover_image_url,
        category: store.category,
        university: { name: store.university_name, slug: store.university_slug },
        ownerName: store.owner_name,
        memberSince: store.created_at,
        publicEmail: store.public_email,
        publicPhone: store.public_phone,
        verification: verificationFor(store, application.rows[0]?.status),
        stats: {
          activeListings: stats.rows[0].active_listings,
          completedSales: stats.rows[0].completed_sales,
          avgRating: aggregate.rows[0].avg_rating,
          reviewCount: aggregate.rows[0].review_count,
          ratingBreakdown: breakdownFor(ratingRows.rows),
        },
      },
      listings: listings.rows,
      listingsTotal: stats.rows[0].active_listings,
      isOwner: !!(req.user && req.user.id === store.merchant_id),
    });
  })
);

module.exports = router;
