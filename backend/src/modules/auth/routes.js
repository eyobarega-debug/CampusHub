const express = require("express");
const { z } = require("zod");
const crypto = require("crypto");

const db = require("../../db");
const { hashPassword, comparePassword } = require("../../utils/hash");
const { signAccessToken, generateRefreshToken, hashToken, REFRESH_TTL_MS } = require("../../utils/jwt");
const { validate } = require("../../middleware/validate");
const { rateLimit } = require("../../middleware/rateLimit");
const { asyncHandler, badRequest, unauthorized, forbidden, conflict } = require("../../utils/errors");
const { audit } = require("../../utils/notify");
const {
  issueSignupOtp,
  verifySignupOtp,
  OTP_TTL_MINUTES,
  OTP_RESEND_COOLDOWN_SECONDS,
} = require("../../services/otp");

const router = express.Router();

const registerSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  phone: z.string().optional(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  role: z.enum(["student", "merchant"]).default("student"),
  universityId: z.string().uuid().optional(),
});

// FR-001 / FR-002 — register, with automatic university-domain verification.
router.post(
  "/register",
  validate({ body: registerSchema }),
  asyncHandler(async (req, res) => {
    const { name, email, phone, password, role, universityId } = req.body;

    const existing = await db.query("SELECT id FROM users WHERE email = $1", [email.toLowerCase()]);
    if (existing.rows.length) throw conflict("An account with this email already exists", "EMAIL_TAKEN");

    // Phase 3: every account belongs to exactly one active university. Use the
    // explicit universityId, else match the email's domain to a university.
    let uni = null;
    if (universityId) {
      uni = (await db.query("SELECT * FROM universities WHERE id = $1 AND status = 'active'", [universityId])).rows[0];
      if (!uni) throw badRequest("Unknown or inactive university", "UNKNOWN_UNIVERSITY");
    } else {
      const emailDomain = email.toLowerCase().split("@")[1];
      uni = (await db.query("SELECT * FROM universities WHERE lower(domain) = $1 AND status = 'active'", [emailDomain])).rows[0];
      if (!uni) throw badRequest("Choose your university (universityId) — your email domain didn't match one", "UNIVERSITY_REQUIRED");
    }
    const uniId = uni.id;
    let verified = false;
    let verificationMethod = "manual_pending";
    if (uni.domain && email.toLowerCase().endsWith("@" + uni.domain.toLowerCase())) {
      verified = true;
      verificationMethod = "domain";
    }

    const passwordHash = await hashPassword(password);
    const { rows } = await db.query(
      `INSERT INTO users (university_id, name, email, phone, password_hash, role, verified, verification_method, email_verified)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false)
       RETURNING id, name, email, role, verified, email_verified, university_id, created_at`,
      [uniId, name, email.toLowerCase(), phone || null, passwordHash, role, verified, verificationMethod]
    );
    const user = rows[0];
    await audit(user.id, "user.register", "user", user.id, { role });

    // Email-ownership proof: a fresh account is NOT email-verified until the
    // student enters the 6-digit code we send to the address they signed up
    // with. Campus verification (above) is a separate axis and is unchanged.
    const { expiresAt, devCode, delivered } = await issueSignupOtp({
      userId: user.id,
      email: user.email,
      name: user.name,
      isFirstSend: true,
    });

    res.status(201).json({
      user,
      emailVerificationRequired: true,
      resendCooldownSeconds: OTP_RESEND_COOLDOWN_SECONDS,
      expiresInSeconds: Math.max(0, Math.round((expiresAt.getTime() - Date.now()) / 1000)),
      // Dev-only convenience, mirroring the forgot-password route. Never
      // returned in production. See src/services/otp.js.
      devOtp: process.env.NODE_ENV === "production" ? undefined : devCode,
      emailDelivered: delivered,
      message:
        `Account created. We sent a ${OTP_TTL_MINUTES}-minute verification code to ${user.email} — ` +
        "enter it to verify your email address." +
        (verified ? " (Your university email already qualifies for campus verification.)" : ""),
    });
  })
);

