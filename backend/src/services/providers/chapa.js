const crypto = require("crypto");

const CHAPA_BASE = "https://api.chapa.co/v1";

// For local testing without real internet connection or real Chapa API keys
let mockVerifier = null;

function isConfigured() {
  return !!process.env.CHAPA_SECRET_KEY || !!mockVerifier;
}

function getSecretKey() {
  return process.env.CHAPA_WEBHOOK_SECRET || process.env.CHAPA_SECRET_KEY || "";
}

/**
 * Validates a Chapa webhook request signature using HMAC-SHA256.
 * Chapa delivers the signature in lowercase hex format in the
 * 'x-chapa-signature' or 'chapa-signature' header.
 *
 * @param {Buffer|string} rawBody - Raw request body buffer received by Express
 * @param {string} signature - Value from x-chapa-signature / chapa-signature header
 * @param {string} [secret] - Optional secret key override
 * @returns {boolean}
 */
function verifyWebhookSignature(rawBody, signature, secret) {
  const secretKey = secret || getSecretKey();
  if (!signature || !secretKey || !rawBody) return false;

  const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
  const computedHash = crypto.createHmac("sha256", secretKey).update(bodyBuffer).digest("hex");

  const sigTrimmed = signature.trim().toLowerCase();
  if (computedHash.length !== sigTrimmed.length) return false;

  try {
    return crypto.timingSafeEqual(Buffer.from(computedHash, "utf8"), Buffer.from(sigTrimmed, "utf8"));
  } catch {
    return false;
  }
}

async function initiate(payment, { buyerEmail, callbackUrl, returnUrl }) {
  if (!isConfigured()) {
    throw new Error("Chapa provider selected but CHAPA_SECRET_KEY is not set");
  }
  const res = await fetch(`${CHAPA_BASE}/transaction/initialize`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: String(payment.amount),
      currency: payment.currency || "ETB",
      email: buyerEmail || "student@example.com",
      tx_ref: payment.id,
      callback_url: callbackUrl,
      return_url: returnUrl,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Chapa initialize failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  if (data.status !== "success" || !data.data?.checkout_url) {
    throw new Error(`Chapa initialize returned unexpected payload: ${JSON.stringify(data)}`);
  }
  return { checkoutUrl: data.data.checkout_url, providerRef: payment.id };
}

/**
 * Calls Chapa's server-side Transaction Verification API to verify the
 * status, amount, currency, and reference of a payment.
 *
 * GET https://api.chapa.co/v1/transaction/verify/:tx_ref
 *
 * @param {string} txRef - The unique transaction reference (payment.id)
 * @returns {Promise<{success: boolean, amount: number|null, currency: string|null, txRef: string, reference: string|null, status: string, raw: object}>}
 */
async function verify(txRef) {
  if (mockVerifier) {
    return mockVerifier(txRef);
  }
  if (!isConfigured()) throw new Error("Chapa provider not configured");

  let res;
  try {
    res = await fetch(`${CHAPA_BASE}/transaction/verify/${txRef}`, {
      headers: { Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const isTimeout = err.name === "TimeoutError" || err.code === "ETIMEDOUT";
    const error = new Error(`Chapa verify request failed: ${err.message}`);
    error.isUpstreamError = true;
    error.status = isTimeout ? 504 : 502;
    error.code = isTimeout ? "GATEWAY_TIMEOUT" : "BAD_GATEWAY";
    throw error;
  }

  if (res.status >= 500 || res.status === 429) {
    const errText = await res.text().catch(() => "");
    const error = new Error(`Chapa verify upstream server error (${res.status}): ${errText}`);
    error.isUpstreamError = true;
    error.status = res.status === 429 ? 429 : 502;
    error.code = res.status === 429 ? "RATE_LIMITED" : "BAD_GATEWAY";
    throw error;
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    const error = new Error(`Chapa verify failed (${res.status}): ${errText}`);
    error.status = res.status;
    error.code = "VERIFICATION_FAILED";
    throw error;
  }

  const data = await res.json();
  const txData = data.data;
  const isSuccess = data.status === "success" && txData?.status === "success";

  return {
    success: isSuccess,
    amount: txData && txData.amount != null ? Number(txData.amount) : null,
    currency: txData?.currency ? String(txData.currency).toUpperCase() : null,
    txRef: txData?.merchant_reference || txData?.tx_ref || txRef,
    reference: txData?.chapa_reference || txData?.reference || null,
    status: txData?.status || (data.status === "success" ? "success" : "failed"),
    raw: data,
  };
}

function _setMockVerifier(fn) {
  mockVerifier = fn;
}

function _clearMockVerifier() {
  mockVerifier = null;
}

module.exports = {
  name: "chapa",
  isConfigured,
  initiate,
  verify,
  verifyWebhookSignature,
  getSecretKey,
  _setMockVerifier,
  _clearMockVerifier,
};
