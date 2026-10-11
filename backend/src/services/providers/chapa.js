// Reference driver for Chapa (https://chapa.co), a widely-used Ethiopian
// payment aggregator, demonstrating that a real provider slots into the
// same interface as the mock driver with no changes to order/rental/ticket
// business logic (SRS Section 16's entire point).
//
// ============================================================================
// IMPORTANT — READ BEFORE ENABLING IN PRODUCTION
// ============================================================================
// This driver was written to match Chapa's publicly documented API shape
// (POST /v1/transaction/initialize, GET /v1/transaction/verify/:tx_ref) but
// has NOT been tested against the live Chapa API — this development
// environment has no network access to chapa.co and no real Chapa
// credentials. Treat this as a structurally-correct starting point, not a
// verified integration. Before using it for real payments:
//   1. Get real API credentials from https://dashboard.chapa.co
//   2. Test /transaction/initialize against Chapa's sandbox mode first
//   3. Confirm the webhook payload shape against Chapa's current docs —
//      third-party API response shapes can drift from what's coded here
//   4. Verify the signature-checking approach in handleWebhook() below
//      matches whatever Chapa's webhook signing actually does at the time
//      you implement this — it's stubbed here, not implemented, because it
//      cannot be verified without a live account.
// ============================================================================

const CHAPA_BASE = "https://api.chapa.co/v1";

function isConfigured() {
  return !!process.env.CHAPA_SECRET_KEY;
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
      currency: "ETB",
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

async function verify(txRef) {
  if (!isConfigured()) throw new Error("Chapa provider not configured");
  const res = await fetch(`${CHAPA_BASE}/transaction/verify/${txRef}`, {
    headers: { Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}` },
  });
  if (!res.ok) throw new Error(`Chapa verify failed (${res.status})`);
  const data = await res.json();
  return { success: data.status === "success" && data.data?.status === "success", raw: data };
}

module.exports = { name: "chapa", isConfigured, initiate, verify };
