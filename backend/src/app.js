const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const helmet = require("helmet");
require("dotenv").config({ quiet: true });

const { errorHandler } = require("./utils/errors");
const { resolveTenant, requireFeature } = require("./middleware/tenant");
const tenant = resolveTenant();

const app = express();

// SRS Section 15: baseline security headers (CSP, HSTS, X-Frame-Options,
// etc.). CSP is disabled here because this app serves a JSON API only —
// the frontend is a separate Vite/React app with its own CSP concerns.
app.use(helmet({ contentSecurityPolicy: false }));
const allowedOrigins = (process.env.CORS_ORIGINS || "http://localhost:5173,http://localhost:4173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
app.use(cors({
  origin(origin, callback) {
    // Requests without Origin include health checks and server-to-server calls.
    callback(null, !origin || allowedOrigins.includes(origin));
  },
}));
app.use(express.json({ limit: "2mb" }));
app.use(morgan(process.env.NODE_ENV === "test" ? "tiny" : "dev"));
app.use("/uploads", express.static(require("path").join(__dirname, "..", "uploads")));

app.get("/health", (req, res) => res.json({ ok: true, service: "campushub-api", time: new Date().toISOString() }));

app.use("/api/auth", require("./modules/auth/routes"));
app.use("/api/users", require("./modules/auth/users.routes"));
app.use("/api/merchants", tenant, require("./modules/merchants/routes"));
app.use("/api/products", tenant, require("./modules/products/routes"));
app.use("/api/sellers", tenant, require("./modules/sellers/routes"));
app.use("/api/orders", tenant, require("./modules/orders/routes"));
app.use("/api/listings", tenant,requireFeature("p2p"), require("./modules/listings/routes"));
app.use("/api/rentals", tenant,requireFeature("rentals"), require("./modules/rentals/routes"));
app.use("/api/events", tenant,requireFeature("events"), require("./modules/events/routes"));
app.use("/api/tickets", tenant,requireFeature("events"), require("./modules/tickets/routes"));
// FR-028 lives at /api/events/:eventId/tickets, so this is a separate router
// mounted under /api/events (see modules/tickets/purchase.routes.js).
app.use("/api/events", tenant,requireFeature("events"), require("./modules/tickets/purchase.routes"));
app.use("/api/reviews", tenant, require("./modules/reviews/routes"));
app.use("/api/reports", tenant, require("./modules/reports/routes"));
app.use("/api/notifications", tenant, require("./modules/notifications/routes"));
// Manual payment-with-proof routes must come first: the generic payments router below has GET /:id.
app.use("/api/payments", tenant, require("./modules/payments/manual.routes"));
app.use("/api/payout-accounts", tenant, require("./modules/payments/payout.routes"));
app.use("/api/commissions", tenant, require("./modules/commissions/routes"));
app.use("/api/payments", tenant, require("./modules/payments/routes"));
app.use("/api/super", require("./modules/super/routes"));
// Verified campus accounts: student submission/status + admin review queue.
// Mounted BEFORE /api/admin so the admin router's blanket middleware never
// intercepts these paths.
app.use("/api/admin/verifications", tenant, require("./modules/verifications/admin.routes"));
app.use("/api/admin", tenant, require("./modules/admin/routes"));
app.use("/api/verifications", tenant, require("./modules/verifications/routes"));
app.use("/api/meta", require("./modules/meta/routes"));
app.use("/api/uploads", require("./modules/uploads/routes"));

app.use((req, res) => res.status(404).json({ error: { code: "NOT_FOUND", message: `No route for ${req.method} ${req.path}` } }));
app.use(errorHandler);

module.exports = app;
