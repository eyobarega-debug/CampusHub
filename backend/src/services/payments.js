const db = require("../db");
const { notify, audit } = require("../utils/notify");
const { badRequest, notFound, conflict } = require("../utils/errors");

const mockProvider = require("./providers/mock");
const chapaProvider = require("./providers/chapa");

const { getFees } = require("./fees");
const commissions = require("./commissions");
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
const MANUAL_WINDOW_HOURS = Number(process.env.MANUAL_PAYMENT_WINDOW_HOURS || 24);
const MANUAL_MAX_ATTEMPTS = Number(process.env.MANUAL_PROOF_MAX_ATTEMPTS || 3);

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
//   commissionBase(transactionId, client, payment) — optional. What the platform commission is
//                                        charged on (rentals: the fee without the refundable
//                                        deposit). Defaults to the whole payment amount.
function registerFinalizer(transactionType, { onConfirmed, onFailed, getRecipient, isOpen, commissionBase, onRefunded }) {
  finalizers[transactionType] = { onConfirmed, onFailed, getRecipient, isOpen, commissionBase, onRefunded };
}
async function initiatePayment({ transactionType, transactionId, amount, buyerId, buyerEmail, method }) {
  if (!finalizers[transactionType]) throw badRequest(`Unknown transaction type: ${transactionType}`);
  if (method === "manual") return initiateManualPayment({ transactionType, transactionId, amount, buyerId });
  const provider = selectProvider();
  // ...rest unchanged

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

// Manual payment: the student pays the seller/organizer's own account outside
// the app, then uploads proof (see modules/payments/manual.routes.js). Nothing
// is confirmed until the payee approves. Stock / capacity / dates stay held by
// the caller's reservation until then.
async function initiateManualPayment({ transactionType, transactionId, amount, buyerId }) {
  const finalizer = finalizers[transactionType];
  let recipient;
  let accounts;
  try {
    if (!finalizer.getRecipient) {
      throw badRequest(`Manual payment is not available for "${transactionType}"`, "MANUAL_NOT_SUPPORTED");
    }
    recipient = await finalizer.getRecipient(transactionId);
    if (!recipient || !recipient.userId) {
      throw badRequest("There is no seller to pay for this purchase", "NO_PAYEE");
    }
    if (recipient.userId === buyerId) throw badRequest("You can't pay yourself", "SELF_PAYMENT");

    const { rows } = await db.query(
      `SELECT id, method, account_name, account_number, instructions, is_default
         FROM payout_accounts WHERE owner_id = $1 AND active
        ORDER BY is_default DESC, created_at`,
      [recipient.userId]
    );
    accounts = rows;
    if (!accounts.length) {
      throw badRequest(
        "The seller hasn't added a payout account yet, so they can't accept direct payments. Please contact them.",
        "NO_PAYOUT_ACCOUNT"
      );
    }
  } catch (err) {
    // The caller already reserved stock / a seat / dates — give that hold back.
    try {
      await db.withTransaction((client) => finalizer.onFailed(transactionId, client));
    } catch (releaseErr) {
      console.error("[payments] could not release hold after manual-payment precheck failed:", releaseErr);
    }
    throw err;
  }

  const { rows } = await db.query(
    `INSERT INTO payments
       (transaction_type, transaction_id, provider, amount, status,
        payer_id, payee_id, payee_accounts, description, expires_at)
     VALUES ($1,$2,'manual',$3,'pending',$4,$5,$6,$7, now() + ($8 || ' hours')::interval)
     RETURNING *`,
    [transactionType, transactionId, amount, buyerId, recipient.userId, JSON.stringify(accounts), recipient.description || null, String(MANUAL_WINDOW_HOURS)]
  );
  const payment = rows[0];
  await audit(buyerId, "payment.initiate", transactionType, transactionId, {
    paymentId: payment.id, amount, provider: "manual", payeeId: recipient.userId,
  });

  return {
    paymentId: payment.id,
    amount: Number(payment.amount),
    provider: "manual",
    expiresAt: payment.expires_at,
  };
}

// Fails (and releases the hold for) manual payments where the student never
// uploaded proof within the window. Payments already under review are left alone.
async function expireStaleManualPayments() {
  const { rows } = await db.query(
    `SELECT id, payer_id FROM payments
      WHERE provider = 'manual' AND status = 'pending' AND expires_at < now()
      ORDER BY expires_at LIMIT 100`
  );
  let expired = 0;
  for (const p of rows) {
    try {
      await handleProviderCallback(p.id, "fail");
      expired += 1;
    } catch (err) {
      if (err.code !== "PAYMENT_NOT_PENDING") console.error("[payments] expiry failed for", p.id, err.message);
    }
  }
  return expired;
}

async function handleProviderCallback(paymentId, outcome, beforeFinalize) {
  return db.withTransaction(async (client) => {
    const { rows } = await client.query("SELECT * FROM payments WHERE id = $1 FOR UPDATE", [paymentId]);
    const payment = rows[0];
    if (!payment) throw notFound("Payment not found");
    // 'under_review' = manual payment whose proof is awaiting the payee's decision.
    if (payment.status !== "pending" && payment.status !== "under_review") {
      throw conflict(`Payment already ${payment.status}`, "PAYMENT_NOT_PENDING");
    }
    const finalizer = finalizers[payment.transaction_type];
    if (!finalizer) throw badRequest(`No finalizer registered for ${payment.transaction_type}`);

    // If the buyer cancelled the order/ticket while the manual payment was open, its stock
    // was already returned. Running the finalizer again would release it twice (failure)
    // or confirm something that holds no stock (approval). Close the payment quietly.
    if (payment.provider === "manual" && finalizer.isOpen && !(await finalizer.isOpen(payment.transaction_id, client))) {
      await client.query("UPDATE payments SET status='failed' WHERE id=$1", [paymentId]);
      await client.query(
        "UPDATE payment_proofs SET status='rejected', reject_reason='Order was cancelled' WHERE payment_id=$1 AND status='submitted'",
        [paymentId]
      );
      return { ...payment, status: "failed", notOpen: true };
    }
    // Hook so callers (manual approve/reject) can update their own rows in this transaction.
    if (beforeFinalize) await beforeFinalize(client, payment);

    if (outcome === "success") {
      await client.query("UPDATE payments SET status='confirmed', confirmed_at=now(), provider_ref=$2 WHERE id=$1", [
        paymentId,
        `${payment.provider.toUpperCase()}-${paymentId.slice(0, 8)}`,
      ]);
      await client.query("INSERT INTO transactions (payment_id, type, amount) VALUES ($1,'charge',$2)", [
        paymentId,
        payment.amount,
      ]);
      // Phase 3: fee schedule rate is only the fallback; shop sale 10%, ticket 10%, rental 5% (deposit excluded).
      const fees = await getFees(payment.university_id, client);
      const rate = commissions.rateFor(payment.transaction_type, fees.commissionRate);
      const base = finalizer.commissionBase
        ? await finalizer.commissionBase(payment.transaction_id, client, payment)
        : Number(payment.amount);
      const commission = commissions.round2(base * rate);
      if (commission > 0) {
        await client.query("INSERT INTO transactions (payment_id, type, amount) VALUES ($1,'commission',$2)", [
          paymentId,
          commission,
        ]);
      }
      // Per-seller ledger: the seller owes this commission to the platform (manual payments never
      // pass through CampusHub, so it is settled with the admin afterwards).
      await commissions.record(client, { payment, finalizer, base, rate, commission });
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
    await commissions.voidForPayment(client, paymentId);
    await client.query("INSERT INTO transactions (payment_id, type, amount) VALUES ($1,'refund',$2)", [
      paymentId,
      refundAmount,
    ]);
    await audit(actorId, "payment.refund", payment.transaction_type, payment.transaction_id, { paymentId, refundAmount, reason });
        const finalizer = finalizers[payment.transaction_type];
    if (finalizer && finalizer.onRefunded && refundAmount >= Number(payment.amount)) {
      await finalizer.onRefunded(payment.transaction_id, client, { payment, refundAmount, reason, actorId });
    }
    return payment;
  });
}

module.exports = {
  registerFinalizer, initiatePayment, handleProviderCallback, refundPayment, notify, COMMISSION_RATE,
  _selectProvider: selectProvider, expireStaleManualPayments, MANUAL_WINDOW_HOURS, MANUAL_MAX_ATTEMPTS, // exported for the smoke test to confirm failover behavior
};
