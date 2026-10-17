/**
 * Automated Security Test Suite - Phase 1 Fixes
 *
 * Task 1: Prevent Mock Payment Bypass
 * Task 2: Implement Secure Chapa Payment Verification
 * Task 3: Enforce Email OTP Verification at Login
 */

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const http = require("http");

process.env.NODE_ENV = "test";
process.env.CHAPA_WEBHOOK_SECRET = "test_webhook_secret_key_12345";

const app = require("../src/app");
const db = require("../src/db");
const paymentsService = require("../src/services/payments");
const chapaProvider = require("../src/services/providers/chapa");
const { signAccessToken } = require("../src/utils/jwt");

let server;
let baseUrl;
let aastuUniversityId;

// Test state tracking
let testFinalizerCalls = { confirmed: [], failed: [] };

before(async () => {
  // Start server on an ephemeral port
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  // Fetch AASTU university id
  const { rows } = await db.query("SELECT id FROM universities WHERE domain = 'aastu.edu.et' LIMIT 1");
  assert.ok(rows[0], "AASTU university must exist in DB");
  aastuUniversityId = rows[0].id;

  // Register a test transaction finalizer
  paymentsService.registerFinalizer("test_payable", {
    onConfirmed: async (txId) => {
      testFinalizerCalls.confirmed.push(txId);
    },
    onFailed: async (txId) => {
      testFinalizerCalls.failed.push(txId);
    },
  });
});

after(async () => {
  chapaProvider._clearMockVerifier();
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await db.pool.end();
});

beforeEach(() => {
  testFinalizerCalls = { confirmed: [], failed: [] };
  chapaProvider._clearMockVerifier();
  process.env.NODE_ENV = "test";
});

// Helper for making API requests
async function apiRequest(path, { method = "GET", headers = {}, body, rawBody } = {}) {
  const reqHeaders = { ...headers };
  let payload = rawBody;

  if (body !== undefined && rawBody === undefined) {
    payload = JSON.stringify(body);
    reqHeaders["Content-Type"] = "application/json";
  }

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: reqHeaders,
    body: payload,
  });

  const contentType = res.headers.get("content-type") || "";
  let data = null;
  if (contentType.includes("application/json")) {
    data = await res.json();
  } else {
    data = await res.text();
  }

  return { status: res.status, headers: res.headers, data };
}

// Helper to sign HMAC-SHA256 for Chapa webhooks
function signChapaWebhook(bodyString, secret = process.env.CHAPA_WEBHOOK_SECRET) {
  return crypto.createHmac("sha256", secret).update(Buffer.from(bodyString, "utf8")).digest("hex");
}

