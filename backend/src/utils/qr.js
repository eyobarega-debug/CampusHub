const crypto = require("crypto");
const QRCode = require("qrcode");

// Design note: an earlier version of this file stored only a hash of a
// random per-ticket secret (like a password-reset token). That would have
// made it impossible to satisfy FR-030 ("view my tickets" at any time,
// including re-opening the app days later) because the plaintext secret
// would only ever exist once, at issuance.
//
// Instead we HMAC-sign the ticket id with a server-wide secret
// (TICKET_QR_SECRET). The signature is deterministic and reproducible by the
// server at any time (so "My Tickets" can always re-render the QR), but
// cannot be produced by anyone who doesn't hold the server secret — so it's
// still a "signed token, not merely the raw ticket ID" per FR-029, and a
// forged/guessed ticket id will fail the signature check at scan time.
//
// SECRET ROTATION LIFECYCLE:
// To rotate TICKET_QR_SECRET with zero downtime and without invalidating already-issued
// or physical printed tickets:
// 1. Set TICKET_QR_SECRET to the new secret (at least 32 characters).
// 2. Set TICKET_QR_SECRET_PREVIOUS to the retiring secret.
// 3. New tickets and QR codes are signed with the new secret.
// 4. Scanners and gate validation endpoints verify against both active and previous secrets.
// 5. Once the rotation window closes, unset TICKET_QR_SECRET_PREVIOUS.
function getQrSecrets() {
  const secret = process.env.TICKET_QR_SECRET;
  if (process.env.NODE_ENV === "production") {
    if (!secret || secret === "dev_ticket_qr_secret_change_me" || secret.length < 32) {
      throw new Error("FATAL: Insecure or missing TICKET_QR_SECRET in production. It must be at least 32 characters.");
    }
  }
  const secrets = [secret || "dev_ticket_qr_secret_change_me"];
  const prevSecret = process.env.TICKET_QR_SECRET_PREVIOUS;
  if (prevSecret && prevSecret !== secrets[0]) {
    secrets.push(prevSecret);
  }
  return secrets;
}

function getQrSecret() {
  return getQrSecrets()[0];
}

function signTicket(ticketId, secret = getQrSecret()) {
  if (typeof ticketId !== "string" || !ticketId) {
    throw new Error("signTicket requires a non-empty string ticketId");
  }
  return crypto.createHmac("sha256", secret).update(ticketId).digest("hex");
}

function buildQrPayload(ticketId, signature) {
  return `${ticketId}.${signature}`;
}

function generateTicketNumber() {
  const code = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `GIB-${code}`;
}

function buildVerificationUrl(ticketId, signature) {
  const appUrl = (process.env.APP_URL || process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/+$/, "");
  return `${appUrl}/tickets/verify/${ticketId}.${signature}`;
}

function parseQrPayload(payload) {
  if (!payload || typeof payload !== "string") return null;
  let clean = payload.trim();
  if (clean.startsWith("http://") || clean.startsWith("https://")) {
    try {
      const u = new URL(clean);
      const segments = u.pathname.split("/").filter(Boolean);
      clean = segments[segments.length - 1] || "";
    } catch (_) {
      // not a strict URL, fall back to string parsing
    }
  }
  const idx = clean.indexOf(".");
  if (idx === -1) return null;
  return { ticketId: clean.slice(0, idx), signature: clean.slice(idx + 1) };
}

function isValidSignature(ticketId, signature) {
  if (typeof ticketId !== "string" || typeof signature !== "string" || !ticketId || !signature) {
    return false;
  }
  const b = Buffer.from(signature, "hex");
  if (b.length !== 32) return false;

  const secrets = getQrSecrets();
  for (const secret of secrets) {
    const expected = signTicket(ticketId, secret);
    const a = Buffer.from(expected, "hex");
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return true;
    }
  }
  return false;
}

async function qrPayloadToDataUrl(payload) {
  return QRCode.toDataURL(payload, { margin: 1, width: 320 });
}

module.exports = {
  getQrSecret,
  getQrSecrets,
  signTicket,
  generateTicketNumber,
  buildQrPayload,
  buildVerificationUrl,
  parseQrPayload,
  isValidSignature,
  qrPayloadToDataUrl,
};
