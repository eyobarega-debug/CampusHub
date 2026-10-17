const { verifyAccessToken } = require("../utils/jwt");
const { unauthorized, forbidden, notFound } = require("../utils/errors");
const db = require("../db");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Verifies the JWT and attaches { id, role, university_id, universityId } to req.user.
// Enforces suspended user status, unverified email status, and suspended/archived
// university status against the database immediately.
// Establishes trusted req.tenant context from authoritative DB record and rejects
// any forged client tenant headers/parameters.
function requireAuth() {
  return async (req, res, next) => {
    try {
      const header = req.headers.authorization || "";
      const [scheme, token] = header.split(" ");
      if (scheme !== "Bearer" || !token) throw unauthorized();
      const payload = verifyAccessToken(token);

      const { rows } = await db.query(
        `SELECT u.id, u.role, u.suspended, u.university_id, u.verified, u.name, u.email, u.email_verified,
                uni.id AS uni_id, uni.name AS uni_name, uni.slug AS uni_slug, uni.domain AS uni_domain,
                uni.status AS uni_status, uni.feature_flags AS uni_feature_flags, uni.isolation_mode AS uni_isolation_mode
         FROM users u
         LEFT JOIN universities uni ON uni.id = u.university_id
         WHERE u.id = $1`,
        [payload.sub]
      );
      const user = rows[0];
      if (!user) throw unauthorized("Account no longer exists");
      if (user.suspended) throw forbidden("This account has been suspended", "ACCOUNT_SUSPENDED");
      if (user.email_verified === false) throw forbidden("Please verify your email address", "EMAIL_NOT_VERIFIED");

      const requested = req.headers?.["x-university-id"] || req.headers?.["x-university-slug"] || req.query?.universityId || null;

      if (user.role === "super_admin") {
        user.universityId = user.university_id;
        req.user = user;
        if (!req.tenant) {
          if (requested) {
            const col = UUID_RE.test(requested) ? "id" : "slug";
            const uniRes = await db.query(
              `SELECT id, name, slug, domain, status, feature_flags, isolation_mode FROM universities WHERE ${col} = $1`,
              [requested]
            );
            const university = uniRes.rows[0];
            if (!university) throw notFound("University not found");
            req.tenant = { universityId: university.id, isSuper: true, university };
          } else {
            req.tenant = { universityId: null, isSuper: true, university: null };
          }
        }
        return next();
      }

      // Non-superadmin: enforce tenant association and active status
      if (!user.university_id || !user.uni_id) {
        throw forbidden("Your account is not attached to a valid university", "TENANT_INVALID");
      }

      if (user.uni_status !== "active") {
        const code = user.uni_status === "suspended" ? "TENANT_SUSPENDED" : user.uni_status === "archived" ? "TENANT_ARCHIVED" : "TENANT_INACTIVE";
        throw forbidden(`This university is ${user.uni_status}. Access is disabled.`, code);
      }

      // Reject tenant header spoofing
      if (requested && requested !== user.university_id && requested !== user.uni_slug) {
        throw forbidden("You cannot access another university's data", "TENANT_MISMATCH");
      }

      // Always establish trusted req.tenant
      if (!req.tenant) {
        req.tenant = {
          universityId: user.university_id,
          isSuper: false,
          university: {
            id: user.uni_id,
            name: user.uni_name,
            slug: user.uni_slug,
            domain: user.uni_domain,
            status: user.uni_status,
            feature_flags: user.uni_feature_flags,
            isolation_mode: user.uni_isolation_mode,
          },
        };
      }

      user.universityId = user.university_id;
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
      const { rows } = await db.query(
        `SELECT u.id, u.role, u.suspended, u.university_id, u.verified, u.name, u.email, u.email_verified,
                uni.id AS uni_id, uni.name AS uni_name, uni.slug AS uni_slug, uni.domain AS uni_domain,
                uni.status AS uni_status, uni.feature_flags AS uni_feature_flags, uni.isolation_mode AS uni_isolation_mode
         FROM users u
         LEFT JOIN universities uni ON uni.id = u.university_id
         WHERE u.id = $1`,
        [payload.sub]
      );
      const user = rows[0];
      if (user && !user.suspended && user.email_verified !== false) {
        if (user.role === "super_admin") {
          user.universityId = user.university_id;
          req.user = user;
          if (!req.tenant) {
            req.tenant = { universityId: null, isSuper: true, university: null };
          }
        } else if (user.uni_id && user.uni_status === "active") {
          user.universityId = user.university_id;
          req.user = user;
          if (!req.tenant) {
            req.tenant = {
              universityId: user.university_id,
              isSuper: false,
              university: {
                id: user.uni_id,
                name: user.uni_name,
                slug: user.uni_slug,
                domain: user.uni_domain,
                status: user.uni_status,
                feature_flags: user.uni_feature_flags,
                isolation_mode: user.uni_isolation_mode,
              },
            };
          }
        }
      }
    } catch (_) {
      // ignore invalid token on optional-auth routes
    }
    next();
  };
}

module.exports = { requireAuth, requireRole, optionalAuth };
