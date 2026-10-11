const { verifyAccessToken } = require("../utils/jwt");
const { unauthorized, forbidden } = require("../utils/errors");
const db = require("../db");

// Verifies the JWT and attaches { id, role, universityId } to req.user.
// Also re-checks suspended status against the DB so a suspension takes
// effect immediately rather than only after the access token expires.
function requireAuth() {
  return async (req, res, next) => {
    try {
      const header = req.headers.authorization || "";
      const [scheme, token] = header.split(" ");
      if (scheme !== "Bearer" || !token) throw unauthorized();
      const payload = verifyAccessToken(token);

      const { rows } = await db.query(
        "SELECT id, role, suspended, university_id, verified, name, email FROM users WHERE id = $1",
        [payload.sub]
      );
      const user = rows[0];
      if (!user) throw unauthorized("Account no longer exists");
      if (user.suspended) throw forbidden("This account has been suspended");

      req.user = user;
      next();
    } catch (err) {
      if (err.status) return next(err);
      next(unauthorized("Invalid or expired token"));
    }
  };
}

// requireRole('merchant', 'admin') — the caller's role must be one of these.
// Never trust a role claimed by the client outside this check.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden(`Requires role: ${roles.join(" or ")}`));
    next();
  };
}

// Populates req.user if a valid token is present, but does not reject the
// request otherwise. Useful for endpoints that are public but behave
// differently when the caller is logged in (e.g., product browsing).
function optionalAuth() {
  return async (req, res, next) => {
    const header = req.headers.authorization || "";
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token) return next();
    try {
      const payload = verifyAccessToken(token);
      const { rows } = await db.query("SELECT id, role, suspended, university_id FROM users WHERE id = $1", [payload.sub]);
      if (rows[0] && !rows[0].suspended) req.user = rows[0];
    } catch (_) {
      // ignore invalid token on optional-auth routes
    }
    next();
  };
}

module.exports = { requireAuth, requireRole, optionalAuth };