// ============================================================================
// TASK 1: PREVENT MOCK PAYMENT BYPASS
// ============================================================================
describe("Task 1: Prevent Mock Payment Bypass", () => {
  let saraUser;
  let dawitUser;
  let saraToken;
  let dawitToken;

  before(async () => {
    const { rows: sRows } = await db.query("SELECT * FROM users WHERE email = 'sara@aastu.edu.et'");
    saraUser = sRows[0];
    saraToken = signAccessToken(saraUser);

    const { rows: dRows } = await db.query("SELECT * FROM users WHERE email = 'dawit@aastu.edu.et'");
    dawitUser = dRows[0];
    dawitToken = signAccessToken(dawitUser);
  });

  test("1.1 Successfully completes mock payment when provider is 'mock' and user is owner", async () => {
    const txId = crypto.randomUUID();
    const { rows } = await db.query(
      `INSERT INTO payments (transaction_type, transaction_id, provider, amount, status, payer_id, currency, university_id)
       VALUES ('test_payable', $1, 'mock', 120.50, 'pending', $2, 'ETB', $3) RETURNING *`,
      [txId, saraUser.id, aastuUniversityId]
    );
    const payment = rows[0];

    const res = await apiRequest(`/api/payments/mock/${payment.id}/complete`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${saraToken}`,
        "X-University-Id": aastuUniversityId,
      },
      body: { outcome: "success" },
    });

    assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.data)}`);
    assert.equal(res.data.payment.status, "confirmed");

    // Verify DB state
    const { rows: checkRows } = await db.query("SELECT * FROM payments WHERE id = $1", [payment.id]);
    assert.equal(checkRows[0].status, "confirmed");
    assert.ok(checkRows[0].confirmed_at);
    assert.ok(testFinalizerCalls.confirmed.includes(txId));
  });

  test("1.2 Rejects mock completion when provider is 'chapa' (HTTP 400 INVALID_PAYMENT_PROVIDER)", async () => {
    const txId = crypto.randomUUID();
    const { rows } = await db.query(
      `INSERT INTO payments (transaction_type, transaction_id, provider, amount, status, payer_id, currency, university_id)
       VALUES ('test_payable', $1, 'chapa', 200.00, 'pending', $2, 'ETB', $3) RETURNING *`,
      [txId, saraUser.id, aastuUniversityId]
    );
    const payment = rows[0];

    const res = await apiRequest(`/api/payments/mock/${payment.id}/complete`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${saraToken}`,
        "X-University-Id": aastuUniversityId,
      },
      body: { outcome: "success" },
    });

    assert.equal(res.status, 400);
    assert.equal(res.data.error.code, "INVALID_PAYMENT_PROVIDER");

    // Verify payment remains pending
    const { rows: checkRows } = await db.query("SELECT status FROM payments WHERE id = $1", [payment.id]);
    assert.equal(checkRows[0].status, "pending");
    assert.equal(testFinalizerCalls.confirmed.length, 0);
  });

  test("1.3 Rejects mock completion when provider is 'manual' (HTTP 400 INVALID_PAYMENT_PROVIDER)", async () => {
    const txId = crypto.randomUUID();
    const { rows } = await db.query(
      `INSERT INTO payments (transaction_type, transaction_id, provider, amount, status, payer_id, currency, university_id)
       VALUES ('test_payable', $1, 'manual', 350.00, 'pending', $2, 'ETB', $3) RETURNING *`,
      [txId, saraUser.id, aastuUniversityId]
    );
    const payment = rows[0];

    const res = await apiRequest(`/api/payments/mock/${payment.id}/complete`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${saraToken}`,
        "X-University-Id": aastuUniversityId,
      },
      body: { outcome: "success" },
    });

    assert.equal(res.status, 400);
    assert.equal(res.data.error.code, "INVALID_PAYMENT_PROVIDER");

    const { rows: checkRows } = await db.query("SELECT status FROM payments WHERE id = $1", [payment.id]);
    assert.equal(checkRows[0].status, "pending");
  });

  test("1.4 Disables mock completion in production environment (HTTP 403 MOCK_PAYMENTS_DISABLED)", async () => {
    const txId = crypto.randomUUID();
    const { rows } = await db.query(
      `INSERT INTO payments (transaction_type, transaction_id, provider, amount, status, payer_id, currency, university_id)
       VALUES ('test_payable', $1, 'mock', 100.00, 'pending', $2, 'ETB', $3) RETURNING *`,
      [txId, saraUser.id, aastuUniversityId]
    );
    const payment = rows[0];

    // Simulate production environment
    process.env.NODE_ENV = "production";

    const res = await apiRequest(`/api/payments/mock/${payment.id}/complete`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${saraToken}`,
        "X-University-Id": aastuUniversityId,
      },
      body: { outcome: "success" },
    });

    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, "MOCK_PAYMENTS_DISABLED");

    const { rows: checkRows } = await db.query("SELECT status FROM payments WHERE id = $1", [payment.id]);
    assert.equal(checkRows[0].status, "pending");
  });

  test("1.5 Rejects mock completion attempt by unauthorized non-owner (HTTP 403 FORBIDDEN)", async () => {
    const txId = crypto.randomUUID();
    // Payment belongs to Sara
    const { rows } = await db.query(
      `INSERT INTO payments (transaction_type, transaction_id, provider, amount, status, payer_id, currency, university_id)
       VALUES ('test_payable', $1, 'mock', 85.00, 'pending', $2, 'ETB', $3) RETURNING *`,
      [txId, saraUser.id, aastuUniversityId]
    );
    const payment = rows[0];

    // Dawit attempts to complete Sara's payment
    const res = await apiRequest(`/api/payments/mock/${payment.id}/complete`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${dawitToken}`,
        "X-University-Id": aastuUniversityId,
      },
      body: { outcome: "success" },
    });

    assert.equal(res.status, 403);
    const { rows: checkRows } = await db.query("SELECT status FROM payments WHERE id = $1", [payment.id]);
    assert.equal(checkRows[0].status, "pending");
  });

  test("1.6 Rejects replay / repeated completion on already confirmed payment (HTTP 409 PAYMENT_NOT_PENDING)", async () => {
    const txId = crypto.randomUUID();
    const { rows } = await db.query(
      `INSERT INTO payments (transaction_type, transaction_id, provider, amount, status, payer_id, currency, university_id)
       VALUES ('test_payable', $1, 'mock', 99.00, 'confirmed', $2, 'ETB', $3) RETURNING *`,
      [txId, saraUser.id, aastuUniversityId]
    );
    const payment = rows[0];

    const res = await apiRequest(`/api/payments/mock/${payment.id}/complete`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${saraToken}`,
        "X-University-Id": aastuUniversityId,
      },
      body: { outcome: "success" },
    });

    assert.equal(res.status, 409);
    assert.equal(res.data.error.code, "PAYMENT_NOT_PENDING");
  });

  test("1.7 Amount and currency are server-trusted and ignore client tampering", async () => {
    const txId = crypto.randomUUID();
    const serverAmount = 300.0;
    const { rows } = await db.query(
      `INSERT INTO payments (transaction_type, transaction_id, provider, amount, status, payer_id, currency, university_id)
       VALUES ('test_payable', $1, 'mock', $2, 'pending', $3, 'ETB', $4) RETURNING *`,
      [txId, serverAmount, saraUser.id, aastuUniversityId]
    );
    const payment = rows[0];

    // Client passes manipulated amount in request body
    const res = await apiRequest(`/api/payments/mock/${payment.id}/complete`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${saraToken}`,
        "X-University-Id": aastuUniversityId,
      },
      body: { outcome: "success", amount: 0.01, currency: "USD" },
    });

    assert.equal(res.status, 200);

    // Verify charge transaction recorded server amount (300.00), not 0.01
    const { rows: txRows } = await db.query(
      "SELECT amount FROM transactions WHERE payment_id = $1 AND type = 'charge'",
      [payment.id]
    );
    assert.equal(txRows.length, 1);
    assert.equal(Number(txRows[0].amount), 300.0);
  });
});

