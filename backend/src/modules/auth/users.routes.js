const express = require("express");
const { z } = require("zod");
const db = require("../../db");
const { requireAuth } = require("../../middleware/auth");
const { validate } = require("../../middleware/validate");
const { asyncHandler, forbidden, badRequest, notFound } = require("../../utils/errors");
const { hashPassword, comparePassword } = require("../../utils/hash");
const { audit } = require("../../utils/notify");

const router = express.Router();

// GET /api/users/me — full profile for currently authenticated user
router.get(
  "/me",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT u.id, u.name, u.email, u.phone, u.role, u.university_id, u.verified, u.verification_method,
              u.avatar_url, u.cover_image_url, u.bio, u.department, u.year,
              u.privacy_settings, u.notification_prefs, u.email_verified, u.suspended, u.created_at,
              uni.name AS university_name, uni.domain AS university_domain
       FROM users u
       LEFT JOIN universities uni ON uni.id = u.university_id
       WHERE u.id = $1`,
      [req.user.id]
    );
    if (!rows[0]) throw notFound("User not found");
    res.json({ user: rows[0] });
  })
);

// Flexible image validator allowing URLs, local uploads (/uploads/...), or empty string / null (to clear)
const imageSchema = z
  .union([
    z.string().url(),
    z.string().regex(/^\/uploads\/[a-zA-Z0-9_\-./]+$/),
    z.literal(""),
    z.null(),
  ])
  .optional()
  .nullable();

const updateSchema = z.object({
  name: z.string().min(2).optional(),
  phone: z.string().optional().nullable(),
  avatarUrl: imageSchema,
  coverImageUrl: imageSchema,
  bio: z.string().max(1000).optional().nullable(),
  department: z.string().max(100).optional().nullable(),
  year: z.string().max(50).optional().nullable(),
  privacySettings: z
    .object({
      showEmail: z.boolean().optional(),
      showPhone: z.boolean().optional(),
      showActivity: z.boolean().optional(),
    })
    .optional(),
  notificationPrefs: z.record(z.boolean()).optional(),
  // Explicitly rejected fields (FR-005 alt flow: role / verification / university are protected)
  role: z.any().optional(),
  verified: z.any().optional(),
  emailVerified: z.any().optional(),
  suspended: z.any().optional(),
  universityId: z.any().optional(),
  id: z.any().optional(),
});

// PATCH /api/users/me — update own profile information
router.patch(
  "/me",
  requireAuth(),
  validate({ body: updateSchema }),
  asyncHandler(async (req, res) => {
    if (
      req.body.role !== undefined ||
      req.body.verified !== undefined ||
      req.body.emailVerified !== undefined ||
      req.body.suspended !== undefined ||
      req.body.universityId !== undefined ||
      req.body.id !== undefined
    ) {
      throw forbidden("Role, verification status, university affiliation, and account ID cannot be changed by user");
    }

    const { name, phone, avatarUrl, coverImageUrl, bio, department, year, privacySettings, notificationPrefs } = req.body;
    const updates = [];
    const values = [];

    if (name !== undefined) {
      values.push(name.trim());
      updates.push(`name = $${values.length}`);
    }
    if (phone !== undefined) {
      values.push(phone ? phone.trim() : null);
      updates.push(`phone = $${values.length}`);
    }
    if (avatarUrl !== undefined) {
      values.push(avatarUrl ? avatarUrl.trim() : null);
      updates.push(`avatar_url = $${values.length}`);
    }
    if (coverImageUrl !== undefined) {
      values.push(coverImageUrl ? coverImageUrl.trim() : null);
      updates.push(`cover_image_url = $${values.length}`);
    }
    if (bio !== undefined) {
      values.push(bio ? bio.trim() : null);
      updates.push(`bio = $${values.length}`);
    }
    if (department !== undefined) {
      values.push(department ? department.trim() : null);
      updates.push(`department = $${values.length}`);
    }
    if (year !== undefined) {
      values.push(year ? year.trim() : null);
      updates.push(`year = $${values.length}`);
    }
    if (privacySettings !== undefined) {
      values.push(JSON.stringify(privacySettings));
      updates.push(`privacy_settings = COALESCE(privacy_settings, '{}'::jsonb) || $${values.length}::jsonb`);
    }
    if (notificationPrefs !== undefined) {
      values.push(JSON.stringify(notificationPrefs));
      updates.push(`notification_prefs = COALESCE(notification_prefs, '{}'::jsonb) || $${values.length}::jsonb`);
    }

    if (updates.length > 0) {
      values.push(req.user.id);
      await db.query(
        `UPDATE users SET ${updates.join(", ")} WHERE id = $${values.length}`,
        values
      );
      await audit(req.user.id, "user.profile_update", "user", req.user.id, {
        fields: Object.keys(req.body).filter((k) => req.body[k] !== undefined),
      });
    }

    const { rows } = await db.query(
      `SELECT u.id, u.name, u.email, u.phone, u.role, u.university_id, u.verified, u.verification_method,
              u.avatar_url, u.cover_image_url, u.bio, u.department, u.year,
              u.privacy_settings, u.notification_prefs, u.email_verified, u.suspended, u.created_at,
              uni.name AS university_name, uni.domain AS university_domain
       FROM users u
       LEFT JOIN universities uni ON uni.id = u.university_id
       WHERE u.id = $1`,
      [req.user.id]
    );

    res.json({ user: rows[0] });
  })
);

// POST /api/users/me/password — change password verifying current password
const passwordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: z.string().min(8, "New password must be at least 8 characters"),
});

router.post(
  "/me/password",
  requireAuth(),
  validate({ body: passwordSchema }),
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const { rows } = await db.query("SELECT password_hash FROM users WHERE id = $1", [req.user.id]);
    if (!rows[0] || !(await comparePassword(currentPassword, rows[0].password_hash))) {
      throw badRequest("Current password is incorrect", "INVALID_CURRENT_PASSWORD");
    }

    const newHash = await hashPassword(newPassword);
    await db.query("UPDATE users SET password_hash = $1 WHERE id = $2", [newHash, req.user.id]);
    // Revoke refresh tokens to invalidate other active sessions
    await db.query("UPDATE refresh_tokens SET revoked = true WHERE user_id = $1", [req.user.id]);
    await audit(req.user.id, "user.password_change", "user", req.user.id, {});

    res.json({ success: true, message: "Password updated successfully. Other sessions have been signed out." });
  })
);

// GET /api/users/me/stats — role-specific profile statistics
router.get(
  "/me/stats",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const role = req.user.role;
    let stats = {};

    if (role === "student") {
      const [ordersRes, bookingsRes, listingsRes, ticketsRes, favsRes, reviewsRes] = await Promise.all([
        db.query("SELECT count(*)::int AS count FROM orders WHERE buyer_id = $1", [userId]),
        db.query("SELECT count(*)::int AS count FROM rental_bookings WHERE borrower_id = $1", [userId]),
        db.query("SELECT count(*)::int AS count FROM p2p_listings WHERE seller_id = $1 AND status <> 'removed'", [userId]),
        db.query("SELECT count(*)::int AS count FROM tickets WHERE holder_id = $1 AND status IN ('active', 'used')", [userId]),
        db.query("SELECT count(*)::int AS count FROM favorites WHERE user_id = $1", [userId]),
        db.query("SELECT count(*)::int AS count FROM reviews WHERE author_id = $1", [userId]),
      ]);
      stats = {
        ordersCount: ordersRes.rows[0]?.count || 0,
        bookingsCount: bookingsRes.rows[0]?.count || 0,
        listingsCount: listingsRes.rows[0]?.count || 0,
        ticketsCount: ticketsRes.rows[0]?.count || 0,
        favoritesCount: favsRes.rows[0]?.count || 0,
        reviewsGiven: reviewsRes.rows[0]?.count || 0,
      };
    } else if (role === "merchant") {
      const storeRes = await db.query("SELECT id, name, status, logo_url FROM stores WHERE merchant_id = $1", [userId]);
      const store = storeRes.rows[0] || null;
      if (store) {
        const [productsRes, activeListingsRes, ordersRes, completedRes, revenueRes, ratingRes] = await Promise.all([
          db.query("SELECT count(*)::int AS count FROM products WHERE store_id = $1 AND status <> 'removed'", [store.id]),
          db.query("SELECT count(*)::int AS count FROM products WHERE store_id = $1 AND status = 'active'", [store.id]),
          db.query("SELECT count(*)::int AS count FROM orders WHERE store_id = $1", [store.id]),
          db.query("SELECT count(*)::int AS count FROM orders WHERE store_id = $1 AND status = 'completed'", [store.id]),
          db.query("SELECT COALESCE(SUM(total_amount), 0)::numeric AS sum FROM orders WHERE store_id = $1 AND status = 'completed'", [store.id]),
          db.query("SELECT COALESCE(AVG(rating), 0)::numeric(3,1) AS avg, count(*)::int AS count FROM reviews WHERE target_type = 'store' AND target_id = $1", [store.id]),
        ]);
        stats = {
          hasStore: true,
          storeId: store.id,
          storeName: store.name,
          storeStatus: store.status,
          totalProducts: productsRes.rows[0]?.count || 0,
          activeProducts: activeListingsRes.rows[0]?.count || 0,
          totalOrders: ordersRes.rows[0]?.count || 0,
          completedOrders: completedRes.rows[0]?.count || 0,
          totalRevenue: Number(revenueRes.rows[0]?.sum || 0),
          averageRating: Number(ratingRes.rows[0]?.avg || 0),
          ratingCount: ratingRes.rows[0]?.count || 0,
        };
      } else {
        stats = { hasStore: false, totalProducts: 0, activeProducts: 0, totalOrders: 0, completedOrders: 0, totalRevenue: 0, averageRating: 0, ratingCount: 0 };
      }
    } else if (role === "organizer") {
      const clubRes = await db.query("SELECT id, name, status FROM clubs WHERE lead_user_id = $1", [userId]);
      const club = clubRes.rows[0] || null;
      if (club) {
        const [totalEvents, upcomingEvents, completedEvents, ticketsSold, attendees] = await Promise.all([
          db.query("SELECT count(*)::int AS count FROM events WHERE club_id = $1", [club.id]),
          db.query("SELECT count(*)::int AS count FROM events WHERE club_id = $1 AND date_time > now() AND status IN ('published', 'approved')", [club.id]),
          db.query("SELECT count(*)::int AS count FROM events WHERE club_id = $1 AND (date_time <= now() OR status = 'completed')", [club.id]),
          db.query(
            `SELECT count(t.id)::int AS count FROM tickets t
             JOIN events e ON e.id = t.event_id
             WHERE e.club_id = $1 AND t.status IN ('active', 'used')`,
            [club.id]
          ),
          db.query(
            `SELECT count(t.id)::int AS count FROM tickets t
             JOIN events e ON e.id = t.event_id
             WHERE e.club_id = $1 AND t.status = 'used'`,
            [club.id]
          ),
        ]);
        stats = {
          hasClub: true,
          clubId: club.id,
          clubName: club.name,
          clubStatus: club.status,
          totalEvents: totalEvents.rows[0]?.count || 0,
          upcomingEvents: upcomingEvents.rows[0]?.count || 0,
          completedEvents: completedEvents.rows[0]?.count || 0,
          ticketsSold: ticketsSold.rows[0]?.count || 0,
          totalAttendees: attendees.rows[0]?.count || 0,
        };
      } else {
        stats = { hasClub: false, totalEvents: 0, upcomingEvents: 0, completedEvents: 0, ticketsSold: 0, totalAttendees: 0 };
      }
    } else if (role === "admin" || role === "super_admin") {
      const uniId = role === "super_admin" ? null : req.user.university_id;
      const [usersCount, merchantsCount, clubsCount, openReports, ordersTotal, revTotal] = await Promise.all([
        db.query("SELECT count(*)::int AS count FROM users WHERE ($1::uuid IS NULL OR university_id = $1)", [uniId]),
        db.query("SELECT count(*)::int AS count FROM stores WHERE ($1::uuid IS NULL OR university_id = $1)", [uniId]),
        db.query("SELECT count(*)::int AS count FROM clubs WHERE ($1::uuid IS NULL OR university_id = $1)", [uniId]),
        db.query("SELECT count(*)::int AS count FROM reports WHERE status = 'open' AND ($1::uuid IS NULL OR university_id = $1)", [uniId]),
        db.query("SELECT count(*)::int AS count FROM orders WHERE ($1::uuid IS NULL OR university_id = $1)", [uniId]),
        db.query("SELECT COALESCE(SUM(total_amount), 0)::numeric AS sum FROM orders WHERE status = 'completed' AND ($1::uuid IS NULL OR university_id = $1)", [uniId]),
      ]);
      stats = {
        usersManaged: usersCount.rows[0]?.count || 0,
        merchantsCount: merchantsCount.rows[0]?.count || 0,
        clubsCount: clubsCount.rows[0]?.count || 0,
        openReports: openReports.rows[0]?.count || 0,
        totalOrders: ordersTotal.rows[0]?.count || 0,
        platformRevenue: Number(revTotal.rows[0]?.sum || 0),
      };
    }

    res.json({ role, stats });
  })
);

// GET /api/users/me/activity — personal activity feed
router.get(
  "/me/activity",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const role = req.user.role;
    let activities = [];

    if (role === "student") {
      const [orders, bookings, listings, tickets] = await Promise.all([
        db.query(
          `SELECT o.id, o.status, o.total_amount, o.created_at, s.name AS store_name
           FROM orders o JOIN stores s ON s.id = o.store_id
           WHERE o.buyer_id = $1 ORDER BY o.created_at DESC LIMIT 5`,
          [userId]
        ),
        db.query(
          `SELECT b.id, b.status, b.start_date, b.end_date, b.created_at, ri.title AS item_title
           FROM rental_bookings b JOIN rental_items ri ON ri.id = b.rental_item_id
           WHERE b.borrower_id = $1 ORDER BY b.created_at DESC LIMIT 5`,
          [userId]
        ),
        db.query(
          `SELECT id, title, price, status, created_at FROM p2p_listings
           WHERE seller_id = $1 ORDER BY created_at DESC LIMIT 5`,
          [userId]
        ),
        db.query(
          `SELECT t.id, t.status, t.created_at, e.title AS event_title, e.date_time
           FROM tickets t JOIN events e ON e.id = t.event_id
           WHERE t.holder_id = $1 ORDER BY t.created_at DESC LIMIT 5`,
          [userId]
        ),
      ]);

      activities = [
        ...orders.rows.map((r) => ({
          type: "order",
          id: r.id,
          title: `Order at ${r.store_name}`,
          subtitle: `Amount: $${r.total_amount} · Status: ${r.status}`,
          status: r.status,
          date: r.created_at,
          link: "/orders",
        })),
        ...bookings.rows.map((r) => ({
          type: "rental",
          id: r.id,
          title: `Rental: ${r.item_title}`,
          subtitle: `${r.start_date} to ${r.end_date} · Status: ${r.status}`,
          status: r.status,
          date: r.created_at,
          link: "/rentals",
        })),
        ...listings.rows.map((r) => ({
          type: "listing",
          id: r.id,
          title: `Listing: ${r.title}`,
          subtitle: `$${r.price} · Status: ${r.status}`,
          status: r.status,
          date: r.created_at,
          link: "/marketplace",
        })),
        ...tickets.rows.map((r) => ({
          type: "ticket",
          id: r.id,
          title: `Event: ${r.event_title}`,
          subtitle: `Date: ${new Date(r.date_time).toLocaleDateString()} · Status: ${r.status}`,
          status: r.status,
          date: r.created_at,
          link: "/events",
        })),
      ].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 15);
    } else if (role === "merchant") {
      const storeRes = await db.query("SELECT id FROM stores WHERE merchant_id = $1", [userId]);
      const storeId = storeRes.rows[0]?.id;
      if (storeId) {
        const [orders, products] = await Promise.all([
          db.query(
            `SELECT o.id, o.status, o.total_amount, o.created_at, u.name AS customer_name
             FROM orders o JOIN users u ON u.id = o.buyer_id
             WHERE o.store_id = $1 ORDER BY o.created_at DESC LIMIT 10`,
            [storeId]
          ),
          db.query(
            `SELECT id, title, price, status, created_at FROM products
             WHERE store_id = $1 ORDER BY created_at DESC LIMIT 10`,
            [storeId]
          ),
        ]);
        activities = [
          ...orders.rows.map((o) => ({
            type: "order",
            id: o.id,
            title: `Customer order from ${o.customer_name}`,
            subtitle: `$${o.total_amount} · Status: ${o.status}`,
            status: o.status,
            date: o.created_at,
            link: "/merchant/orders",
          })),
          ...products.rows.map((p) => ({
            type: "product",
            id: p.id,
            title: `Product: ${p.title}`,
            subtitle: `$${p.price} · Status: ${p.status}`,
            status: p.status,
            date: p.created_at,
            link: "/merchant/products",
          })),
        ].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 15);
      }
    } else if (role === "organizer") {
      const clubRes = await db.query("SELECT id FROM clubs WHERE lead_user_id = $1", [userId]);
      const clubId = clubRes.rows[0]?.id;
      if (clubId) {
        const eventsRes = await db.query(
          `SELECT id, title, date_time, status, created_at FROM events
           WHERE club_id = $1 ORDER BY created_at DESC LIMIT 10`,
          [clubId]
        );
        activities = eventsRes.rows.map((e) => ({
          type: "event",
          id: e.id,
          title: `Event: ${e.title}`,
          subtitle: `Scheduled: ${new Date(e.date_time).toLocaleDateString()} · Status: ${e.status}`,
          status: e.status,
          date: e.created_at,
          link: "/organizer/events",
        }));
      }
    } else if (role === "admin" || role === "super_admin") {
      const logs = await db.query(
        `SELECT id, action, target_type, target_id, created_at
         FROM audit_logs
         WHERE actor_id = $1 ORDER BY created_at DESC LIMIT 15`,
        [userId]
      );
      activities = logs.rows.map((l) => ({
        type: "audit",
        id: l.id,
        title: `Action: ${l.action}`,
        subtitle: `Target: ${l.target_type} (${l.target_id || "general"})`,
        status: "logged",
        date: l.created_at,
        link: "/admin/audit",
      }));
    }

    res.json({ activities });
  })
);

// GET /api/users/:id/public — public profile with privacy filtering & role-specific showcases
router.get(
  "/:id/public",
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT u.id, u.name, u.role, u.university_id, u.verified, u.verification_method,
              u.avatar_url, u.cover_image_url, u.bio, u.department, u.year,
              u.email, u.phone, u.privacy_settings, u.created_at,
              uni.name AS university_name
       FROM users u
       LEFT JOIN universities uni ON uni.id = u.university_id
       WHERE u.id = $1 AND u.suspended = false`,
      [req.params.id]
    );
    const user = rows[0];
    if (!user) throw notFound("Profile not found or unavailable");

    const privacy = user.privacy_settings || { showEmail: false, showPhone: false, showActivity: true };
    const publicUser = {
      id: user.id,
      name: user.name,
      role: user.role,
      universityId: user.university_id,
      universityName: user.university_name,
      verified: user.verified,
      avatarUrl: user.avatar_url,
      coverImageUrl: user.cover_image_url,
      bio: user.bio,
      department: user.department,
      year: user.year,
      createdAt: user.created_at,
      email: privacy.showEmail ? user.email : null,
      phone: privacy.showPhone ? user.phone : null,
    };

    let roleData = {};
    if (privacy.showActivity !== false) {
      if (user.role === "merchant") {
        const storeRes = await db.query(
          `SELECT id, name, logo_url, description, status, created_at FROM stores
           WHERE merchant_id = $1 AND status = 'active'`,
          [user.id]
        );
        const store = storeRes.rows[0] || null;
        if (store) {
          const [productsRes, ratingsRes] = await Promise.all([
            db.query(
              `SELECT id, title, description, price, images, status, created_at FROM products
               WHERE store_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 12`,
              [store.id]
            ),
            db.query(
              `SELECT COALESCE(AVG(rating), 0)::numeric(3,1) AS avg, count(*)::int AS count
               FROM reviews WHERE target_type = 'store' AND target_id = $1`,
              [store.id]
            ),
          ]);
          roleData = {
            store,
            activeProducts: productsRes.rows,
            rating: Number(ratingsRes.rows[0]?.avg || 0),
            reviewCount: ratingsRes.rows[0]?.count || 0,
          };
        }
      } else if (user.role === "organizer") {
        const clubRes = await db.query(
          `SELECT id, name, status, created_at FROM clubs
           WHERE lead_user_id = $1 AND status = 'active'`,
          [user.id]
        );
        const club = clubRes.rows[0] || null;
        if (club) {
          const eventsRes = await db.query(
            `SELECT id, title, description, date_time, location, capacity, status, created_at FROM events
             WHERE club_id = $1 AND status IN ('published', 'approved') AND date_time > now()
             ORDER BY date_time ASC LIMIT 10`,
            [club.id]
          );
          roleData = {
            club,
            upcomingEvents: eventsRes.rows,
          };
        }
      } else if (user.role === "student") {
        const [listingsRes, rentalsRes, reviewsRes] = await Promise.all([
          db.query(
            `SELECT id, title, description, price, condition, images, created_at FROM p2p_listings
             WHERE seller_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 10`,
            [user.id]
          ),
          db.query(
            `SELECT id, title, description, price_per_day, deposit, images, created_at FROM rental_items
             WHERE owner_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 10`,
            [user.id]
          ),
          db.query(
            `SELECT COALESCE(AVG(rating), 0)::numeric(3,1) AS avg, count(*)::int AS count
             FROM reviews WHERE target_type = 'user' AND target_id = $1`,
            [user.id]
          ),
        ]);
        roleData = {
          activeListings: listingsRes.rows,
          activeRentals: rentalsRes.rows,
          sellerRating: Number(reviewsRes.rows[0]?.avg || 0),
          reviewCount: reviewsRes.rows[0]?.count || 0,
        };
      }
    }

    res.json({ user: publicUser, roleData });
  })
);

module.exports = router;
