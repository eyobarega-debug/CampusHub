const crypto = require("crypto");

const db = require("../db");
const { sendMail } = require("../utils/mailer");
const { badRequest, tooMany } = require("../utils/errors");

// ---------------------------------------------------------------------------
// Email OTP service (signup email-ownership proof).
//
// Design notes:
//   * The code is 6 digits from crypto.randomInt -> uniform over 000000-999999
//     and cryptographically secure.
//   * Only an HMAC of the code is stored (see hashOtp); the plaintext never
//     touches the database or the logs in production.
//   * One active row per (user, purpose) — enforced by the UNIQUE constraint
//     from migration 009 — so "resend" is an UPSERT that rotates the code and
//     cannot be used to stack up unlimited live codes.
//   * Attempts, expiry, resend cooldown and an hourly send budget are all
//     enforced here so the route handlers stay thin.
// ---------------------------------------------------------------------------

const PURPOSE = "signup";

const OTP_LENGTH = 6;
const OTP_TTL_MINUTES = Number(process.env.OTP_TTL_MINUTES) || 10;
const OTP_MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS) || 5;
const OTP_RESEND_COOLDOWN_SECONDS = Number(process.env.OTP_RESEND_COOLDOWN_SECONDS) || 60;
const OTP_MAX_SENDS_PER_HOUR = Number(process.env.OTP_MAX_SENDS_PER_HOUR) || 5;
const HOUR_MS = 60 * 60 * 1000;

// Pepper for the OTP hash. Falls back to the JWT access secret so a DB dump
// alone (without the app secret) can't be brute-forced offline.
function otpPepper() {
  return process.env.OTP_HASH_SECRET || process.env.JWT_ACCESS_SECRET || "dev_otp_pepper_change_me";
}

function generateOtpCode() {
  return crypto.randomInt(0, 10 ** OTP_LENGTH).toString().padStart(OTP_LENGTH, "0");
}

function hashOtp(code) {
  return crypto.createHmac("sha256", otpPepper()).update(String(code)).digest("hex");
}

function expiresAtFromNow() {
  return new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);
}

function secondsUntil(date) {
  return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 1000));
}

// ---------------------------------------------------------------------------
// Issue / resend
// ---------------------------------------------------------------------------
/**
 * Create (or rotate) the signup OTP for a user and email it to them.
 * Returns `{ expiresAt, devCode }`. `devCode` is the plaintext and MUST only be
 * echoed to the client outside production (mirrors the forgot-password dev
 * pattern); it is never persisted.
 */
