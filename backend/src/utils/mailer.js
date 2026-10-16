const nodemailer = require("nodemailer");

// ---------------------------------------------------------------------------
// Email transport. This is the FIRST real email channel in CampusHub — until
// now the codebase only had a `[DEV EMAIL]` console.log stub (see the
// forgot-password route) and a `[DEV SMS]` stub in notify.js. `sendMail()` is
// the single call site to swap for a transactional provider (SendGrid,
// Postmark, SES, ...) later.
//
// Credentials come ONLY from the environment (never hardcoded, never exposed
// to the frontend). If EMAIL_HOST is unset we fall back to logging the message
// to the server console — the same "dev pattern" the rest of the repo uses —
// so signup keeps working locally with zero SMTP setup.
// ---------------------------------------------------------------------------

let transporter = null;

function isEmailConfigured() {
  return Boolean(process.env.EMAIL_HOST);
}

function getTransporter() {
  if (transporter) return transporter;
  const port = Number(process.env.EMAIL_PORT) || 587;
  transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port,
    secure: port === 465, // 465 = implicit TLS, 587 = STARTTLS
    auth: process.env.EMAIL_USER
      ? { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD }
      : undefined,
  });
  return transporter;
}

function fromAddress() {
  return process.env.EMAIL_FROM || process.env.EMAIL_USER || "CampusHub <no-reply@campushub.local>";
}

/**
 * Send an email. Never throws — callers decide how to react, but an SMTP
 * hiccup must not, for example, roll back a completed signup.
 * @returns {Promise<{ delivered: boolean, dev?: boolean }>}
 */
async function sendMail({ to, subject, text, html }) {
  if (!isEmailConfigured()) {
    // Dev fallback: mirror the existing `[DEV EMAIL]` convention. The full
    // message (including the OTP) lands in the server log only.
    console.log(`[DEV EMAIL] -> ${to} | ${subject}\n${text}`);
    return { delivered: true, dev: true };
  }

  const info = await getTransporter().sendMail({ from: fromAddress(), to, subject, text, html });
  return { delivered: true, messageId: info && info.messageId };
}

module.exports = { sendMail, isEmailConfigured };