// FR-003 — login
router.post(
  "/login",
  rateLimit({ windowMs: 60_000, max: 8, keyFn: (req) => `login:${req.ip}:${req.body?.email}` }),
  validate({ body: z.object({ email: z.string().email(), password: z.string() }) }),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const { rows } = await db.query("SELECT * FROM users WHERE email = $1", [email.toLowerCase()]);
    const user = rows[0];
    // Same generic error whether the email doesn't exist or the password is
    // wrong — SRS FR-003 alternative flow: no hint about which field failed.
    if (!user || !(await comparePassword(password, user.password_hash))) {
      throw unauthorized("Invalid email or password");
    }
    if (user.suspended) throw forbidden("This account has been suspended. Contact a university administrator.");

    const accessToken = signAccessToken(user);
    const refreshToken = generateRefreshToken();
    const familyId = crypto.randomUUID();
    await db.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at)
       VALUES ($1,$2,$3, now() + interval '30 days')`,
      [user.id, hashToken(refreshToken), familyId]
    );

    const { password_hash, ...safeUser } = user;
    res.json({ accessToken, refreshToken, user: safeUser });
  })
);

// ---------------------------------------------------------------------------
// Email OTP verification (signup). Public routes — the student has no token
// yet, so these are NOT behind requireAuth().
// ---------------------------------------------------------------------------
const verifyEmailSchema = z.object({
  email: z.string().email(),
  otp: z.string().regex(/^\d{6}$/, "Enter the 6-digit code"),
});

// Check the 6-digit code. Wrong email and wrong code return the SAME message
// (OTP_INVALID) so we don't reveal which addresses have accounts.
router.post(
  "/verify-email",
  rateLimit({ windowMs: 60_000, max: 10, keyFn: (req) => `verifyemail:${req.ip}:${req.body?.email}` }),
  validate({ body: verifyEmailSchema }),
  asyncHandler(async (req, res) => {
    const { userId } = await verifySignupOtp({ email: req.body.email, code: req.body.otp });
    await audit(userId, "user.email_verified", "user", userId, {});
    res.json({ success: true, message: "Email verified — your account is ready. You can now log in." });
  })
);

// Ask for a new code. Enforces a resend cooldown and an hourly send budget in
// the OTP service, plus a per-IP rate limit here.
router.post(
  "/verify-email/resend",
  rateLimit({ windowMs: 60_000, max: 6, keyFn: (req) => `resendotp:${req.ip}:${req.body?.email}` }),
  validate({ body: z.object({ email: z.string().email() }) }),
  asyncHandler(async (req, res) => {
    const email = req.body.email.toLowerCase();
    const { rows } = await db.query("SELECT id, name, email, email_verified FROM users WHERE email = $1", [email]);
    const user = rows[0];

    // Same generic response whether the email is unknown or already verified.
    if (!user || user.email_verified) {
      return res.json({ message: "If that email still needs verification, a new code is on its way." });
    }

    const { expiresAt, devCode, delivered } = await issueSignupOtp({
      userId: user.id,
      email: user.email,
      name: user.name,
      isFirstSend: false,
    });

    res.json({
      message: delivered
        ? "A new code has been sent."
        : "We couldn't send the code right now — please try again in a moment.",
      resendCooldownSeconds: OTP_RESEND_COOLDOWN_SECONDS,
      expiresInSeconds: Math.max(0, Math.round((expiresAt.getTime() - Date.now()) / 1000)),
      devOtp: process.env.NODE_ENV === "production" ? undefined : devCode,
      emailDelivered: delivered,
    });
  })
);

// FR-003 (session continuity) — exchange refresh token for a new access token,
// rotating the refresh token and detecting reuse (SRS Section 15).
router.post(
  "/refresh",
  validate({ body: z.object({ refreshToken: z.string() }) }),
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body;
    const tokenHash = hashToken(refreshToken);
    const { rows } = await db.query("SELECT * FROM refresh_tokens WHERE token_hash = $1", [tokenHash]);
    const stored = rows[0];
    if (!stored || stored.expires_at < new Date()) throw unauthorized("Invalid or expired refresh token");

    if (stored.revoked) {
      // Reuse of an already-rotated token: treat as possible theft and kill
      // the whole family.
      await db.query("UPDATE refresh_tokens SET revoked = true WHERE family_id = $1", [stored.family_id]);
      throw unauthorized("Refresh token reuse detected — all sessions revoked. Please log in again.");
    }

    await db.query("UPDATE refresh_tokens SET revoked = true WHERE id = $1", [stored.id]);
    const newRefreshToken = generateRefreshToken();
    await db.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at)
       VALUES ($1,$2,$3, now() + interval '30 days')`,
      [stored.user_id, hashToken(newRefreshToken), stored.family_id]
    );

    const { rows: userRows } = await db.query("SELECT * FROM users WHERE id = $1", [stored.user_id]);
    const accessToken = signAccessToken(userRows[0]);
    res.json({ accessToken, refreshToken: newRefreshToken });
  })
);

router.post(
  "/logout",
  validate({ body: z.object({ refreshToken: z.string() }) }),
  asyncHandler(async (req, res) => {
    await db.query("UPDATE refresh_tokens SET revoked = true WHERE token_hash = $1", [hashToken(req.body.refreshToken)]);
    res.json({ success: true });
  })
);

// FR-004 — forgot / reset password. No real email provider is wired up for
// this local demo, so the reset link is returned in the response /
// server log instead of being emailed — see README "Simplifications".
router.post(
  "/forgot-password",
  rateLimit({ windowMs: 60_000, max: 5 }),
  validate({ body: z.object({ email: z.string().email() }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query("SELECT id FROM users WHERE email = $1", [req.body.email.toLowerCase()]);
    let devResetToken;
    if (rows[0]) {
      devResetToken = crypto.randomBytes(32).toString("hex");
      await db.query(
        "UPDATE users SET password_reset_token=$1, password_reset_expires = now() + interval '1 hour' WHERE id=$2",
        [hashToken(devResetToken), rows[0].id]
      );
      console.log(`[DEV EMAIL] Password reset token for ${req.body.email}: ${devResetToken}`);
    }
    // Same response whether or not the account exists (SRS FR-004: no account enumeration).
    res.json({
      message: "If that email is registered, a reset link has been generated.",
      devResetToken: process.env.NODE_ENV === "production" ? undefined : devResetToken,
    });
  })
);

router.post(
  "/reset-password",
  validate({ body: z.object({ token: z.string(), newPassword: z.string().min(8) }) }),
  asyncHandler(async (req, res) => {
    const { token, newPassword } = req.body;
    const { rows } = await db.query(
      "SELECT id FROM users WHERE password_reset_token = $1 AND password_reset_expires > now()",
      [hashToken(token)]
    );
    if (!rows[0]) throw badRequest("Invalid or expired reset token");
    const passwordHash = await hashPassword(newPassword);
    await db.query(
      "UPDATE users SET password_hash=$1, password_reset_token=NULL, password_reset_expires=NULL WHERE id=$2",
      [passwordHash, rows[0].id]
    );
    await db.query("UPDATE refresh_tokens SET revoked = true WHERE user_id = $1", [rows[0].id]);
    res.json({ success: true });
  })
);

module.exports = router;