// ============================================================================
// TASK 2: IMPLEMENT SECURE CHAPA PAYMENT VERIFICATION
// ============================================================================
describe("Task 2: Secure Chapa Payment Verification & Webhook", () => {
  let saraUser;

  before(async () => {
    const { rows } = await db.query("SELECT * FROM users WHERE email = 'sara@aastu.edu.et'");
    saraUser = rows[0];
  });

  test("2.1 Valid webhook signature and Chapa verification confirms payment", async () => {
    const txId = crypto.randomUUID();
    const amount = 450.0;
    const { rows } = await db.query(
      `INSERT INTO payments (transaction_type, transaction_id, provider, amount, status, payer_id, currency, university_id)
       VALUES ('test_payable', $1, 'chapa', $2, 'pending', $3, 'ETB', $4) RETURNING *`,
      [txId, amount, saraUser.id, aastuUniversityId]
    );
    const payment = rows[0];

    // Mock Chapa server-side verification response
    chapaProvider._setMockVerifier((txRef) => {
      assert.equal(txRef, payment.id);
      return {
        success: true,
        amount: 450.0,
        currency: "ETB",
        txRef: payment.id,
        reference: "CHAPA-REF-SUCCESS-001",
        status: "success",
        raw: { status: "success" },
      };
    });

    const payload = JSON.stringify({
      event: "charge.complete",
      tx_ref: payment.id,
      amount: "450.00",
      currency: "ETB",
    });
    const signature = signChapaWebhook(payload);

    const res = await apiRequest("/api/payments/webhook", {
      method: "POST",
      headers: {
        "x-chapa-signature": signature,
        "Content-Type": "application/json",
      },
      rawBody: payload,
    });

    assert.equal(res.status, 200);
    assert.equal(res.data.status, "success");
    assert.equal(res.data.paymentId, payment.id);

    // Verify DB
    const { rows: checkRows } = await db.query("SELECT * FROM payments WHERE id = $1", [payment.id]);
    assert.equal(checkRows[0].status, "confirmed");
    assert.equal(checkRows[0].provider_ref, "CHAPA-REF-SUCCESS-001");
    assert.ok(testFinalizerCalls.confirmed.includes(txId));

    // Verify transaction row
    const { rows: txRows } = await db.query("SELECT * FROM transactions WHERE payment_id = $1 AND type = 'charge'", [
      payment.id,
    ]);
    assert.equal(txRows.length, 1);
    assert.equal(Number(txRows[0].amount), 450.0);
  });

  test("2.2 Rejects webhook missing signature header (HTTP 401 MISSING_SIGNATURE)", async () => {
    const payload = JSON.stringify({ tx_ref: crypto.randomUUID() });
    const res = await apiRequest("/api/payments/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      rawBody: payload,
    });

    assert.equal(res.status, 401);
    assert.equal(res.data.error.code, "MISSING_SIGNATURE");
  });

  test("2.3 Rejects webhook with invalid HMAC signature (HTTP 401 INVALID_SIGNATURE)", async () => {
    const payload = JSON.stringify({ tx_ref: crypto.randomUUID() });
    const badSignature = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

    const res = await apiRequest("/api/payments/webhook", {
      method: "POST",
      headers: {
        "x-chapa-signature": badSignature,
        "Content-Type": "application/json",
      },
      rawBody: payload,
    });

    assert.equal(res.status, 401);
    assert.equal(res.data.error.code, "INVALID_SIGNATURE");
  });

  test("2.4 Rejects webhook with missing transaction reference (HTTP 400 MISSING_TX_REF)", async () => {
    const payload = JSON.stringify({ event: "charge.complete" }); // no tx_ref
    const signature = signChapaWebhook(payload);

    const res = await apiRequest("/api/payments/webhook", {
      method: "POST",
      headers: {
        "x-chapa-signature": signature,
        "Content-Type": "application/json",
      },
      rawBody: payload,
    });

    assert.equal(res.status, 400);
    assert.equal(res.data.error.code, "MISSING_TX_REF");
  });

  test("2.5 Rejects webhook when payment reference does not exist (HTTP 404 NOT_FOUND)", async () => {
    const nonexistentId = crypto.randomUUID();
    const payload = JSON.stringify({ tx_ref: nonexistentId });
    const signature = signChapaWebhook(payload);

    const res = await apiRequest("/api/payments/webhook", {
      method: "POST",
      headers: {
        "x-chapa-signature": signature,
        "Content-Type": "application/json",
      },
      rawBody: payload,
    });

    assert.equal(res.status, 404);
  });

  test("2.6 Handles failed Chapa verification by marking payment failed", async () => {
    const txId = crypto.randomUUID();
    const { rows } = await db.query(
      `INSERT INTO payments (transaction_type, transaction_id, provider, amount, status, payer_id, currency, university_id)
       VALUES ('test_payable', $1, 'chapa', 180.00, 'pending', $2, 'ETB', $3) RETURNING *`,
      [txId, saraUser.id, aastuUniversityId]
    );
    const payment = rows[0];

    chapaProvider._setMockVerifier(() => ({
      success: false,
      amount: 180.0,
      currency: "ETB",
      txRef: payment.id,
      status: "failed",
    }));

    const payload = JSON.stringify({ tx_ref: payment.id });
    const signature = signChapaWebhook(payload);

    const res = await apiRequest("/api/payments/webhook", {
      method: "POST",
      headers: {
        "x-chapa-signature": signature,
        "Content-Type": "application/json",
      },
      rawBody: payload,
    });

    assert.equal(res.status, 200);
    assert.equal(res.data.status, "failed");

    const { rows: checkRows } = await db.query("SELECT status FROM payments WHERE id = $1", [payment.id]);
    assert.equal(checkRows[0].status, "failed");
    assert.ok(testFinalizerCalls.failed.includes(txId));
  });

  test("2.7 Rejects payment if Chapa verified amount does not match DB amount (HTTP 400 AMOUNT_MISMATCH)", async () => {
    const txId = crypto.randomUUID();
    const { rows } = await db.query(
      `INSERT INTO payments (transaction_type, transaction_id, provider, amount, status, payer_id, currency, university_id)
       VALUES ('test_payable', $1, 'chapa', 500.00, 'pending', $2, 'ETB', $3) RETURNING *`,
      [txId, saraUser.id, aastuUniversityId]
    );
    const payment = rows[0];

    // Chapa reports amount was only 50.00 instead of 500.00
    chapaProvider._setMockVerifier(() => ({
      success: true,
      amount: 50.0,
      currency: "ETB",
      txRef: payment.id,
      status: "success",
    }));

    const payload = JSON.stringify({ tx_ref: payment.id });
    const signature = signChapaWebhook(payload);

    const res = await apiRequest("/api/payments/webhook", {
      method: "POST",
      headers: {
        "x-chapa-signature": signature,
        "Content-Type": "application/json",
      },
      rawBody: payload,
    });

    assert.equal(res.status, 400);
    assert.equal(res.data.error.code, "AMOUNT_MISMATCH");

    // Payment should be marked failed to prevent further exploitation
    const { rows: checkRows } = await db.query("SELECT status FROM payments WHERE id = $1", [payment.id]);
    assert.equal(checkRows[0].status, "failed");
    assert.ok(testFinalizerCalls.failed.includes(txId));
  });

  test("2.8 Rejects payment if Chapa verified currency does not match ETB (HTTP 400 CURRENCY_MISMATCH)", async () => {
    const txId = crypto.randomUUID();
    const { rows } = await db.query(
      `INSERT INTO payments (transaction_type, transaction_id, provider, amount, status, payer_id, currency, university_id)
       VALUES ('test_payable', $1, 'chapa', 500.00, 'pending', $2, 'ETB', $3) RETURNING *`,
      [txId, saraUser.id, aastuUniversityId]
    );
    const payment = rows[0];

    chapaProvider._setMockVerifier(() => ({
      success: true,
      amount: 500.0,
      currency: "USD",
      txRef: payment.id,
      status: "success",
    }));

    const payload = JSON.stringify({ tx_ref: payment.id });
    const signature = signChapaWebhook(payload);

    const res = await apiRequest("/api/payments/webhook", {
      method: "POST",
      headers: {
        "x-chapa-signature": signature,
        "Content-Type": "application/json",
      },
      rawBody: payload,
    });

    assert.equal(res.status, 400);
    assert.equal(res.data.error.code, "CURRENCY_MISMATCH");

    const { rows: checkRows } = await db.query("SELECT status FROM payments WHERE id = $1", [payment.id]);
    assert.equal(checkRows[0].status, "failed");
    assert.ok(testFinalizerCalls.failed.includes(txId));
  });

  test("2.9 Webhook is idempotent on duplicate delivery", async () => {
    const txId = crypto.randomUUID();
    const { rows } = await db.query(
      `INSERT INTO payments (transaction_type, transaction_id, provider, amount, status, payer_id, currency, university_id)
       VALUES ('test_payable', $1, 'chapa', 220.00, 'confirmed', $2, 'ETB', $3) RETURNING *`,
      [txId, saraUser.id, aastuUniversityId]
    );
    const payment = rows[0];

    const payload = JSON.stringify({ tx_ref: payment.id });
    const signature = signChapaWebhook(payload);

    const res = await apiRequest("/api/payments/webhook", {
      method: "POST",
      headers: {
        "x-chapa-signature": signature,
        "Content-Type": "application/json",
      },
      rawBody: payload,
    });

    assert.equal(res.status, 200);
    assert.equal(res.data.status, "success");
    assert.equal(res.data.idempotent, true);

    // Ensure finalizer was not re-executed
    assert.equal(testFinalizerCalls.confirmed.length, 0);
  });

  test("2.10 Concurrent webhook deliveries resolve safely without duplicate confirmation", async () => {
    const txId = crypto.randomUUID();
    const { rows } = await db.query(
      `INSERT INTO payments (transaction_type, transaction_id, provider, amount, status, payer_id, currency, university_id)
       VALUES ('test_payable', $1, 'chapa', 75.00, 'pending', $2, 'ETB', $3) RETURNING *`,
      [txId, saraUser.id, aastuUniversityId]
    );
    const payment = rows[0];

    chapaProvider._setMockVerifier(() => ({
      success: true,
      amount: 75.0,
      currency: "ETB",
      txRef: payment.id,
      reference: "CHAPA-CONCURRENT-001",
      status: "success",
    }));

    const payload = JSON.stringify({ tx_ref: payment.id });
    const signature = signChapaWebhook(payload);

    // Fire 3 simultaneous webhook deliveries
    const responses = await Promise.all([
      apiRequest("/api/payments/webhook", {
        method: "POST",
        headers: { "x-chapa-signature": signature, "Content-Type": "application/json" },
        rawBody: payload,
      }),
      apiRequest("/api/payments/webhook", {
        method: "POST",
        headers: { "x-chapa-signature": signature, "Content-Type": "application/json" },
        rawBody: payload,
      }),
      apiRequest("/api/payments/webhook", {
        method: "POST",
        headers: { "x-chapa-signature": signature, "Content-Type": "application/json" },
        rawBody: payload,
      }),
    ]);

    for (const r of responses) {
      assert.equal(r.status, 200);
    }

    // Ensure exactly ONE charge transaction was recorded
    const { rows: txRows } = await db.query("SELECT * FROM transactions WHERE payment_id = $1 AND type = 'charge'", [
      payment.id,
    ]);
    assert.equal(txRows.length, 1);
    // Ensure onConfirmed called exactly once
    assert.equal(testFinalizerCalls.confirmed.filter((id) => id === txId).length, 1);
  });

  test("2.11 Chapa v2 webhook containing merchant_reference and chapa_reference confirms payment", async () => {
    const txId = crypto.randomUUID();
    const { rows } = await db.query(
      `INSERT INTO payments (transaction_type, transaction_id, provider, amount, status, payer_id, currency, university_id)
       VALUES ('test_payable', $1, 'chapa', 300.00, 'pending', $2, 'ETB', $3) RETURNING *`,
      [txId, saraUser.id, aastuUniversityId]
    );
    const payment = rows[0];

    chapaProvider._setMockVerifier((reference) => {
      assert.equal(reference, payment.id);
      return {
        success: true,
        amount: 300.0,
        currency: "ETB",
        txRef: payment.id,
        merchant_reference: payment.id,
        chapa_reference: "CHAPA-V2-REF-999",
        reference: "CHAPA-V2-REF-999",
        status: "success",
      };
    });

    // Chapa v2 documented payload format
    const payload = JSON.stringify({
      webhook_type: "payment",
      event: "payment.success",
      status: "success",
      mode: "live",
      amount: "300.00",
      currency: "ETB",
      merchant_reference: payment.id,
      chapa_reference: "CHAPA-V2-REF-999",
    });
    const signature = signChapaWebhook(payload);

    const res = await apiRequest("/api/payments/webhook", {
      method: "POST",
      headers: {
        "x-chapa-signature": signature,
        "Content-Type": "application/json",
      },
      rawBody: payload,
    });

    assert.equal(res.status, 200);
    assert.equal(res.data.status, "success");

    const { rows: checkRows } = await db.query("SELECT * FROM payments WHERE id = $1", [payment.id]);
    assert.equal(checkRows[0].status, "confirmed");
    assert.equal(checkRows[0].provider_ref, "CHAPA-V2-REF-999");
    assert.ok(testFinalizerCalls.confirmed.includes(txId));
  });

  test("2.12 Chapa webhook with merchant_reference in nested data object succeeds", async () => {
    const txId = crypto.randomUUID();
    const { rows } = await db.query(
      `INSERT INTO payments (transaction_type, transaction_id, provider, amount, status, payer_id, currency, university_id)
       VALUES ('test_payable', $1, 'chapa', 150.00, 'pending', $2, 'ETB', $3) RETURNING *`,
      [txId, saraUser.id, aastuUniversityId]
    );
    const payment = rows[0];

    chapaProvider._setMockVerifier(() => ({
      success: true,
      amount: 150.0,
      currency: "ETB",
      txRef: payment.id,
      status: "success",
    }));

    const payload = JSON.stringify({
      event: "payment.success",
      data: {
        merchant_reference: payment.id,
        amount: 150.0,
        currency: "ETB",
      },
    });
    const signature = signChapaWebhook(payload);

    const res = await apiRequest("/api/payments/webhook", {
      method: "POST",
      headers: { "x-chapa-signature": signature, "Content-Type": "application/json" },
      rawBody: payload,
    });

    assert.equal(res.status, 200);
    assert.equal(res.data.status, "success");
  });

  test("2.13 Rejects body modified after HMAC signature was calculated (tampered body)", async () => {
    const originalPayload = JSON.stringify({ tx_ref: crypto.randomUUID(), amount: "100.00" });
    const originalSignature = signChapaWebhook(originalPayload);

    // Attacker sends a modified body with the original signature
    const tamperedPayload = JSON.stringify({ tx_ref: crypto.randomUUID(), amount: "10.00" });

    const res = await apiRequest("/api/payments/webhook", {
      method: "POST",
      headers: {
        "x-chapa-signature": originalSignature,
        "Content-Type": "application/json",
      },
      rawBody: tamperedPayload,
    });

    assert.equal(res.status, 401);
    assert.equal(res.data.error.code, "INVALID_SIGNATURE");
  });

  test("2.14 Rejects malformed non-UUID reference safely without 500 DB error (HTTP 404 NOT_FOUND)", async () => {
    const payload = JSON.stringify({ merchant_reference: "not-a-valid-uuid-12345" });
    const signature = signChapaWebhook(payload);

    const res = await apiRequest("/api/payments/webhook", {
      method: "POST",
      headers: { "x-chapa-signature": signature, "Content-Type": "application/json" },
      rawBody: payload,
    });

    assert.equal(res.status, 404);
    assert.equal(res.data.error.code, "NOT_FOUND");
  });

  test("2.15 Never confirms payment solely because webhook payload claims it succeeded", async () => {
    const txId = crypto.randomUUID();
    const { rows } = await db.query(
      `INSERT INTO payments (transaction_type, transaction_id, provider, amount, status, payer_id, currency, university_id)
       VALUES ('test_payable', $1, 'chapa', 200.00, 'pending', $2, 'ETB', $3) RETURNING *`,
      [txId, saraUser.id, aastuUniversityId]
    );
    const payment = rows[0];

    // Webhook claims success, but Chapa server verification returns failed
    chapaProvider._setMockVerifier(() => ({
      success: false,
      amount: 200.0,
      currency: "ETB",
      txRef: payment.id,
      status: "failed",
    }));

    const payload = JSON.stringify({
      event: "payment.success",
      status: "success",
      merchant_reference: payment.id,
    });
    const signature = signChapaWebhook(payload);

    const res = await apiRequest("/api/payments/webhook", {
      method: "POST",
      headers: { "x-chapa-signature": signature, "Content-Type": "application/json" },
      rawBody: payload,
    });

    assert.equal(res.status, 200);
    assert.equal(res.data.status, "failed");

    const { rows: checkRows } = await db.query("SELECT status FROM payments WHERE id = $1", [payment.id]);
    assert.equal(checkRows[0].status, "failed");
    assert.ok(!testFinalizerCalls.confirmed.includes(txId));
    assert.ok(testFinalizerCalls.failed.includes(txId));
  });

  test("2.16 Temporary upstream network failure returns HTTP 502 and keeps payment pending", async () => {
    const txId = crypto.randomUUID();
    const { rows } = await db.query(
      `INSERT INTO payments (transaction_type, transaction_id, provider, amount, status, payer_id, currency, university_id)
       VALUES ('test_payable', $1, 'chapa', 500.00, 'pending', $2, 'ETB', $3) RETURNING *`,
      [txId, saraUser.id, aastuUniversityId]
    );
    const payment = rows[0];

    // Simulate upstream connection failure
    chapaProvider._setMockVerifier(() => {
      const err = new Error("connect ECONNREFUSED 104.21.52.88:443");
      err.code = "ECONNREFUSED";
      err.isUpstreamError = true;
      throw err;
    });

    const payload = JSON.stringify({ merchant_reference: payment.id });
    const signature = signChapaWebhook(payload);

    const res = await apiRequest("/api/payments/webhook", {
      method: "POST",
      headers: { "x-chapa-signature": signature, "Content-Type": "application/json" },
      rawBody: payload,
    });

    assert.equal(res.status, 502);
    assert.equal(res.data.error.code, "BAD_GATEWAY");

    // CRITICAL: Payment must REMAIN pending and recoverable
    const { rows: checkRows } = await db.query("SELECT status FROM payments WHERE id = $1", [payment.id]);
    assert.equal(checkRows[0].status, "pending");
    assert.equal(testFinalizerCalls.failed.length, 0);
    assert.equal(testFinalizerCalls.confirmed.length, 0);
  });

  test("2.17 Upstream timeout returns HTTP 504 GATEWAY_TIMEOUT and keeps payment pending", async () => {
    const txId = crypto.randomUUID();
    const { rows } = await db.query(
      `INSERT INTO payments (transaction_type, transaction_id, provider, amount, status, payer_id, currency, university_id)
       VALUES ('test_payable', $1, 'chapa', 350.00, 'pending', $2, 'ETB', $3) RETURNING *`,
      [txId, saraUser.id, aastuUniversityId]
    );
    const payment = rows[0];

    // Simulate upstream request timeout
    chapaProvider._setMockVerifier(() => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      err.isUpstreamError = true;
      throw err;
    });

    const payload = JSON.stringify({ merchant_reference: payment.id });
    const signature = signChapaWebhook(payload);

    const res = await apiRequest("/api/payments/webhook", {
      method: "POST",
      headers: { "x-chapa-signature": signature, "Content-Type": "application/json" },
      rawBody: payload,
    });

    assert.equal(res.status, 504);
    assert.equal(res.data.error.code, "GATEWAY_TIMEOUT");

    const { rows: checkRows } = await db.query("SELECT status FROM payments WHERE id = $1", [payment.id]);
    assert.equal(checkRows[0].status, "pending");
  });

  test("2.18 Upstream 503 response from Chapa returns HTTP 502 and keeps payment pending", async () => {
    const txId = crypto.randomUUID();
    const { rows } = await db.query(
      `INSERT INTO payments (transaction_type, transaction_id, provider, amount, status, payer_id, currency, university_id)
       VALUES ('test_payable', $1, 'chapa', 120.00, 'pending', $2, 'ETB', $3) RETURNING *`,
      [txId, saraUser.id, aastuUniversityId]
    );
    const payment = rows[0];

    chapaProvider._setMockVerifier(() => {
      const err = new Error("Chapa verify upstream server error (503): Service Unavailable");
      err.status = 503;
      err.isUpstreamError = true;
      throw err;
    });

    const payload = JSON.stringify({ merchant_reference: payment.id });
    const signature = signChapaWebhook(payload);

    const res = await apiRequest("/api/payments/webhook", {
      method: "POST",
      headers: { "x-chapa-signature": signature, "Content-Type": "application/json" },
      rawBody: payload,
    });

    assert.equal(res.status, 502);

    const { rows: checkRows } = await db.query("SELECT status FROM payments WHERE id = $1", [payment.id]);
    assert.equal(checkRows[0].status, "pending");
  });

  test("2.19 Successful webhook retry after temporary upstream error confirms payment exactly once", async () => {
    const txId = crypto.randomUUID();
    const { rows } = await db.query(
      `INSERT INTO payments (transaction_type, transaction_id, provider, amount, status, payer_id, currency, university_id)
       VALUES ('test_payable', $1, 'chapa', 400.00, 'pending', $2, 'ETB', $3) RETURNING *`,
      [txId, saraUser.id, aastuUniversityId]
    );
    const payment = rows[0];

    // Attempt 1: Upstream network error -> 502
    chapaProvider._setMockVerifier(() => {
      const err = new Error("temporary network drop");
      err.isUpstreamError = true;
      err.status = 502;
      throw err;
    });

    const payload = JSON.stringify({ merchant_reference: payment.id });
    const signature = signChapaWebhook(payload);

    const res1 = await apiRequest("/api/payments/webhook", {
      method: "POST",
      headers: { "x-chapa-signature": signature, "Content-Type": "application/json" },
      rawBody: payload,
    });
    assert.equal(res1.status, 502);

    // Attempt 2: Network is restored -> 200 success
    chapaProvider._setMockVerifier(() => ({
      success: true,
      amount: 400.0,
      currency: "ETB",
      txRef: payment.id,
      merchant_reference: payment.id,
      chapa_reference: "CHAPA-RETRY-001",
      status: "success",
    }));

    const res2 = await apiRequest("/api/payments/webhook", {
      method: "POST",
      headers: { "x-chapa-signature": signature, "Content-Type": "application/json" },
      rawBody: payload,
    });

    assert.equal(res2.status, 200);
    assert.equal(res2.data.status, "success");

    // Verified confirmed
    const { rows: checkRows } = await db.query("SELECT * FROM payments WHERE id = $1", [payment.id]);
    assert.equal(checkRows[0].status, "confirmed");
    assert.equal(checkRows[0].provider_ref, "CHAPA-RETRY-001");
    assert.equal(testFinalizerCalls.confirmed.filter((id) => id === txId).length, 1);
  });

  test("2.20 Correctly matches Chapa v2 verification response with merchant_reference and chapa_reference", async () => {
    const txId = crypto.randomUUID();
    const { rows } = await db.query(
      `INSERT INTO payments (transaction_type, transaction_id, provider, amount, status, payer_id, currency, university_id)
       VALUES ('test_payable', $1, 'chapa', 650.00, 'pending', $2, 'ETB', $3) RETURNING *`,
      [txId, saraUser.id, aastuUniversityId]
    );
    const payment = rows[0];

    // Chapa v2 response structure
    chapaProvider._setMockVerifier((ref) => {
      assert.equal(ref, payment.id);
      return {
        success: true,
        amount: 650.0,
        currency: "ETB",
        txRef: payment.id,
        merchant_reference: payment.id,
        chapa_reference: "CHAPA-V2-MATCHED-99",
        status: "success",
        raw: {
          status: "success",
          data: {
            chapa_reference: "CHAPA-V2-MATCHED-99",
            merchant_reference: payment.id,
            amount: 65000,
            currency: "ETB",
            status: "success",
          },
        },
      };
    });

    const payload = JSON.stringify({ merchant_reference: payment.id });
    const signature = signChapaWebhook(payload);

    const res = await apiRequest("/api/payments/webhook", {
      method: "POST",
      headers: { "x-chapa-signature": signature, "Content-Type": "application/json" },
      rawBody: payload,
    });

    assert.equal(res.status, 200);
    const { rows: checkRows } = await db.query("SELECT * FROM payments WHERE id = $1", [payment.id]);
    assert.equal(checkRows[0].status, "confirmed");
    assert.equal(checkRows[0].provider_ref, "CHAPA-V2-MATCHED-99");
  });
});

