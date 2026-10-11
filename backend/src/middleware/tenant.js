// Phase 3 multi-tenancy (SRS Section 21.2 — shared schema, scoped by university_id).
//
// resolveTenant() runs on every tenant-scoped /api mount and sets:
//   req.tenant = { universityId, isSuper, university }
//
// Rules (the security-relevant part — read before changing):
//  * Authenticated student/merchant/organizer/admin: tenant is ALWAYS their own
//    university_id from the DB. A conflicting X-University-Id header is rejected,
//    never honoured.
//  * super_admin: may pass X-University-Id to act inside one tenant; with no
//    header universityId is null, meaning "cross-tenant" (platform-wide views).
//  * Unauthenticated: tenant comes from ?universityId= / X-University-Id /
//    X-University-Slug. If none is given and exactly ONE active university
//    exists, that one is used (keeps the single-campus pilot working unchanged).
//    With 2+ universities a tenant is required (400 TENANT_REQUIRED).
const db = require("../db");
const { verifyAccessToken } = require("../utils/jwt");
const { forbidden, notFound, badRequest, ApiError } = require("../utils/errors");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadUniversity(idOrSlug) {
  const col = UUID_RE.test(idOrSlug) ? "id" : "slug";
  const { rows } = await db.query(
    `SELECT id, name, slug, domain, status, feature_flags, isolation_mode FROM universities WHERE ${col} = $1`,
    [idOrSlug]
  );
  return rows[0] || null;
}

async function tokenUser(req) {
  const [scheme, token] = (req.headers.authorization || "").split(" ");
  if (scheme !== "Bearer" || !token) return null;
  try {
    const payload = verifyAccessToken(token);
    const { rows } = await db.query("SELECT id, role, suspended, university_id FROM users WHERE id = $1", [payload.sub]);
    return rows[0] && !rows[0].suspended ? rows[0] : null;
  } catch (_) {
    return null; // bad token: downstream requireAuth() produces the 401
  }
}

function resolveTenant({ required = true } = {}) {
  return async (req, res, next) => {
    try {
      const requested =
        req.headers["x-university-id"] || req.headers["x-university-slug"] || req.query.universityId || null;
      const user = await tokenUser(req);

      if (user && user.role !== "super_admin") {
        if (!user.university_id) throw new ApiError(403, "Your account is not attached to a university", "NO_TENANT");
        if (requested && requested !== user.university_id) {
          const asSlug = !UUID_RE.test(requested) ? await loadUniversity(requested) : null;
          if (!asSlug || asSlug.id !== user.university_id) {
            throw new ApiError(403, "You cannot access another university's data", "TENANT_MISMATCH");
          }
        }
        const university = await loadUniversity(user.university_id);
        if (!university || university.status !== "active") {
          throw new ApiError(403, "This university is not active", "TENANT_INACTIVE");
        }
        req.tenant = { universityId: user.university_id, isSuper: false, university };
        return next();
      }

      if (user && user.role === "super_admin") {
        if (requested) {
          const university = await loadUniversity(requested);
          if (!university) throw notFound("University not found");
          req.tenant = { universityId: university.id, isSuper: true, university };
        } else {
          req.tenant = { universityId: null, isSuper: true, university: null };
        }
        return next();
      }

      // Unauthenticated / public browsing
      if (requested) {
        const university = await loadUniversity(requested);
        if (!university || university.status !== "active") throw notFound("University not found");
        req.tenant = { universityId: university.id, isSuper: false, university };
        return next();
      }
      const { rows } = await db.query("SELECT id, name, slug, domain, status, feature_flags, isolation_mode FROM universities WHERE status = 'active' LIMIT 2");
      if (rows.length === 1) {
        req.tenant = { universityId: rows[0].id, isSuper: false, university: rows[0] };
        return next();
      }
      if (required) {
        throw badRequest(
          "Specify a university with the X-University-Id (or X-University-Slug) header or ?universityId=",
          "TENANT_REQUIRED"
        );
      }
      req.tenant = { universityId: null, isSuper: false, university: null };
      next();
    } catch (err) {
      next(err);
    }
  };
}

// SQL helper: append "<column> = $n" to a conditions/params pair when the
// request is tenant-bound. Cross-tenant (super admin, no header) adds nothing.
function scopeTo(req, column, conditions, params) {
  if (req.tenant && req.tenant.universityId) {
    params.push(req.tenant.universityId);
    conditions.push(`${column} = $${params.length}`);
  }
}

// For routes that act on one row fetched by id: a row from another tenant is
// reported as 404 (not 403) so IDs from other campuses can't be probed.
function assertSameTenant(req, rowUniversityId, what = "Resource") {
  const t = req.tenant && req.tenant.universityId;
  if (t && rowUniversityId !== t) throw notFound(`${what} not found`);
}

// Per-university feature flags. A missing flag means ENABLED, so existing
// deployments keep working until a Super Admin explicitly turns something off.
function requireFeature(flag) {
  return (req, res, next) => {
    const flags = (req.tenant && req.tenant.university && req.tenant.university.feature_flags) || {};
    if (flags[flag] === false) {
      return next(new ApiError(403, `The "${flag}" feature is not enabled for this university`, "FEATURE_DISABLED"));
    }
    next();
  };
}

module.exports = { resolveTenant, scopeTo, assertSameTenant, requireFeature };
