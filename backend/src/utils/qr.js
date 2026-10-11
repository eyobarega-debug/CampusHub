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
const QR_SECRET = process.env.TICKET_QR_SECRET || "dev_ticket_qr_secret_change_me";

function signTicket(ticketId) {
  return crypto.createHmac("sha256", QR_SECRET).update(ticketId).digest("hex");
}

function buildQrPayload(ticketId, signature) {
  return `${ticketId}.${signature}`;
}

function parseQrPayload(payload) {
  const idx = payload.indexOf(".");
  if (idx === -1) return null;
  return { ticketId: payload.slice(0, idx), signature: payload.slice(idx + 1) };
}

function isValidSignature(ticketId, signature) {
  const expected = signTicket(ticketId);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature || "");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b); // constant-time compare — no timing side-channel
}

async function qrPayloadToDataUrl(payload) {
  return QRCode.toDataURL(payload, { margin: 1, width: 320 });
}

module.exports = { signTicket, buildQrPayload, parseQrPayload, isValidSignature, qrPayloadToDataUrl };