// ============================================================================
// TASK 3: ENFORCE EMAIL OTP VERIFICATION AT LOGIN
// ============================================================================
describe("Task 3: Enforce Email OTP Verification at Login", () => {
  const unverifiedEmail = "unverified_test_student@aastu.edu.et";
  const unverifiedMerchantEmail = "unverified_test_merchant@aastu.edu.et";
  const testPassword = "Password123!";
  let unverifiedUser;
  let devSignupOtp;

  async function cleanupTestUsers() {
    await db.query(
      "DELETE FROM audit_logs WHERE actor_id IN (SELECT id FROM users WHERE email IN ($1, $2))",
      [unverifiedEmail, unverifiedMerchantEmail]
    );
    await db.query(
      "DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE email IN ($1, $2))",
      [unverifiedEmail, unverifiedMerchantEmail]
    );
    await db.query(
      "DELETE FROM email_otps WHERE user_id IN (SELECT id FROM users WHERE email IN ($1, $2))",
      [unverifiedEmail, unverifiedMerchantEmail]
    );
    await db.query("DELETE FROM users WHERE email IN ($1, $2)", [unverifiedEmail, unverifiedMerchantEmail]);
  }

  before(async () => {
    // Clean up any leftovers from prior runs
    await cleanupTestUsers();

    // Register a student account
    const res = await apiRequest("/api/auth/register", {
      method: "POST",
      body: {
        name: "Test Unverified Student",
        email: unverifiedEmail,
        password: testPassword,
        role: "student",
        universityId: aastuUniversityId,
      },
    });

    assert.equal(res.status, 201);
    unverifiedUser = res.data.user;
    devSignupOtp = res.data.devOtp;
    assert.equal(unverifiedUser.email_verified, false);
  });

  after(async () => {
    await cleanupTestUsers();
  });

  test("3.1 Reject login for unverified student (HTTP 403 EMAIL_NOT_VERIFIED)", async () => {
    const res = await apiRequest("/api/auth/login", {
      method: "POST",
      body: {
        email: unverifiedEmail,
        password: testPassword,
      },
    });

    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, "EMAIL_NOT_VERIFIED");
    assert.match(res.data.error.message, /verify your email/i);
  });

  test("3.2 Incorrect password on unverified user returns HTTP 401 (no account enumeration)", async () => {
    const res = await apiRequest("/api/auth/login", {
      method: "POST",
      body: {
        email: unverifiedEmail,
        password: "WrongPassword999!",
      },
    });

    assert.equal(res.status, 401);
    assert.equal(res.data.error.code, "UNAUTHENTICATED");
    assert.match(res.data.error.message, /invalid email or password/i);
  });

  test("3.3 Reject login for unverified merchant (HTTP 403 EMAIL_NOT_VERIFIED)", async () => {
    const regRes = await apiRequest("/api/auth/register", {
      method: "POST",
      body: {
        name: "Test Unverified Merchant",
        email: unverifiedMerchantEmail,
        password: testPassword,
        role: "merchant",
        universityId: aastuUniversityId,
      },
    });
    assert.equal(regRes.status, 201);

    const loginRes = await apiRequest("/api/auth/login", {
      method: "POST",
      body: {
        email: unverifiedMerchantEmail,
        password: testPassword,
      },
    });

    assert.equal(loginRes.status, 403);
    assert.equal(loginRes.data.error.code, "EMAIL_NOT_VERIFIED");
  });

  test("3.4 Reject refresh token request for unverified account (HTTP 403 EMAIL_NOT_VERIFIED)", async () => {
    const refreshToken = "test_raw_refresh_token_for_unverified";
    const tokenHash = crypto.createHash("sha256").update(refreshToken).digest("hex");
    const familyId = crypto.randomUUID();

    await db.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 day')`,
      [unverifiedUser.id, tokenHash, familyId]
    );

    const res = await apiRequest("/api/auth/refresh", {
      method: "POST",
      body: { refreshToken },
    });

    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, "EMAIL_NOT_VERIFIED");
  });

  test("3.5 Reject requireAuth request for unverified account token (HTTP 403 EMAIL_NOT_VERIFIED)", async () => {
    const token = signAccessToken({
      id: unverifiedUser.id,
      role: unverifiedUser.role,
      university_id: aastuUniversityId,
    });

    const res = await apiRequest("/api/users/me", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, "EMAIL_NOT_VERIFIED");
  });

  test("3.6 Email verification via OTP unlocks login successfully", async () => {
    assert.ok(devSignupOtp, "Expected devOtp from registration response");

    // Verify email with OTP
    const verifyRes = await apiRequest("/api/auth/verify-email", {
      method: "POST",
      body: {
        email: unverifiedEmail,
        otp: devSignupOtp,
      },
    });

    assert.equal(verifyRes.status, 200);
    assert.equal(verifyRes.data.success, true);

    // Verify user in DB is now email_verified = true
    const { rows } = await db.query("SELECT email_verified FROM users WHERE id = $1", [unverifiedUser.id]);
    assert.equal(rows[0].email_verified, true);

    // Now login should succeed
    const loginRes = await apiRequest("/api/auth/login", {
      method: "POST",
      body: {
        email: unverifiedEmail,
        password: testPassword,
      },
    });

    assert.equal(loginRes.status, 200);
    assert.ok(loginRes.data.accessToken);
    assert.ok(loginRes.headers.get("set-cookie")?.includes("ch_refresh") || loginRes.data.refreshToken);
    assert.equal(loginRes.data.user.email_verified, true);
  });
});
