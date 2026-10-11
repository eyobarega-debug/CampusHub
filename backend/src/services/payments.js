const db = require("../db");
const { notify, audit } = require("../utils/notify");
const { badRequest, notFound, conflict } = require("../utils/errors");

const mockProvider = require("./providers/mock");
const chapaProvider = require("./providers/chapa");

const { getFees } = require("./fees");
const COMMISSION_RATE = Number(process.env.COMMISSION_RATE || 0.05); // illustrative default — see SRS Section 18

// Phase 2: provider registry + selection with automatic failover. SRS
// Section 16's whole design point was that a real provider could be added
// "without touching order, rental, or ticketing code" — this registry is
// where that promise gets kept. PAYMENT_PROVIDER selects the preferred
// provider; if it isn't configured (e.g. no API key set), initiation
// transparently falls back to the mock provider rather than failing the
// checkout outright. This is a deliberately simple failover policy
// (primary -> mock), not the "multiple providers with true failover
// between two live providers" described for Phase 3 — see
// CampusHub_Phase3_Build_Prompt.md.
const PROVIDERS = { mock: mockProvider, chapa: chapaProvider };

function selectProvider() {
  const preferred = process.env.PAYMENT_PROVIDER || "mock";
  const provider = PROVIDERS[preferred];
  if (provider && provider.isConfigured()) return provider;
  if (preferred !== "mock") {
    console.warn(`[payments] Preferred provider "${preferred}" is not configured — falling back to mock.`);
  }
  return mockProvider;
}

// Each transaction type (order | booking | ticket | p2p_order | promotion)
// registers two callbacks:
//   onConfirmed(transactionId, client) — finalize the sale after payment succeeds
//   onFailed(transactionId, client)    — release whatever was held (stock, dates, capacity)
// This indirection is what lets orders/rentals/tickets stay decoupled from
// payments — see SRS Section 16 ("every payable flow calls the same
// abstraction layer... a new provider can be added without touching order,
// rental, or ticketing code").
const finalizers = {};
function registerFinalizer(transactionType, { onConfirmed, onFailed, getRecipient }) {
  finalizers[transactionType] = { onConfirmed, onFailed, getRecipient };
}

async function initiatePayment({ transactionType, transactionId, amount, buyerId, buyerEmail }) {
  if (!finalizers[transactionType]) throw badRequest(`Unknown transaction type: ${transactionType}`);
  const provider = selectProvider();

  const { rows } = await db.query(
    `INSERT INTO payments (transaction_type, transaction_id, provider, amount, status)
     VALUES ($1,$2,$3,$4,'pending') RETURNING *`,
    [transactionType, transactionId, provider.name, amount]
  );
  const payment = rows[0];
  await audit(buyerId, "payment.initiate", transactionType, transactionId, { paymentId: payment.id, amount, provider: provider.name });

  let checkout;
  try {
    checkout = await provider.initiate(payment, {
      buyerEmail,
      callbackUrl: `${process.env.PUBLIC_API_URL || "http://localhost:4000"}/api/payments/webhook`,
      returnUrl: `${process.env.PUBLIC_APP_URL || "http://localhost:5173"}/orders`,
    });
  } catch (err) {
    // Initiation itself failed (e.g. provider API unreachable) — mark the
    // payment failed immediately rather than leaving a "pending" row with
    // no way to ever complete it.
    await db.query("UPDATE payments SET status='failed' WHERE id=$1", [payment.id]);
    throw badRequest(`Could not start payment with provider "${provider.name}": ${err.message}`, "PROVIDER_INIT_FAILED");
  }

  return {
    paymentId: payment.id,
    amount: Number(payment.amount),
    provider: provider.name,
    // Phase 1 kept this field name for the mock provider's local checkout
    // route; real providers return a hosted checkoutUrl instead.
    mockCheckoutPath: checkout.checkoutPath,
    checkoutUrl: checkout.checkoutUrl,
  };
}

// Simulates (mock provider) or verifies (real provider) the payment
// outcome. In production this endpoint would verify a provider signature
// (SRS Section 15) before trusting the payload; the mock provider has no
// external signature to check, so the "signature" here is simply that the
// request is authenticated as the student who owns the payment (see
// routes/payments.js). A real provider's webhook route would call this
// same function after its own signature verification passes.
async function handleProviderCallback(paymentId, outcome) {
  return db.withTransaction(async (client) => {
    const { rows } = await client.query("SELECT * FROM payments WHERE id = $1 FOR UPDATE", [paymentId]);
    const payment = rows[0];
    if (!payment) throw notFound("Payment not found");
    if (payment.status !== "pending") {
      throw conflict(`Payment already ${payment.status}`, "PAYMENT_NOT_PENDING");
    }

    const finalizer = finalizers[payment.transaction_type];
    if (!finalizer) throw badRequest(`No finalizer registered for ${payment.transaction_type}`);

    if (outcome === "success") {
      await client.query("UPDATE payments SET status='confirmed', confirmed_at=now(), provider_ref=$2 WHERE id=$1", [
        paymentId,
        `${payment.provider.toUpperCase()}-${paymentId.slice(0, 8)}`,
      ]);
      await client.query("INSERT INTO transactions (payment_id, type, amount) VALUES ($1,'charge',$2)", [
        paymentId,
        payment.amount,
      ]);
      // Phase 3: commission comes from the payment's university fee schedule (falls back to the platform default).
      const fees = await getFees(payment.university_id, client);
      const commission = Math.round(Number(payment.amount) * fees.commissionRate * 100) / 100;
      if (commission > 0) {
        await client.query("INSERT INTO transactions (payment_id, type, amount) VALUES ($1,'commission',$2)", [
          paymentId,
          commission,
        ]);
      }
      await finalizer.onConfirmed(payment.transaction_id, client);
    } else {
      await client.query("UPDATE payments SET status='failed' WHERE id=$1", [paymentId]);
      await finalizer.onFailed(payment.transaction_id, client);
    }
    return { ...payment, status: outcome === "success" ? "confirmed" : "failed" };
  });
}

async function refundPayment(paymentId, amount, reason, actorId) {
  return db.withTransaction(async (client) => {
    const { rows } = await client.query("SELECT * FROM payments WHERE id = $1 FOR UPDATE", [paymentId]);
    const payment = rows[0];
    if (!payment) throw notFound("Payment not found");
    if (payment.status !== "confirmed") throw conflict("Only confirmed payments can be refunded");
    const refundAmount = amount != null ? Number(amount) : Number(payment.amount);
    if (refundAmount > Number(payment.amount)) throw badRequest("Refund amount exceeds the original payment");

    await client.query("UPDATE payments SET status='refunded' WHERE id=$1", [paymentId]);
    await client.query("INSERT INTO transactions (payment_id, type, amount) VALUES ($1,'refund',$2)", [
      paymentId,
      refundAmount,
    ]);
    await audit(actorId, "payment.refund", payment.transaction_type, payment.transaction_id, { paymentId, refundAmount, reason });
    return payment;
  });
}

module.exports = {
  registerFinalizer, initiatePayment, handleProviderCallback, refundPayment, notify, COMMISSION_RATE,
  _selectProvider: selectProvider, // exported for the smoke test to confirm failover behavior
};
