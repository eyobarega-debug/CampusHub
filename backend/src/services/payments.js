const db = require("../db");
const { notify, audit } = require("../utils/notify");
const { badRequest, notFound, conflict, unauthorized, ApiError } = require("../utils/errors");

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
const RETURN_PATHS = {
  order: "/orders",
  booking: "/rentals/mine",
  ticket: "/tickets",
  p2p_order: "/listings",
  promotion: "/merchant",
};

async function initiatePayment({ transactionType, transactionId, amount, buyerId, buyerEmail, method }) {
  if (!finalizers[transactionType]) throw badRequest(`Unknown transaction type: ${transactionType}`);
  // In CampusHub Manual Payment System, all new transactions use the secure manual payment workflow
  return initiateManualPayment({ transactionType, transactionId, amount, buyerId });
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
  // 1. Prevent duplicate active payments for the same transaction
  const { rows: existingActive } = await db.query(
    "SELECT id, provider, status FROM payments WHERE transaction_type = $1 AND transaction_id = $2 AND status IN ('pending', 'under_review')",
    [transactionType, transactionId]
  );
  if (existingActive.length > 0) {
    throw conflict("A payment is already in progress for this transaction", "PAYMENT_IN_PROGRESS");
  }

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

    if (recipient.isCampusHub) {
      // Require official CampusHub receiving accounts for this specific university
      const { rows: hubAccounts } = await db.query(
        `SELECT id, method, account_name, account_number, instructions, is_default
           FROM payout_accounts
          WHERE university_id = $1 AND is_campus_hub = true AND active = true
          ORDER BY is_default DESC, created_at`,
        [recipient.universityId]
      );
      if (!hubAccounts.length) {
        throw badRequest(
          "The university has not configured an official receiving account for event tickets yet. Please contact campus administration.",
          "NO_CAMPUSHUB_RECEIVING_ACCOUNT"
        );
      }
      accounts = hubAccounts;
    } else {
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

  let payment;
  try {
    const { rows } = await db.query(
      `INSERT INTO payments
         (transaction_type, transaction_id, provider, amount, status,
          payer_id, payee_id, payee_accounts, description, expires_at)
       VALUES ($1,$2,'manual',$3,'pending',$4,$5,$6,$7, now() + ($8 || ' hours')::interval)
       RETURNING *`,
      [transactionType, transactionId, amount, buyerId, recipient.userId, JSON.stringify(accounts), recipient.description || null, String(MANUAL_WINDOW_HOURS)]
    );
    payment = rows[0];
  } catch (err) {
    if (err.code === "23505") {
      throw conflict("A payment is already in progress for this transaction", "PAYMENT_IN_PROGRESS");
    }
    throw err;
  }

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
    return { ...payment, status: "refunded" };
  });
}

