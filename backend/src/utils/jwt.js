const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || "dev_access_secret_change_me";
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "dev_refresh_secret_change_me";

const ACCESS_TTL = "15m";
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, universityId: user.university_id },
    ACCESS_SECRET,
    { expiresIn: ACCESS_TTL }
  );
}

function verifyAccessToken(token) {
  return jwt.verify(token, ACCESS_SECRET); // throws on invalid/expired
}

// Refresh tokens are opaque random strings (not JWTs) whose SHA-256 hash is
// stored in refresh_tokens, so a stolen DB dump alone can't be replayed as a
// valid refresh token. See SRS Section 15 (JWT Authentication).
function generateRefreshToken() {
  return crypto.randomBytes(48).toString("hex");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashToken,
  REFRESH_TTL_MS,
};