async function issueSignupOtp({ userId, email, name, isFirstSend }) {
  const code = generateOtpCode();
  const codeHash = hashOtp(code);
  const expiresAt = expiresAtFromNow();

  await db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, attempts, send_count, last_sent_at, consumed_at, expires_at
         FROM email_otps
        WHERE user_id = $1 AND purpose = $2
        FOR UPDATE`,
      [userId, PURPOSE]
    );
    const row = rows[0];

    if (row) {
      const now = Date.now();
      const sinceLastMs = now - new Date(row.last_sent_at).getTime();
      // Hourly budget: if we've been idle for over an hour, start a fresh window.
      const windowCount = now - new Date(row.last_sent_at).getTime() > HOUR_MS ? 0 : row.send_count;

      if (!isFirstSend) {
        if (sinceLastMs < OTP_RESEND_COOLDOWN_SECONDS * 1000) {
          const wait = OTP_RESEND_COOLDOWN_SECONDS - Math.floor(sinceLastMs / 1000);
          throw tooMany(
            `Please wait ${wait}s before requesting another code.`,
            "RESEND_COOLDOWN"
          );
        }
        if (windowCount >= OTP_MAX_SENDS_PER_HOUR) {
          throw tooMany(
            `Too many codes requested. Please try again in about an hour.`,
            "OTP_RATE_LIMITED"
          );
        }
      }

      await client.query(
        `UPDATE email_otps
            SET code_hash = $1, expires_at = $2, attempts = 0,
                send_count = $3, consumed_at = NULL, last_sent_at = now()
          WHERE id = $4`,
        [codeHash, expiresAt, windowCount + 1, row.id]
      );
    } else {
      await client.query(
        `INSERT INTO email_otps (user_id, purpose, code_hash, expires_at, send_count)
         VALUES ($1, $2, $3, $4, 1)`,
        [userId, PURPOSE, codeHash, expiresAt]
      );
    }
  });

  const { delivered } = await sendOtpEmail({ email, name, code, expiresAt });
  return { expiresAt, devCode: code, delivered };
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------
/**
 * Verify a signup OTP. Throws an ApiError for every failure mode (unknown
 * email, wrong code, expired, attempts exhausted) with the SAME message for
 * unknown-email vs wrong-code so we don't reveal which emails exist.
 * @returns {Promise<{ userId }>}
 */
async function verifySignupOtp({ email, code }) {
  const normalizedEmail = String(email || "").toLowerCase();

  const { rows: userRows } = await db.query("SELECT id FROM users WHERE email = $1", [normalizedEmail]);
  const user = userRows[0];

  // No OTP row / no user -> indistinguishable from a bad code.
  const invalid = () => badRequest("That code is not valid. Please check it and try again.", "OTP_INVALID");

  if (!user) throw invalid();

  const result = await db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, code_hash, expires_at, attempts, max_attempts, consumed_at
         FROM email_otps
        WHERE user_id = $1 AND purpose = $2
        FOR UPDATE`,
      [user.id, PURPOSE]
    );
    const row = rows[0];
    if (!row || row.consumed_at) return { error: "invalid" };

    if (new Date(row.expires_at).getTime() <= Date.now()) return { error: "expired" };
    if (row.attempts >= row.max_attempts) return { error: "locked" };

    const expected = row.code_hash;
    const provided = hashOtp(code);
    const matches = expected.length === provided.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));

    if (!matches) {
      const attempts = row.attempts + 1;
      const exhausted = attempts >= row.max_attempts;
      await client.query(
        `UPDATE email_otps SET attempts = $1, consumed_at = $2 WHERE id = $3`,
        [attempts, exhausted ? new Date() : null, row.id]
      );
      return { error: exhausted ? "locked" : "invalid", remaining: Math.max(0, row.max_attempts - attempts) };
    }

    // Success: consume the code and mark the email verified.
    await client.query(
      `UPDATE email_otps SET consumed_at = now() WHERE id = $1`,
      [row.id]
    );
    await client.query(
      `UPDATE users SET email_verified = true, email_verified_at = now() WHERE id = $1`,
      [user.id]
    );
    return { userId: user.id };
  });

  if (result.error === "expired") throw badRequest("That code has expired. Please request a new one.", "OTP_EXPIRED");
  if (result.error === "locked") throw tooMany("Too many incorrect attempts. Please request a new code.", "OTP_TOO_MANY_ATTEMPTS");
  if (result.error === "invalid") throw invalid();
  return { userId: result.userId };
}

// ---------------------------------------------------------------------------
// Email content
// ---------------------------------------------------------------------------
async function sendOtpEmail({ email, name, code, expiresAt }) {
  const minutes = OTP_TTL_MINUTES;
  const subject = "Your CampusHub verification code";
  const text = [
    `Hi ${name || "there"},`,
    ``,
    `Your CampusHub verification code is: ${code}`,
    ``,
    `This code expires in ${minutes} minutes. If you did not sign up for CampusHub, you can ignore this email.`,
  ].join("\n");

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:auto;padding:24px;border:1px solid #e2e8f0;border-radius:12px">
      <h2 style="margin:0 0 8px;color:#0f172a">Verify your email</h2>
      <p style="color:#475569;margin:0 0 20px">Hi ${escapeHtml(name || "there")}, use the code below to finish signing up for CampusHub.</p>
      <p style="font-size:32px;letter-spacing:10px;font-weight:700;text-align:center;color:#0f172a;background:#f8fafc;border-radius:8px;padding:16px;margin:0">${code}</p>
      <p style="color:#64748b;font-size:13px;margin:20px 0 0">This code expires in ${minutes} minutes. If you didn't sign up for CampusHub, you can safely ignore this email.</p>
    </div>`;

  try {
    return await sendMail({ to: email, subject, text, html });
  } catch (err) {
    // Never let an SMTP failure roll back / break the signup; surface it so the
    // route can tell the user to use "Resend".
    console.warn("[otp] email send failed:", err && err.message);
    return { delivered: false, error: err };
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

module.exports = {
  PURPOSE,
  OTP_TTL_MINUTES,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_SECONDS,
  issueSignupOtp,
  verifySignupOtp,
  hashOtp,
  generateOtpCode,
};