async function processChapaWebhook({ rawBody, signature, payload }) {
  // 1. Verify webhook signature
  const validSignature = chapaProvider.verifyWebhookSignature(rawBody, signature);
  if (!validSignature) {
    throw unauthorized("Invalid or missing Chapa webhook signature", "INVALID_SIGNATURE");
  }

  // 2. Extract transaction reference (supporting Chapa v2 merchant_reference and legacy formats)
  const txRef =
    payload?.merchant_reference ||
    payload?.data?.merchant_reference ||
    payload?.tx_ref ||
    payload?.trx_ref ||
    payload?.data?.tx_ref ||
    payload?.data?.trx_ref;

  if (!txRef || typeof txRef !== "string" || !txRef.trim()) {
    throw badRequest("Missing transaction reference in webhook payload", "MISSING_TX_REF");
  }

  const cleanTxRef = txRef.trim();
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanTxRef);
  if (!isUuid) {
    throw notFound("Payment not found");
  }

  // 3. Atomically lock payment row and process
  const result = await db.withTransaction(async (client) => {
    const { rows } = await client.query("SELECT * FROM payments WHERE id = $1 FOR UPDATE", [cleanTxRef]);
    const payment = rows[0];
    if (!payment) throw notFound("Payment not found");

    if (payment.provider !== "chapa") {
      throw badRequest(`Cannot process webhook for payment provider "${payment.provider}"`, "INVALID_PAYMENT_PROVIDER");
    }

    // Idempotency: if already confirmed, acknowledge without reprocessing
    if (payment.status === "confirmed") {
      return { status: "success", message: "Payment already confirmed", idempotent: true, paymentId: payment.id };
    }

    if (payment.status !== "pending") {
      throw conflict(`Payment cannot be processed because status is "${payment.status}"`, "PAYMENT_NOT_PENDING");
    }

    const finalizer = finalizers[payment.transaction_type];
    if (!finalizer) throw badRequest(`No finalizer registered for ${payment.transaction_type}`);

    // 4. Server-to-server verification with Chapa API
    let verification;
    try {
      verification = await chapaProvider.verify(payment.id);
    } catch (err) {
      console.error(`[payments] Chapa verification API error for payment ${payment.id}:`, err.message);
      const isUpstream =
        err.isUpstreamError ||
        err.name === "TimeoutError" ||
        err.code === "ETIMEDOUT" ||
        err.code === "ECONNREFUSED" ||
        err.code === "ENOTFOUND" ||
        err.code === "GATEWAY_TIMEOUT" ||
        err.code === "BAD_GATEWAY" ||
        (err.status && err.status >= 500) ||
        err.status === 429;

      if (isUpstream) {
        const isTimeout =
          err.name === "TimeoutError" ||
          err.code === "ETIMEDOUT" ||
          err.status === 504 ||
          err.code === "GATEWAY_TIMEOUT";
        const statusCode = err.status === 429 ? 429 : (isTimeout ? 504 : 502);
        const code = err.status === 429 ? "RATE_LIMITED" : (isTimeout ? "GATEWAY_TIMEOUT" : "BAD_GATEWAY");
        // Throwing will cause db.withTransaction to ROLLBACK, leaving payment status as 'pending'
        throw new ApiError(statusCode, `Payment verification temporarily unavailable: ${err.message}`, code);
      }

      throw badRequest(`Provider verification failed: ${err.message}`, "VERIFICATION_FAILED");
    }

    if (!verification || !verification.success) {
      await client.query("UPDATE payments SET status = 'failed' WHERE id = $1", [payment.id]);
      await finalizer.onFailed(payment.transaction_id, client);
      return { status: "failed", message: "Payment verification failed at provider", paymentId: payment.id };
    }

    // Reference integrity check
    if (verification.txRef && verification.txRef !== payment.id) {
      await client.query("UPDATE payments SET status = 'failed' WHERE id = $1", [payment.id]);
      await finalizer.onFailed(payment.transaction_id, client);
      return { error: { code: "REFERENCE_MISMATCH", message: "Transaction reference mismatch during verification" } };
    }

    // Amount integrity check (prevent underpayment/tampering)
    if (verification.amount != null && Number(verification.amount) !== Number(payment.amount)) {
      await client.query("UPDATE payments SET status = 'failed' WHERE id = $1", [payment.id]);
      await finalizer.onFailed(payment.transaction_id, client);
      return { error: { code: "AMOUNT_MISMATCH", message: "Payment amount mismatch during verification" } };
    }

    // Currency integrity check (must match expected ETB)
    const expectedCurrency = (payment.currency || "ETB").toUpperCase();
    if (verification.currency && verification.currency.toUpperCase() !== expectedCurrency) {
      await client.query("UPDATE payments SET status = 'failed' WHERE id = $1", [payment.id]);
      await finalizer.onFailed(payment.transaction_id, client);
      return { error: { code: "CURRENCY_MISMATCH", message: "Payment currency mismatch during verification" } };
    }

    // 5. Successful verification: confirm payment
    const providerRef =
      verification.chapa_reference ||
      verification.reference ||
      verification.txRef ||
      `CHAPA-${payment.id.slice(0, 8)}`;
    await client.query(
      "UPDATE payments SET status = 'confirmed', confirmed_at = now(), provider_ref = $2 WHERE id = $1",
      [payment.id, providerRef]
    );

    await client.query("INSERT INTO transactions (payment_id, type, amount) VALUES ($1, 'charge', $2)", [
      payment.id,
      payment.amount,
    ]);

    const fees = await getFees(payment.university_id, client);
    const rate = commissions.rateFor(payment.transaction_type, fees.commissionRate);
    const base = finalizer.commissionBase
      ? await finalizer.commissionBase(payment.transaction_id, client, payment)
      : Number(payment.amount);
    const commission = commissions.round2(base * rate);
    if (commission > 0) {
      await client.query("INSERT INTO transactions (payment_id, type, amount) VALUES ($1, 'commission', $2)", [
        payment.id,
        commission,
      ]);
    }

    await commissions.record(client, { payment, finalizer, base, rate, commission });
    await finalizer.onConfirmed(payment.transaction_id, client);

    return { status: "success", message: "Payment confirmed successfully", paymentId: payment.id };
  });

  if (result.error) {
    throw badRequest(result.error.message, result.error.code);
  }

  return result;
}

module.exports = {
  registerFinalizer, initiatePayment, handleProviderCallback, refundPayment, processChapaWebhook, notify, COMMISSION_RATE,
  _selectProvider: selectProvider, expireStaleManualPayments, MANUAL_WINDOW_HOURS, MANUAL_MAX_ATTEMPTS, // exported for the smoke test to confirm failover behavior
};
