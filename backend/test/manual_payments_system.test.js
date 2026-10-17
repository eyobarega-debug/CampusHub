/**
 * Automated Test Suite — Complete Manual Payment System
 *
 * Verifies all business requirements for CampusHub manual payment flow:
 * 1. Material Sales (Orders): Direct merchant payment, merchant payment confirmation,
 *    independent buyer delivery receipt confirmation, 5% commission owed,
 *    merchant commission proof submission, and admin verification & settlement.
 * 2. Event Tickets: CampusHub official receiving account destination, student proof submission,
 *    admin-only approval enforcement (strict HTTP 403 for organizers/students),
 *    ticket activation with deterministic QR token, 2.5% platform commission retention,
 *    97.5% net payable attribution, organizer payout recording, and free ticket instant activation.
 * 3. Rentals (Bookings): Direct owner payment, owner payment confirmation,
 *    independent renter pickup confirmation, owner return confirmation, and 0% commission.
 * 4. Multi-Tenant Isolation & Partial Unique Index Idempotency.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const crypto = require("crypto");

process.env.NODE_ENV = "test";

const app = require("../src/app");
const db = require("../src/db");
const { hashPassword } = require("../src/utils/hash");
const { signAccessToken } = require("../src/utils/jwt");
const { isValidSignature } = require("../src/utils/qr");

const sharp = require("sharp");
const commissions = require("../src/services/commissions");

let server;
let baseUrl;

// Test fixtures
let uniA, uniB;
let adminAToken, adminAUser;
let adminBToken, adminBUser;
let studentA1Token, studentA1User;
let studentA2Token, studentA2User;
let studentBToken, studentBUser;
let merchantAToken, merchantAUser, storeA, productA;
let organizerAToken, organizerAUser, clubA, eventA, ticketTypePaid, ticketTypeFree;
let organizerBToken, organizerBUser, clubB, eventB, ticketTypeBPaid, ticketTypeBFree;
let lenderAToken, lenderAUser, rentalItemA;
let campusHubAccountA;
let superAdminToken, superAdminUser;

const cleanupUniIds = [];
const cleanupUserIds = [];

let pngSeq = 1;
async function makeUniquePngBuffer() {
  pngSeq++;
  return sharp({
    create: {
      width: 10,
      height: 10,
      channels: 4,
      background: {
        r: (pngSeq * 23) % 255,
        g: (pngSeq * 47) % 255,
        b: (pngSeq * 89) % 255,
        alpha: 1,
      },
    },
  })
    .png()
    .toBuffer();
}

async function apiRequest(endpoint, { method = "GET", headers = {}, body } = {}) {
  const reqHeaders = { ...headers };
  let payload = undefined;

  if (body !== undefined) {
    if (body instanceof FormData) {
      payload = body;
    } else {
      payload = JSON.stringify(body);
      reqHeaders["Content-Type"] = "application/json";
    }
  }

  const res = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers: reqHeaders,
    body: payload,
  });

  let data = null;
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    data = await res.json();
  } else {
    data = await res.text();
  }

  return { status: res.status, headers: res.headers, data };
}

let pwHash;
let runId;

async function makeUser(uniId, name, email, role) {
  const { rows } = await db.query(
    `INSERT INTO users (university_id, name, email, password_hash, role, verified, email_verified)
     VALUES ($1, $2, $3, $4, $5, true, true) RETURNING *`,
    [uniId, name, `${email}.${runId}@test.edu.et`, pwHash, role]
  );
  cleanupUserIds.push(rows[0].id);
  return { user: rows[0], token: signAccessToken(rows[0]) };
}

before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  pwHash = await hashPassword("TestPassword123!");
  runId = crypto.randomUUID().slice(0, 8);

  // Clean up any leftover manual test records safely
  const { rows: oldUnis } = await db.query("SELECT id FROM universities WHERE slug LIKE 'manual-%'");
  if (oldUnis.length > 0) {
    const oldIds = oldUnis.map((u) => u.id);
    await db.query("DELETE FROM audit_logs WHERE university_id = ANY($1)", [oldIds]);
    await db.query("DELETE FROM commission_payments WHERE university_id = ANY($1)", [oldIds]);
    await db.query("DELETE FROM organizer_payouts WHERE university_id = ANY($1)", [oldIds]);
    await db.query("DELETE FROM commissions WHERE university_id = ANY($1)", [oldIds]);
    await db.query("DELETE FROM payment_proofs WHERE university_id = ANY($1)", [oldIds]);
    await db.query("DELETE FROM payments WHERE university_id = ANY($1)", [oldIds]);
    await db.query("DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE university_id = ANY($1))", [oldIds]);
    await db.query("DELETE FROM order_status_history WHERE order_id IN (SELECT id FROM orders WHERE university_id = ANY($1))", [oldIds]);
    await db.query("DELETE FROM orders WHERE university_id = ANY($1)", [oldIds]);
    await db.query("DELETE FROM products WHERE store_id IN (SELECT id FROM stores WHERE university_id = ANY($1))", [oldIds]);
    await db.query("DELETE FROM stores WHERE university_id = ANY($1)", [oldIds]);
    await db.query("DELETE FROM tickets WHERE university_id = ANY($1)", [oldIds]);
    await db.query("DELETE FROM ticket_types WHERE university_id = ANY($1)", [oldIds]);
    await db.query("DELETE FROM events WHERE university_id = ANY($1)", [oldIds]);
    await db.query("DELETE FROM clubs WHERE university_id = ANY($1)", [oldIds]);
    await db.query("DELETE FROM rental_bookings WHERE university_id = ANY($1)", [oldIds]);
    await db.query("DELETE FROM rental_items WHERE university_id = ANY($1)", [oldIds]);
    await db.query("DELETE FROM payout_accounts WHERE university_id = ANY($1)", [oldIds]);
    await db.query("DELETE FROM users WHERE university_id = ANY($1)", [oldIds]);
    await db.query("DELETE FROM universities WHERE id = ANY($1)", [oldIds]);
  }

  // Create University A and B
  const { rows: uA } = await db.query(
    `INSERT INTO universities (name, domain, permitted_domains, status, slug)
     VALUES ($1, $2, ARRAY[$2]::text[], 'active', $3)
     RETURNING *`,
    [`Manual Test Uni A ${runId}`, `manual-a-${runId}.edu.et`, `manual-a-${runId}`]
  );
  uniA = uA[0];
  cleanupUniIds.push(uniA.id);

  const { rows: uB } = await db.query(
    `INSERT INTO universities (name, domain, permitted_domains, status, slug)
     VALUES ($1, $2, ARRAY[$2]::text[], 'active', $3)
     RETURNING *`,
    [`Manual Test Uni B ${runId}`, `manual-b-${runId}.edu.et`, `manual-b-${runId}`]
  );
  uniB = uB[0];
  cleanupUniIds.push(uniB.id);

  const admA = await makeUser(uniA.id, "Admin A", "admin.a", "admin");
  adminAUser = admA.user;
  adminAToken = admA.token;

  const admB = await makeUser(uniB.id, "Admin B", "admin.b", "admin");
  adminBUser = admB.user;
  adminBToken = admB.token;

  const stA1 = await makeUser(uniA.id, "Student A1", "student.a1", "student");
  studentA1User = stA1.user;
  studentA1Token = stA1.token;

  const stA2 = await makeUser(uniA.id, "Student A2", "student.a2", "student");
  studentA2User = stA2.user;
  studentA2Token = stA2.token;

  const stB = await makeUser(uniB.id, "Student B1", "student.b1", "student");
  studentBUser = stB.user;
  studentBToken = stB.token;

  const merchA = await makeUser(uniA.id, "Merchant A", "merchant.a", "merchant");
  merchantAUser = merchA.user;
  merchantAToken = merchA.token;

  const orgA = await makeUser(uniA.id, "Organizer A", "organizer.a", "organizer");
  organizerAUser = orgA.user;
  organizerAToken = orgA.token;

  const lendA = await makeUser(uniA.id, "Lender A", "lender.a", "student");
  lenderAUser = lendA.user;
  lenderAToken = lendA.token;

  const sAdm = await makeUser(uniA.id, "Super Admin", "super.admin", "super_admin");
  superAdminUser = sAdm.user;
  superAdminToken = sAdm.token;

  // Add payout accounts for Merchant A and Lender A
  await db.query(
    `INSERT INTO payout_accounts (university_id, owner_id, method, account_name, account_number, is_default, is_campus_hub, active)
     VALUES ($1, $2, 'telebirr', 'Merchant Store Telebirr', '0911000001', true, false, true)`,
    [uniA.id, merchantAUser.id]
  );
  await db.query(
    `INSERT INTO payout_accounts (university_id, owner_id, method, account_name, account_number, is_default, is_campus_hub, active)
     VALUES ($1, $2, 'telebirr', 'Lender Telebirr', '0911000002', true, false, true)`,
    [uniA.id, lenderAUser.id]
  );
  await db.query(
    `INSERT INTO payout_accounts (university_id, owner_id, method, account_name, account_number, is_default, is_campus_hub, active)
     VALUES ($1, $2, 'bank_transfer', 'Organizer CBE', '1000111222333', true, false, true)`,
    [uniA.id, organizerAUser.id]
  );

  // Configure CampusHub official university receiving account for Uni A
  const { rows: chRows } = await db.query(
    `INSERT INTO payout_accounts (university_id, owner_id, method, account_name, account_number, instructions, is_default, is_campus_hub, active)
     VALUES ($1, $2, 'telebirr', 'CampusHub AASTU Official', '0988776655', 'Put event ticket or commission reference', true, true, true)
     RETURNING *`,
    [uniA.id, adminAUser.id]
  );
  campusHubAccountA = chRows[0];

  // Create store and product for Merchant A
  const { rows: storeRows } = await db.query(
    `INSERT INTO stores (university_id, merchant_id, name, description)
     VALUES ($1, $2, 'Merchant A Shop', 'Store for manual tests') RETURNING *`,
    [uniA.id, merchantAUser.id]
  );
  storeA = storeRows[0];

  const { rows: prodRows } = await db.query(
    `INSERT INTO products (store_id, title, description, price, stock, images)
     VALUES ($1, 'Campus T-Shirt', 'Official shirt', 200.00, 50, ARRAY[]::text[]) RETURNING *`,
    [storeA.id]
  );
  productA = prodRows[0];

  // Create club, event, paid ticket type, and free ticket type for Organizer A
  const { rows: clubRows } = await db.query(
    `INSERT INTO clubs (university_id, name, lead_user_id)
     VALUES ($1, 'Tech Club A', $2) RETURNING *`,
    [uniA.id, organizerAUser.id]
  );
  clubA = clubRows[0];

  const futureDate = new Date(Date.now() + 7 * 86400000).toISOString();
  const { rows: eventRows } = await db.query(
    `INSERT INTO events (university_id, club_id, title, description, date_time, location, capacity, status)
     VALUES ($1, $2, 'Campus Tech Fest 2026', 'Great event', $3, 'Auditorium', 200, 'published') RETURNING *`,
    [uniA.id, clubA.id, futureDate]
  );
  eventA = eventRows[0];

  const { rows: ttPaidRows } = await db.query(
    `INSERT INTO ticket_types (university_id, event_id, name, price, quantity_total, quantity_sold)
     VALUES ($1, $2, 'Regular Paid Pass', 100.00, 100, 0) RETURNING *`,
    [uniA.id, eventA.id]
  );
  ticketTypePaid = ttPaidRows[0];

  const { rows: ttFreeRows } = await db.query(
    `INSERT INTO ticket_types (university_id, event_id, name, price, quantity_total, quantity_sold)
     VALUES ($1, $2, 'Free Workshop Pass', 0.00, 50, 0) RETURNING *`,
    [uniA.id, eventA.id]
  );
  ticketTypeFree = ttFreeRows[0];

  // Create club, event, paid and free ticket types for Uni B (which has NO CampusHub official receiving account)
  const orgB = await makeUser(uniB.id, "Organizer B", "organizer.b", "organizer");
  organizerBUser = orgB.user;
  organizerBToken = orgB.token;

  const { rows: clubBRows } = await db.query(
    `INSERT INTO clubs (university_id, name, lead_user_id)
     VALUES ($1, 'Tech Club B', $2) RETURNING *`,
    [uniB.id, organizerBUser.id]
  );
  clubB = clubBRows[0];

  const { rows: eventBRows } = await db.query(
    `INSERT INTO events (university_id, club_id, title, description, date_time, location, capacity, status)
     VALUES ($1, $2, 'Uni B Tech Fest', 'Uni B Event without receiving account', $3, 'Hall B', 100, 'published') RETURNING *`,
    [uniB.id, clubB.id, futureDate]
  );
  eventB = eventBRows[0];

  const { rows: ttBPaidRows } = await db.query(
    `INSERT INTO ticket_types (university_id, event_id, name, price, quantity_total, quantity_sold)
     VALUES ($1, $2, 'Uni B Paid Pass', 50.00, 50, 0) RETURNING *`,
    [uniB.id, eventB.id]
  );
  ticketTypeBPaid = ttBPaidRows[0];

  const { rows: ttBFreeRows } = await db.query(
    `INSERT INTO ticket_types (university_id, event_id, name, price, quantity_total, quantity_sold)
     VALUES ($1, $2, 'Uni B Free Pass', 0.00, 50, 0) RETURNING *`,
    [uniB.id, eventB.id]
  );
  ticketTypeBFree = ttBFreeRows[0];

  // Create rental item for Lender A
  const { rows: rentalRows } = await db.query(
    `INSERT INTO rental_items (owner_id, title, price_per_day, deposit, available_from, available_to, status, university_id)
     VALUES ($1, 'Scientific Calculator', 20.00, 50.00, now() - interval '1 day', now() + interval '10 days', 'active', $2) RETURNING *`,
    [lenderAUser.id, uniA.id]
  );
  rentalItemA = rentalRows[0];
});

after(async () => {
  if (cleanupUniIds.length) {
    await db.query("DELETE FROM audit_logs WHERE university_id = ANY($1)", [cleanupUniIds]);
    await db.query("DELETE FROM commission_payments WHERE university_id = ANY($1)", [cleanupUniIds]);
    await db.query("DELETE FROM organizer_payouts WHERE university_id = ANY($1)", [cleanupUniIds]);
    await db.query("DELETE FROM commissions WHERE university_id = ANY($1)", [cleanupUniIds]);
    await db.query("DELETE FROM payment_proofs WHERE university_id = ANY($1)", [cleanupUniIds]);
    await db.query("DELETE FROM payments WHERE university_id = ANY($1)", [cleanupUniIds]);
    await db.query("DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE university_id = ANY($1))", [cleanupUniIds]);
    await db.query("DELETE FROM order_status_history WHERE order_id IN (SELECT id FROM orders WHERE university_id = ANY($1))", [cleanupUniIds]);
    await db.query("DELETE FROM orders WHERE university_id = ANY($1)", [cleanupUniIds]);
    await db.query("DELETE FROM products WHERE store_id IN (SELECT id FROM stores WHERE university_id = ANY($1))", [cleanupUniIds]);
    await db.query("DELETE FROM stores WHERE university_id = ANY($1)", [cleanupUniIds]);
    await db.query("DELETE FROM tickets WHERE university_id = ANY($1)", [cleanupUniIds]);
    await db.query("DELETE FROM ticket_types WHERE university_id = ANY($1)", [cleanupUniIds]);
    await db.query("DELETE FROM events WHERE university_id = ANY($1)", [cleanupUniIds]);
    await db.query("DELETE FROM clubs WHERE university_id = ANY($1)", [cleanupUniIds]);
    await db.query("DELETE FROM rental_bookings WHERE university_id = ANY($1)", [cleanupUniIds]);
    await db.query("DELETE FROM rental_items WHERE university_id = ANY($1)", [cleanupUniIds]);
    await db.query("DELETE FROM payout_accounts WHERE university_id = ANY($1)", [cleanupUniIds]);
    await db.query("DELETE FROM users WHERE id = ANY($1)", [cleanupUserIds]);
    await db.query("DELETE FROM universities WHERE id = ANY($1)", [cleanupUniIds]);
  }
  if (server) await new Promise((res) => server.close(res));
  await db.pool.end();
});

describe("Complete Manual Payment System — Comprehensive Suite", () => {
  let testOrderId;
  let testOrderPaymentId;
  let testPaidTicketId;
  let testPaidTicketPaymentId;
  let testBookingId;
  let testBookingPaymentId;

  // =========================================================================
  // Part 1: Material Sales (Orders)
  // =========================================================================
  describe("Part 1: Material Sales (Orders)", () => {
    test("1.1 Placing order initiates manual payment directed to merchant payout account (not CampusHub)", async () => {
      const res = await apiRequest("/api/orders", {
        method: "POST",
        headers: { Authorization: `Bearer ${studentA1Token}` },
        body: {
          items: [{ productId: productA.id, quantity: 2 }],
          paymentMethod: "manual",
        },
      });

      assert.equal(res.status, 201);
      assert.ok(res.data.order);
      assert.ok(res.data.payment);
      testOrderId = res.data.order.id;
      testOrderPaymentId = res.data.payment.paymentId;

      assert.equal(res.data.order.status, "pending_payment");
      assert.equal(Number(res.data.order.total_amount), 400.00);
      assert.equal(res.data.payment.provider, "manual");

      // Verify payment recipient instructions are the merchant's account
      const { rows: pRows } = await db.query("SELECT * FROM payments WHERE id = $1", [testOrderPaymentId]);
      assert.equal(pRows[0].payee_id, merchantAUser.id);
      assert.equal(pRows[0].payee_accounts?.[0]?.account_number, "0911000001");
    });

    test("1.2 Idempotency: Attempting to initiate a duplicate active payment on the same order fails", async () => {
      const { rows } = await db.query(
        "SELECT id FROM payments WHERE transaction_type = 'order' AND transaction_id = $1 AND status = 'pending'",
        [testOrderId]
      );
      assert.equal(rows.length, 1);

      // Attempting a direct insert with pending status should violate partial unique index
      let errorThrown = false;
      try {
        await db.query(
          `INSERT INTO payments (university_id, transaction_type, transaction_id, payer_id, payee_id, amount, provider, status)
           VALUES ($1, 'order', $2, $3, $4, 400.00, 'manual', 'pending')`,
          [uniA.id, testOrderId, studentA1User.id, merchantAUser.id]
        );
      } catch (err) {
        errorThrown = true;
        assert.match(err.message, /uq_payments_active_txn|unique constraint/i);
      }
      assert.ok(errorThrown, "Expected unique constraint uq_payments_active_txn violation");
    });

    test("1.3 Student uploads payment proof for order", async () => {
      const pngBuf = await makeUniquePngBuffer();
      const fd = new FormData();
      fd.append("screenshot", new Blob([pngBuf], { type: "image/png" }), "receipt.png");
      fd.append("referenceNumber", `ORD-REF-${Date.now()}-1`);

      const res = await apiRequest(`/api/payments/${testOrderPaymentId}/proof`, {
        method: "POST",
        headers: { Authorization: `Bearer ${studentA1Token}` },
        body: fd,
      });

      assert.equal(res.status, 201);
      assert.equal(res.data.payment.status, "under_review");
    });

    test("1.4 Merchant confirms payment receipt -> records merchant_confirmed_at, order moves to confirmed", async () => {
      const res = await apiRequest(`/api/payments/${testOrderPaymentId}/approve`, {
        method: "POST",
        headers: { Authorization: `Bearer ${merchantAToken}` },
      });

      assert.equal(res.status, 200);

      const { rows: oRows } = await db.query("SELECT * FROM orders WHERE id = $1", [testOrderId]);
      assert.equal(oRows[0].status, "confirmed");
      assert.ok(oRows[0].merchant_confirmed_at, "merchant_confirmed_at should be set");
      assert.equal(oRows[0].buyer_confirmed_at, null, "buyer_confirmed_at must not be set yet");
    });

    test("1.5 Exactly 5% commission is recorded as owed ('due') on the merchant account", async () => {
      const { rows: cRows } = await db.query(
        "SELECT * FROM commissions WHERE transaction_type = 'order' AND transaction_id = $1",
        [testOrderId]
      );

      assert.equal(cRows.length, 1);
      assert.equal(cRows[0].payee_id, merchantAUser.id);
      assert.equal(cRows[0].status, "due");
      // 5% of 400.00 = 20.00 birr
      assert.equal(Number(cRows[0].rate), 0.05);
      assert.equal(Number(cRows[0].commission_amount), 20.00);
    });

    test("1.6 Merchant prepares items and advances status to 'ready'", async () => {
      const res = await apiRequest(`/api/orders/${testOrderId}/status`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${merchantAToken}` },
        body: { status: "ready" },
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.order.status, "ready");
    });

    test("1.7 Merchant cannot confirm delivery receipt on behalf of the buyer (HTTP 403)", async () => {
      const res = await apiRequest(`/api/orders/${testOrderId}/confirm-receipt`, {
        method: "POST",
        headers: { Authorization: `Bearer ${merchantAToken}` },
      });

      // Role check rejects merchant (requires student)
      assert.equal(res.status, 403);
    });

    test("1.8 Unrelated student cannot confirm delivery receipt for another student's order (HTTP 403)", async () => {
      const res = await apiRequest(`/api/orders/${testOrderId}/confirm-receipt`, {
        method: "POST",
        headers: { Authorization: `Bearer ${studentA2Token}` },
      });

      assert.equal(res.status, 403);
    });

    test("1.9 Student buyer independently confirms material receipt -> records buyer_confirmed_at, order completes", async () => {
      const res = await apiRequest(`/api/orders/${testOrderId}/confirm-receipt`, {
        method: "POST",
        headers: { Authorization: `Bearer ${studentA1Token}` },
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.order.status, "completed");

      const { rows: oRows } = await db.query("SELECT * FROM orders WHERE id = $1", [testOrderId]);
      assert.equal(oRows[0].status, "completed");
      assert.ok(oRows[0].buyer_confirmed_at, "buyer_confirmed_at must be populated");
    });

    test("1.10 Merchant submits commission payment evidence to CampusHub official receiving account", async () => {
      const pngBuf = await makeUniquePngBuffer();
      const fd = new FormData();
      fd.append("screenshot", new Blob([pngBuf], { type: "image/png" }), "commission_proof.png");
      fd.append("amount", "20.00");
      fd.append("referenceNumber", `COMM-TRANSFER-${Date.now()}-1`);
      fd.append("notes", "5% commission for order");

      const res = await apiRequest("/api/commissions/submit-payment", {
        method: "POST",
        headers: { Authorization: `Bearer ${merchantAToken}` },
        body: fd,
      });

      assert.equal(res.status, 201);
      assert.equal(res.data.payment.status, "submitted");
      assert.equal(Number(res.data.payment.amount), 20.00);
      assert.match(res.data.payment.reference_number, /COMM-TRANSFER/);
    });

    test("1.11 Campus admin verifies commission payment and settles merchant due commissions", async () => {
      const { rows: cpRows } = await db.query(
        "SELECT * FROM commission_payments WHERE merchant_id = $1 AND status = 'submitted'",
        [merchantAUser.id]
      );
      assert.equal(cpRows.length, 1);
      const cpId = cpRows[0].id;

      const res = await apiRequest(`/api/commissions/admin/payments/${cpId}/verify`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminAToken}` },
        body: { notes: "Verified in Telebirr statement" },
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.payment.status, "verified");
      assert.equal(res.data.payment.settledCount, 1);

      // Verify commission row status changed from 'due' to 'settled'
      const { rows: cRows } = await db.query(
        "SELECT * FROM commissions WHERE transaction_type = 'order' AND transaction_id = $1",
        [testOrderId]
      );
      assert.equal(cRows[0].status, "settled");
      assert.ok(cRows[0].settled_at);
      assert.equal(cRows[0].settled_by, adminAUser.id);
    });
  });

  // =========================================================================
  // Part 2: Event Tickets & Admin Exclusive Review
  // =========================================================================
  describe("Part 2: Event Tickets & Admin Approval Only", () => {
    test("2.1 Free ticket claims immediately with valid signed QR token, zero payment gateway calls", async () => {
      const res = await apiRequest(`/api/events/${eventA.id}/tickets`, {
        method: "POST",
        headers: { Authorization: `Bearer ${studentA1Token}` },
        body: { ticketTypeId: ticketTypeFree.id, quantity: 1 },
      });

      assert.equal(res.status, 201);
      assert.ok(res.data.ticket);
      const freeTicket = res.data.ticket;
      assert.equal(freeTicket.status, "active");
      assert.ok(freeTicket.qr_token_hash);
      assert.equal(res.data.payment, null, "Free tickets must have no payment created");

      // Verify signed QR token is cryptographically valid
      assert.equal(isValidSignature(freeTicket.id, freeTicket.qr_token_hash), true);
    });

    test("2.2 Duplicate free ticket claim by same student is rejected (HTTP 409)", async () => {
      const res = await apiRequest(`/api/events/${eventA.id}/tickets`, {
        method: "POST",
        headers: { Authorization: `Bearer ${studentA1Token}` },
        body: { ticketTypeId: ticketTypeFree.id, quantity: 1 },
      });

      assert.equal(res.status, 409);
    });

    test("2.3 Paid ticket purchase initiates manual payment directed to CampusHub university account (not organizer)", async () => {
      const res = await apiRequest(`/api/events/${eventA.id}/tickets`, {
        method: "POST",
        headers: { Authorization: `Bearer ${studentA2Token}` },
        body: { ticketTypeId: ticketTypePaid.id, quantity: 1 },
      });

      assert.equal(res.status, 201);
      assert.ok(res.data.ticket);
      const ticket = res.data.ticket;
      testPaidTicketId = ticket.id;
      testPaidTicketPaymentId = res.data.payment.paymentId;

      assert.equal(ticket.status, "reserved");

      // Verify payment destination is CampusHub official account, NOT organizer
      const { rows: pRows } = await db.query("SELECT * FROM payments WHERE id = $1", [testPaidTicketPaymentId]);
      assert.equal(pRows[0].payee_id, adminAUser.id);
      assert.equal(pRows[0].payee_accounts?.[0]?.account_number, campusHubAccountA.account_number);
    });

    test("2.4 Student uploads payment proof for event ticket", async () => {
      const pngBuf = await makeUniquePngBuffer();
      const fd = new FormData();
      fd.append("screenshot", new Blob([pngBuf], { type: "image/png" }), "ticket_receipt.png");
      fd.append("referenceNumber", `TKT-TXN-${Date.now()}-1`);

      const res = await apiRequest(`/api/payments/${testPaidTicketPaymentId}/proof`, {
        method: "POST",
        headers: { Authorization: `Bearer ${studentA2Token}` },
        body: fd,
      });

      assert.equal(res.status, 201);
      assert.equal(res.data.payment.status, "under_review");
    });

    test("2.5 Event organizer attempting to approve ticket payment is strictly rejected (HTTP 403)", async () => {
      const res = await apiRequest(`/api/payments/${testPaidTicketPaymentId}/approve`, {
        method: "POST",
        headers: { Authorization: `Bearer ${organizerAToken}` },
      });

      assert.equal(res.status, 403);
      assert.match(res.data.error.message, /only an authorized gibiyachin administrator|only gibiyachin admin/i);
    });

    test("2.6 Student attempting to approve ticket payment is strictly rejected (HTTP 403)", async () => {
      const res = await apiRequest(`/api/payments/${testPaidTicketPaymentId}/approve`, {
        method: "POST",
        headers: { Authorization: `Bearer ${studentA1Token}` },
      });

      assert.equal(res.status, 403);
    });

    test("2.7 Cross-tenant admin (Uni B) cannot approve Uni A ticket payment (HTTP 403/404)", async () => {
      const res = await apiRequest(`/api/payments/${testPaidTicketPaymentId}/approve`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminBToken}` },
      });

      assert.ok([403, 404].includes(res.status));
    });

    test("2.8 Authorized CampusHub admin approves ticket payment -> ticket activates with valid QR token", async () => {
      const res = await apiRequest(`/api/payments/${testPaidTicketPaymentId}/approve`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminAToken}` },
      });

      assert.equal(res.status, 200);

      // Verify ticket is now active and has signed QR token
      const { rows: tRows } = await db.query("SELECT * FROM tickets WHERE id = $1", [testPaidTicketId]);
      assert.equal(tRows[0].status, "active");
      assert.ok(tRows[0].qr_token_hash, "Ticket must have qr_token_hash set");

      assert.equal(isValidSignature(tRows[0].id, tRows[0].qr_token_hash), true);
    });

    test("2.9 Retains 2.5% platform commission and attributes 97.5% net payable to the organizer", async () => {
      const { rows: cRows } = await db.query(
        "SELECT * FROM commissions WHERE transaction_type = 'ticket' AND transaction_id = $1",
        [testPaidTicketId]
      );

      assert.equal(cRows.length, 1);
      // Organizer A is the lead of Club A
      assert.equal(cRows[0].payee_id, organizerAUser.id);
      assert.equal(Number(cRows[0].rate), 0.025);
      // 2.5% on 100.00 = 2.50 birr platform commission
      assert.equal(Number(cRows[0].commission_amount), 2.50);
      assert.equal(Number(cRows[0].gross_amount), 100.00);
    });

    test("2.10 Admin retrieves organizer payout dashboard showing net balance owed", async () => {
      const res = await apiRequest("/api/admin/payouts/organizers", {
        headers: { Authorization: `Bearer ${adminAToken}` },
      });

      assert.equal(res.status, 200);
      const orgRecord = res.data.organizers.find((o) => o.organizer_id === organizerAUser.id);
      assert.ok(orgRecord);
      assert.equal(Number(orgRecord.total_sales), 100.00);
      assert.equal(Number(orgRecord.platform_commission), 2.50);
      assert.equal(Number(orgRecord.net_payable), 97.50);
      assert.equal(Number(orgRecord.paid_out), 0.00);
      assert.equal(Number(orgRecord.current_balance), 97.50);
    });

    test("2.11 Admin records organizer payout transfer -> balance updates and payout is logged", async () => {
      const res = await apiRequest(`/api/admin/payouts/organizers/${organizerAUser.id}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminAToken}` },
        body: {
          amount: 97.50,
          referenceNumber: "CBE-OUT-445566",
          notes: "Payout for Tech Fest tickets",
        },
      });

      assert.equal(res.status, 201);
      assert.equal(Number(res.data.payout.amount), 97.50);

      // Verify updated balance
      const checkRes = await apiRequest("/api/admin/payouts/organizers", {
        headers: { Authorization: `Bearer ${adminAToken}` },
      });
      const updated = checkRes.data.organizers.find((o) => o.organizer_id === organizerAUser.id);
      assert.equal(Number(updated.paid_out), 97.50);
      assert.equal(Number(updated.current_balance), 0.00);
    });
  });

  // =========================================================================
  // Part 3: Rentals (Bookings) & 0% Commission
  // =========================================================================
  describe("Part 3: Rentals (Bookings) & 0% Commission", () => {
    test("3.1 Rental booking creates manual payment directed to owner directly (0% commission)", async () => {
      const startDate = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const endDate = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);

      const res = await apiRequest(`/api/rentals/${rentalItemA.id}/bookings`, {
        method: "POST",
        headers: { Authorization: `Bearer ${studentA1Token}` },
        body: {
          startDate,
          endDate,
          paymentMethod: "manual",
        },
      });

      assert.equal(res.status, 201);
      assert.ok(res.data.booking);
      assert.ok(res.data.payment);
      testBookingId = res.data.booking.id;
      testBookingPaymentId = res.data.payment.paymentId;

      assert.equal(res.data.booking.status, "pending_payment");
      // Verify payment destination is Lender A directly
      const { rows: pRows } = await db.query("SELECT * FROM payments WHERE id = $1", [testBookingPaymentId]);
      assert.equal(pRows[0].payee_id, lenderAUser.id);
    });

    test("3.2 Student submits payment proof, owner confirms payment receipt -> records owner_confirmed_at", async () => {
      // Payer uploads proof
      const pngBuf = await makeUniquePngBuffer();
      const fd = new FormData();
      fd.append("screenshot", new Blob([pngBuf], { type: "image/png" }), "rental_proof.png");
      fd.append("referenceNumber", `RENT-PROOF-${Date.now()}-1`);

      const proofRes = await apiRequest(`/api/payments/${testBookingPaymentId}/proof`, {
        method: "POST",
        headers: { Authorization: `Bearer ${studentA1Token}` },
        body: fd,
      });
      assert.equal(proofRes.status, 201);
      assert.equal(proofRes.data.payment.status, "under_review");

      // Owner approves payment
      const approveRes = await apiRequest(`/api/payments/${testBookingPaymentId}/approve`, {
        method: "POST",
        headers: { Authorization: `Bearer ${lenderAToken}` },
      });
      assert.equal(approveRes.status, 200);

      const { rows: bRows } = await db.query("SELECT * FROM rental_bookings WHERE id = $1", [testBookingId]);
      assert.equal(bRows[0].status, "confirmed_awaiting_pickup");
      assert.ok(bRows[0].owner_confirmed_at, "owner_confirmed_at must be populated");
      assert.equal(bRows[0].renter_confirmed_at, null);
    });

    test("3.3 Rental records 0% platform commission", async () => {
      // Rental transactions have 0% commission rate configured
      const rate = commissions.rateFor("booking", 0.05);
      assert.equal(rate, 0.00);

      // Verify no commission was charged or owed in the platform ledger
      const { rows: cRows } = await db.query(
        "SELECT * FROM commissions WHERE transaction_type = 'booking' AND transaction_id = $1",
        [testBookingId]
      );
      assert.equal(cRows.length, 0);

      // Verify no commission transaction was charged
      const { rows: tRows } = await db.query(
        "SELECT * FROM transactions WHERE payment_id = $1 AND type = 'commission'",
        [testBookingPaymentId]
      );
      assert.equal(tRows.length, 0);
    });

    test("3.4 Owner cannot confirm pickup on behalf of renter (HTTP 403)", async () => {
      const res = await apiRequest(`/api/rentals/bookings/${testBookingId}/pickup`, {
        method: "POST",
        headers: { Authorization: `Bearer ${lenderAToken}` },
      });

      assert.equal(res.status, 403);
      assert.match(res.data.error.message, /only the renter can confirm/i);
    });

    test("3.5 Renter confirms item pickup -> records renter_confirmed_at, booking moves to 'active'", async () => {
      const res = await apiRequest(`/api/rentals/bookings/${testBookingId}/pickup`, {
        method: "POST",
        headers: { Authorization: `Bearer ${studentA1Token}` },
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.booking.status, "active");

      const { rows: bRows } = await db.query("SELECT * FROM rental_bookings WHERE id = $1", [testBookingId]);
      assert.ok(bRows[0].renter_confirmed_at, "renter_confirmed_at must be populated");
    });

    test("3.6 Owner confirms item return -> booking completes", async () => {
      const res = await apiRequest(`/api/rentals/bookings/${testBookingId}/return`, {
        method: "POST",
        headers: { Authorization: `Bearer ${lenderAToken}` },
        body: { condition: "good" },
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.booking.status, "completed");
    });
  });

  // =========================================================================
  // Part 4: Multi-Tenant Isolation & Admin Boundaries
  // =========================================================================
  describe("Part 4: Multi-Tenant Isolation & Boundaries", () => {
    test("4.1 Campus Admin B cannot see Uni A pending event tickets in review queue", async () => {
      const res = await apiRequest("/api/admin/events/tickets/pending", {
        headers: { Authorization: `Bearer ${adminBToken}` },
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.tickets.length, 0);
    });

    test("4.2 Campus Admin B cannot see or verify Uni A merchant commission payments", async () => {
      const res = await apiRequest("/api/commissions/admin/payments", {
        headers: { Authorization: `Bearer ${adminBToken}` },
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.payments.length, 0);
    });
  });

  // =========================================================================
  // Part 5: Financial Integrity & Edge Cases (FIN-01 to FIN-05)
  // =========================================================================
  describe("Part 5: Financial Integrity & Edge Cases", () => {
    test("5.1 (FIN-01) Paid ticket checkout at university without official receiving account fails safely (NO_CAMPUSHUB_RECEIVING_ACCOUNT)", async () => {
      const res = await apiRequest(`/api/events/${eventB.id}/tickets`, {
        method: "POST",
        headers: { Authorization: `Bearer ${studentBToken}` },
        body: { ticketTypeId: ticketTypeBPaid.id, quantity: 1 },
      });

      assert.equal(res.status, 400);
      assert.equal(res.data.error.code, "NO_CAMPUSHUB_RECEIVING_ACCOUNT");
      assert.match(res.data.error.message, /not configured an official receiving account/i);

      // Verify hold was cancelled, quantity_sold returned to 0, and no payment was created
      const { rows: tRows } = await db.query(
        "SELECT * FROM tickets WHERE ticket_type_id = $1",
        [ticketTypeBPaid.id]
      );
      assert.equal(tRows.length, 1);
      assert.equal(tRows[0].status, "cancelled");

      const { rows: ttRows } = await db.query(
        "SELECT quantity_sold FROM ticket_types WHERE id = $1",
        [ticketTypeBPaid.id]
      );
      assert.equal(ttRows[0].quantity_sold, 0);

      const { rows: pRows } = await db.query(
        "SELECT * FROM payments WHERE transaction_id = $1",
        [tRows[0].id]
      );
      assert.equal(pRows.length, 0);
    });

    test("5.2 (FIN-01) Free ticket checkout at university without official receiving account succeeds immediately", async () => {
      const res = await apiRequest(`/api/events/${eventB.id}/tickets`, {
        method: "POST",
        headers: { Authorization: `Bearer ${studentBToken}` },
        body: { ticketTypeId: ticketTypeBFree.id, quantity: 1 },
      });

      assert.equal(res.status, 201);
      assert.ok(res.data.ticket);
      assert.equal(res.data.ticket.status, "active");
      assert.equal(res.data.payment, null);
      assert.ok(isValidSignature(res.data.ticket.id, res.data.ticket.qr_token_hash));
    });

    test("5.3 (FIN-03) Duplicate commission payment reference is rejected with DUPLICATE_REFERENCE (HTTP 409)", async () => {
      const { rows: existingComm } = await db.query(
        "SELECT reference_number FROM commission_payments WHERE merchant_id = $1 ORDER BY created_at ASC LIMIT 1",
        [merchantAUser.id]
      );
      assert.ok(existingComm.length > 0);
      const existingRef = existingComm[0].reference_number;

      const pngBuf = await makeUniquePngBuffer();
      const fd = new FormData();
      fd.append("screenshot", new Blob([pngBuf], { type: "image/png" }), "duplicate_proof.png");
      fd.append("amount", "20.00");
      fd.append("referenceNumber", `   ${existingRef.toLowerCase()}   `); // Whitespace + case variation
      fd.append("notes", "Duplicate commission payment attempt");

      const res = await apiRequest("/api/commissions/submit-payment", {
        method: "POST",
        headers: { Authorization: `Bearer ${merchantAToken}` },
        body: fd,
      });

      assert.equal(res.status, 409);
      assert.equal(res.data.error.code, "DUPLICATE_REFERENCE");
      assert.match(res.data.error.message, /already been submitted/i);
    });

    let commEntry1, commEntry2;
    let fin02PaymentId;

    test("5.4 (FIN-02) Commission verification fails if verified amount is less than oldest due commission row (HTTP 400 INSUFFICIENT_PAYMENT_AMOUNT)", async () => {
      const now = Date.now();
      // Insert underlying confirmed payments first to satisfy foreign key
      const { rows: p1 } = await db.query(
        `INSERT INTO payments (university_id, transaction_type, transaction_id, amount, currency, status, payee_id, provider)
         VALUES ($1, 'order', $2, 1000.00, 'ETB', 'confirmed', $3, 'manual') RETURNING *`,
        [uniA.id, crypto.randomUUID(), merchantAUser.id]
      );
      const { rows: p2 } = await db.query(
        `INSERT INTO payments (university_id, transaction_type, transaction_id, amount, currency, status, payee_id, provider)
         VALUES ($1, 'order', $2, 600.00, 'ETB', 'confirmed', $3, 'manual') RETURNING *`,
        [uniA.id, crypto.randomUUID(), merchantAUser.id]
      );

      // Insert two due commissions for merchant A: 50.00 (older) and 30.00 (newer)
      const { rows: c1 } = await db.query(
        `INSERT INTO commissions (university_id, payment_id, transaction_type, transaction_id, payee_id, gross_amount, base_amount, rate, commission_amount, status, created_at)
         VALUES ($1, $2, 'order', $3, $4, 1000.00, 1000.00, 0.05, 50.00, 'due', now() - interval '2 hours') RETURNING *`,
        [uniA.id, p1[0].id, p1[0].transaction_id, merchantAUser.id]
      );
      commEntry1 = c1[0];

      const { rows: c2 } = await db.query(
        `INSERT INTO commissions (university_id, payment_id, transaction_type, transaction_id, payee_id, gross_amount, base_amount, rate, commission_amount, status, created_at)
         VALUES ($1, $2, 'order', $3, $4, 600.00, 600.00, 0.05, 30.00, 'due', now() - interval '1 hour') RETURNING *`,
        [uniA.id, p2[0].id, p2[0].transaction_id, merchantAUser.id]
      );
      commEntry2 = c2[0];

      // Merchant submits payment for 50.00
      const pngBuf = await makeUniquePngBuffer();
      const fd = new FormData();
      fd.append("screenshot", new Blob([pngBuf], { type: "image/png" }), "fin02_proof.png");
      fd.append("amount", "50.00");
      fd.append("referenceNumber", `COMM-REF-FIN02-${now}-A`);

      const subRes = await apiRequest("/api/commissions/submit-payment", {
        method: "POST",
        headers: { Authorization: `Bearer ${merchantAToken}` },
        body: fd,
      });
      assert.equal(subRes.status, 201);
      fin02PaymentId = subRes.data.payment.id;

      // Admin attempts to verify with 25.00 (which is less than oldest due amount 50.00)
      const res = await apiRequest(`/api/commissions/admin/payments/${fin02PaymentId}/verify`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminAToken}` },
        body: { verifiedAmount: 25.00 },
      });
      assert.equal(res.status, 400);
      assert.equal(res.data.error.code, "INSUFFICIENT_PAYMENT_AMOUNT");
      assert.match(res.data.error.message, /insufficient to cover the oldest outstanding/i);

      // Verify payment remains in 'submitted' status
      const { rows: checkCp } = await db.query("SELECT status FROM commission_payments WHERE id = $1", [fin02PaymentId]);
      assert.equal(checkCp[0].status, "submitted");
    });

    test("5.5 (FIN-02) Commission verification fails if verified amount exceeds merchant's total outstanding balance (HTTP 400 VERIFIED_AMOUNT_EXCEEDS_BALANCE)", async () => {
      // Total outstanding is 50.00 + 30.00 = 80.00
      const now = Date.now();
      const pngBuf = await makeUniquePngBuffer();
      const fd = new FormData();
      fd.append("screenshot", new Blob([pngBuf], { type: "image/png" }), "fin02_proof_b.png");
      fd.append("amount", "100.00");
      fd.append("referenceNumber", `COMM-REF-FIN02-${now}-B`);

      const subRes = await apiRequest("/api/commissions/submit-payment", {
        method: "POST",
        headers: { Authorization: `Bearer ${merchantAToken}` },
        body: fd,
      });
      assert.equal(subRes.status, 201);
      const paymentBId = subRes.data.payment.id;

      // Admin attempts to verify with 90.00 (exceeds total balance 80.00)
      const res = await apiRequest(`/api/commissions/admin/payments/${paymentBId}/verify`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminAToken}` },
        body: { verifiedAmount: 90.00 },
      });
      assert.equal(res.status, 400);
      assert.equal(res.data.error.code, "VERIFIED_AMOUNT_EXCEEDS_BALANCE");
    });

    test("5.6 (FIN-02) Commission verification fails if verified amount exceeds submitted amount (HTTP 400 VERIFIED_AMOUNT_EXCEEDS_SUBMITTED)", async () => {
      // fin02PaymentId submitted amount was 50.00. Admin tries to verify 60.00
      const res = await apiRequest(`/api/commissions/admin/payments/${fin02PaymentId}/verify`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminAToken}` },
        body: { verifiedAmount: 60.00 },
      });
      assert.equal(res.status, 400);
      assert.equal(res.data.error.code, "VERIFIED_AMOUNT_EXCEEDS_SUBMITTED");
    });

    test("5.7 (FIN-02) Commission verification with valid amount settles oldest whole entries and records verified_amount", async () => {
      // Admin verifies fin02PaymentId with verifiedAmount: 50.00
      const res = await apiRequest(`/api/commissions/admin/payments/${fin02PaymentId}/verify`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminAToken}` },
        body: { verifiedAmount: 50.00, notes: "Verified 50 ETB in statement" },
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.payment.status, "verified");
      assert.equal(Number(res.data.payment.verified_amount), 50.00);
      assert.equal(res.data.payment.settledCount, 1);

      // Verify oldest commission (50.00) is settled, and second commission (30.00) remains due
      const { rows: r1 } = await db.query("SELECT status FROM commissions WHERE id = $1", [commEntry1.id]);
      assert.equal(r1[0].status, "settled");

      const { rows: r2 } = await db.query("SELECT status FROM commissions WHERE id = $1", [commEntry2.id]);
      assert.equal(r2[0].status, "due");
    });

    test("5.8 (FIN-04) Organizer payout fails when amount exceeds current balance (HTTP 400 EXCESSIVE_PAYOUT)", async () => {
      // Check current organizer balance (it should currently be 0 after Part 2)
      const balRes = await apiRequest("/api/admin/payouts/organizers", {
        headers: { Authorization: `Bearer ${adminAToken}` },
      });
      const orgAData = balRes.data.organizers.find((o) => o.organizer_id === organizerAUser.id);
      assert.equal(Number(orgAData.current_balance), 0.00);

      // Attempting to payout when balance is 0 fails with NO_OUTSTANDING_BALANCE
      const zeroRes = await apiRequest(`/api/admin/payouts/organizers/${organizerAUser.id}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminAToken}` },
        body: { amount: 50.00, referenceNumber: `PAYOUT-ZERO-${Date.now()}` },
      });
      assert.equal(zeroRes.status, 409);
      assert.equal(zeroRes.data.error.code, "NO_OUTSTANDING_BALANCE");

      // Student A2 buys another paid ticket for 100 ETB
      const buyRes = await apiRequest(`/api/events/${eventA.id}/tickets`, {
        method: "POST",
        headers: { Authorization: `Bearer ${studentA2Token}` },
        body: { ticketTypeId: ticketTypePaid.id, quantity: 1 },
      });
      assert.equal(buyRes.status, 201);
      const ticketPaymentId = buyRes.data.payment.paymentId;

      // Student submits payment proof
      const pngBuf = await makeUniquePngBuffer();
      const fd = new FormData();
      fd.append("screenshot", new Blob([pngBuf], { type: "image/png" }), "ticket2.png");
      fd.append("referenceNumber", `TICKET-REF-${Date.now()}`);
      const proofRes = await apiRequest(`/api/payments/${ticketPaymentId}/proof`, {
        method: "POST",
        headers: { Authorization: `Bearer ${studentA2Token}` },
        body: fd,
      });
      assert.equal(proofRes.status, 201);

      // Admin approves the ticket payment -> attributes 97.50 to Organizer A
      const appRes = await apiRequest(`/api/payments/${ticketPaymentId}/approve`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminAToken}` },
      });
      assert.equal(appRes.status, 200);

      // Admin tries to record excessive payout of 150.00 (exceeding 97.50 balance)
      const excRes = await apiRequest(`/api/admin/payouts/organizers/${organizerAUser.id}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminAToken}` },
        body: { amount: 150.00, referenceNumber: `PAYOUT-EXCESS-${Date.now()}` },
      });
      assert.equal(excRes.status, 400);
      assert.equal(excRes.data.error.code, "EXCESSIVE_PAYOUT");
      assert.match(excRes.data.error.message, /exceeds outstanding balance/i);
    });

    test("5.9 (FIN-05) Duplicate organizer transfer reference is rejected with DUPLICATE_TRANSFER_REFERENCE (HTTP 409)", async () => {
      // In 2.11, payout was recorded with reference 'CBE-OUT-445566'
      const dupRes = await apiRequest(`/api/admin/payouts/organizers/${organizerAUser.id}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminAToken}` },
        body: {
          amount: 50.00,
          referenceNumber: "   cbe-out-445566   ", // Whitespace + case variation
        },
      });
      assert.equal(dupRes.status, 409);
      assert.equal(dupRes.data.error.code, "DUPLICATE_TRANSFER_REFERENCE");
      assert.match(dupRes.data.error.message, /already been recorded/i);
    });

    test("5.10 (FIN-04/FIN-05) Valid payout clears balance; subsequent payout fails with NO_OUTSTANDING_BALANCE", async () => {
      // Admin pays the exact remaining balance of 97.50 with a valid fresh reference
      const payRes = await apiRequest(`/api/admin/payouts/organizers/${organizerAUser.id}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminAToken}` },
        body: {
          amount: 97.50,
          referenceNumber: `CBE-PAYOUT-VALID-${Date.now()}`,
          notes: "Full remaining payout",
        },
      });
      assert.equal(payRes.status, 201);
      assert.equal(payRes.data.remainingBalance, 0);

      // Attempting another payout now fails with NO_OUTSTANDING_BALANCE
      const afterRes = await apiRequest(`/api/admin/payouts/organizers/${organizerAUser.id}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminAToken}` },
        body: {
          amount: 10.00,
          referenceNumber: `CBE-PAYOUT-AFTER-${Date.now()}`,
        },
      });
      assert.equal(afterRes.status, 409);
      assert.equal(afterRes.data.error.code, "NO_OUTSTANDING_BALANCE");
    });
  });

  describe("Part 6: Financial Integrity Edge Cases & Regression Tests (MED-01, MED-02, LOW-01, LOW-02, LOW-03)", () => {
    test("6.1 (MED-01) Cancelled event tickets with pending or completed refunds are excluded from organizer payouts", async () => {
      // 1. Create a published event specifically to test cancellation
      const futDate = new Date(Date.now() + 10 * 86400000).toISOString();
      const { rows: evRows } = await db.query(
        `INSERT INTO events (university_id, club_id, title, description, date_time, location, capacity, status)
         VALUES ($1, $2, 'Event To Be Cancelled', 'Will be cancelled', $3, 'Hall C', 50, 'published')
         RETURNING *`,
        [uniA.id, clubA.id, futDate]
      );
      const cancEvent = evRows[0];

      const { rows: ttRows } = await db.query(
        `INSERT INTO ticket_types (university_id, event_id, name, price, quantity_total, quantity_sold)
         VALUES ($1, $2, 'Pass for Cancelled Event', 100.00, 50, 0)
         RETURNING *`,
        [uniA.id, cancEvent.id]
      );
      const cancTicketType = ttRows[0];

      // Student A1 buys a ticket for this event
      const buyRes = await apiRequest(`/api/events/${cancEvent.id}/tickets`, {
        method: "POST",
        headers: { Authorization: `Bearer ${studentA1Token}` },
        body: { ticketTypeId: cancTicketType.id, quantity: 1 },
      });
      assert.equal(buyRes.status, 201);
      const cancPaymentId = buyRes.data.payment.paymentId;

      // Student uploads payment proof
      const pngBuf = await makeUniquePngBuffer();
      const fd = new FormData();
      fd.append("screenshot", new Blob([pngBuf], { type: "image/png" }), "canc_proof.png");
      fd.append("referenceNumber", `CANC-REF-${Date.now()}`);
      const proofRes = await apiRequest(`/api/payments/${cancPaymentId}/proof`, {
        method: "POST",
        headers: { Authorization: `Bearer ${studentA1Token}` },
        body: fd,
      });
      assert.equal(proofRes.status, 201);

      // Admin approves the ticket payment -> payment status = 'confirmed', ticket = 'active'
      const appRes = await apiRequest(`/api/payments/${cancPaymentId}/approve`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminAToken}` },
      });
      assert.equal(appRes.status, 200);

      // Verify Organizer A now shows 97.50 ETB net payable before cancellation
      const preBal = await apiRequest("/api/admin/payouts/organizers", {
        headers: { Authorization: `Bearer ${adminAToken}` },
      });
      const orgPre = preBal.data.organizers.find((o) => o.organizer_id === organizerAUser.id);
      assert.equal(Number(orgPre.current_balance), 97.50);

      // Organizer cancels the event via PATCH /api/events/:id
      const patchRes = await apiRequest(`/api/events/${cancEvent.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${organizerAToken}` },
        body: { status: "cancelled" },
      });
      assert.equal(patchRes.status, 200);
      assert.equal(patchRes.data.event.status, "cancelled");

      // Verify the ticket status was updated to 'cancelled' while payment is still 'confirmed' (refund pending)
      const { rows: tCheck } = await db.query("SELECT status FROM tickets WHERE event_id = $1", [cancEvent.id]);
      assert.equal(tCheck[0].status, "cancelled");
      const { rows: pCheck } = await db.query("SELECT status FROM payments WHERE id = $1", [cancPaymentId]);
      assert.equal(pCheck[0].status, "confirmed");

      // MED-01: Admin checks payouts - Organizer A current balance MUST be 0.00 (not 97.50)
      const postBal = await apiRequest("/api/admin/payouts/organizers", {
        headers: { Authorization: `Bearer ${adminAToken}` },
      });
      const orgPost = postBal.data.organizers.find((o) => o.organizer_id === organizerAUser.id);
      assert.equal(Number(orgPost?.current_balance || 0), 0.00);

      // Payout attempt fails with NO_OUTSTANDING_BALANCE
      const payAttempt = await apiRequest(`/api/admin/payouts/organizers/${organizerAUser.id}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminAToken}` },
        body: { amount: 50.00, referenceNumber: `PAYOUT-CANC-${Date.now()}` },
      });
      assert.equal(payAttempt.status, 409);
      assert.equal(payAttempt.data.error.code, "NO_OUTSTANDING_BALANCE");

      // Admin executes refund on student's payment -> payment status = 'refunded'
      const refRes = await apiRequest(`/api/payments/${cancPaymentId}/refund`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminAToken}` },
        body: { reason: "Cancelled event ticket refund" },
      });
      assert.equal(refRes.status, 200);
      assert.equal(refRes.data.payment.status, "refunded");

      // Organizer balance remains 0.00 after refund
      const afterRefundBal = await apiRequest("/api/admin/payouts/organizers", {
        headers: { Authorization: `Bearer ${adminAToken}` },
      });
      const orgAfterRefund = afterRefundBal.data.organizers.find((o) => o.organizer_id === organizerAUser.id);
      assert.equal(Number(orgAfterRefund?.current_balance || 0), 0.00);

      // Unaffected valid ticket on a published event (eventA) is properly credited
      const buyValid = await apiRequest(`/api/events/${eventA.id}/tickets`, {
        method: "POST",
        headers: { Authorization: `Bearer ${studentA2Token}` },
        body: { ticketTypeId: ticketTypePaid.id, quantity: 1 },
      });
      assert.equal(buyValid.status, 201);
      const validPaymentId = buyValid.data.payment.paymentId;

      const pngBuf2 = await makeUniquePngBuffer();
      const fd2 = new FormData();
      fd2.append("screenshot", new Blob([pngBuf2], { type: "image/png" }), "valid_proof.png");
      fd2.append("referenceNumber", `VALID-REF-${Date.now()}`);
      await apiRequest(`/api/payments/${validPaymentId}/proof`, {
        method: "POST",
        headers: { Authorization: `Bearer ${studentA2Token}` },
        body: fd2,
      });

      await apiRequest(`/api/payments/${validPaymentId}/approve`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminAToken}` },
      });

      // Organizer A now has exactly 97.50 ETB from the valid event
      const finalBal = await apiRequest("/api/admin/payouts/organizers", {
        headers: { Authorization: `Bearer ${adminAToken}` },
      });
      const orgFinal = finalBal.data.organizers.find((o) => o.organizer_id === organizerAUser.id);
      assert.equal(Number(orgFinal.current_balance), 97.50);
    });

    test("6.2 (MED-02) Super-admin payout resolves authoritative university_id and prevents NULL in organizer_payouts", async () => {
      // Super admin executes payout for Organizer A without specifying X-University-Id
      const refNum = `SUPER-PAYOUT-${Date.now()}`;
      const superPayRes = await apiRequest(`/api/admin/payouts/organizers/${organizerAUser.id}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${superAdminToken}` },
        body: {
          amount: 97.50,
          referenceNumber: refNum,
          notes: "Super admin direct university payout",
        },
      });
      assert.equal(superPayRes.status, 201);
      assert.equal(superPayRes.data.remainingBalance, 0);

      // Verify organizer_payouts row has non-null university_id matching organizer's university
      const { rows: payRows } = await db.query(
        "SELECT * FROM organizer_payouts WHERE reference_number = $1",
        [refNum]
      );
      assert.equal(payRows.length, 1);
      assert.ok(payRows[0].university_id != null, "university_id must not be null");
      assert.equal(payRows[0].university_id, uniA.id);
      assert.equal(payRows[0].organizer_id, organizerAUser.id);
      assert.equal(Number(payRows[0].amount), 97.50);
    });

    test("6.3 (LOW-01) Platform commission and organizer payable strictly conserve funds with zero rounding drift", async () => {
      // Create ticket types for 1.00, 3.00, 5.00, 100.00, and 999.99 ETB
      const { rows: t1 } = await db.query(
        `INSERT INTO ticket_types (university_id, event_id, name, price, quantity_total, quantity_sold)
         VALUES ($1, $2, 'Pass 1.00 ETB', 1.00, 10, 0) RETURNING *`,
        [uniA.id, eventA.id]
      );
      const { rows: t3 } = await db.query(
        `INSERT INTO ticket_types (university_id, event_id, name, price, quantity_total, quantity_sold)
         VALUES ($1, $2, 'Pass 3.00 ETB', 3.00, 10, 0) RETURNING *`,
        [uniA.id, eventA.id]
      );
      const { rows: t5 } = await db.query(
        `INSERT INTO ticket_types (university_id, event_id, name, price, quantity_total, quantity_sold)
         VALUES ($1, $2, 'Pass 5.00 ETB', 5.00, 10, 0) RETURNING *`,
        [uniA.id, eventA.id]
      );
      const { rows: t100 } = await db.query(
        `INSERT INTO ticket_types (university_id, event_id, name, price, quantity_total, quantity_sold)
         VALUES ($1, $2, 'Pass 100.00 ETB', 100.00, 10, 0) RETURNING *`,
        [uniA.id, eventA.id]
      );
      const { rows: t999 } = await db.query(
        `INSERT INTO ticket_types (university_id, event_id, name, price, quantity_total, quantity_sold)
         VALUES ($1, $2, 'Pass 999.99 ETB', 999.99, 10, 0) RETURNING *`,
        [uniA.id, eventA.id]
      );

      // Student A1 buys each ticket and uploads proof
      for (const [tt, expectedCommission, expectedPayable] of [
        [t1[0], 0.03, 0.97],
        [t3[0], 0.08, 2.92],
        [t5[0], 0.13, 4.87],
        [t100[0], 2.50, 97.50],
        [t999[0], 25.00, 974.99],
      ]) {
        const buyRes = await apiRequest(`/api/events/${eventA.id}/tickets`, {
          method: "POST",
          headers: { Authorization: `Bearer ${studentA1Token}` },
          body: { ticketTypeId: tt.id, quantity: 1 },
        });
        assert.equal(buyRes.status, 201);
        const pId = buyRes.data.payment.paymentId;

        const png = await makeUniquePngBuffer();
        const fd = new FormData();
        fd.append("screenshot", new Blob([png], { type: "image/png" }), `odd_${tt.price}.png`);
        fd.append("referenceNumber", `ODD-REF-${tt.price}-${Date.now()}`);
        await apiRequest(`/api/payments/${pId}/proof`, {
          method: "POST",
          headers: { Authorization: `Bearer ${studentA1Token}` },
          body: fd,
        });

        // Check pending view calculation before approval
        const pendRes = await apiRequest("/api/admin/events/tickets/pending", {
          headers: { Authorization: `Bearer ${adminAToken}` },
        });
        const pendItem = pendRes.data.pendingPayments.find((p) => p.payment_id === pId);
        assert.ok(pendItem, "Pending payment must appear in queue");
        assert.equal(Number(pendItem.commission_amount), expectedCommission);
        assert.equal(Number(pendItem.organizer_payable), expectedPayable);
        assert.ok(Number(pendItem.commission_amount) >= 0, "Commission cannot be negative");
        assert.ok(Number(pendItem.organizer_payable) >= 0, "Organizer payable cannot be negative");
        assert.equal(
          Math.round((Number(pendItem.commission_amount) + Number(pendItem.organizer_payable)) * 100) / 100,
          Number(tt.price)
        );

        // Approve payment
        await apiRequest(`/api/payments/${pId}/approve`, {
          method: "POST",
          headers: { Authorization: `Bearer ${adminAToken}` },
        });
      }

      // Check organizer owed totals in GET /api/admin/payouts/organizers
      // Total ticket price: 1.00 + 3.00 + 5.00 + 100.00 + 999.99 = 1108.99 ETB
      // Total commission: 0.03 + 0.08 + 0.13 + 2.50 + 25.00 = 27.74 ETB
      // Total organizer payable: 0.97 + 2.92 + 4.87 + 97.50 + 974.99 = 1081.25 ETB
      // 27.74 + 1081.25 = 1108.99 ETB exactly!
      const balRes = await apiRequest("/api/admin/payouts/organizers", {
        headers: { Authorization: `Bearer ${adminAToken}` },
      });
      const orgData = balRes.data.organizers.find((o) => o.organizer_id === organizerAUser.id);
      assert.equal(Number(orgData.current_balance), 1081.25);

      // Settle the exact remaining 1081.25 ETB with zero residual
      const clearRes = await apiRequest(`/api/admin/payouts/organizers/${organizerAUser.id}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminAToken}` },
        body: { amount: 1081.25, referenceNumber: `ODD-PAYOUT-${Date.now()}` },
      });
      assert.equal(clearRes.status, 201);
      assert.equal(clearRes.data.remainingBalance, 0);
    });

    test("6.4 (LOW-02) Commission verification rejects unallocated payment surplus with UNALLOCATED_SURPLUS (HTTP 400)", async () => {
      // First insert dummy payment so commissions FK is satisfied
      const { rows: payRows } = await db.query(
        `INSERT INTO payments (university_id, payer_id, amount, currency, status, provider, transaction_type, transaction_id)
         VALUES ($1, $2, 1000.00, 'ETB', 'confirmed', 'manual_telebirr', 'order', $3)
         RETURNING id`,
        [uniA.id, studentA1User.id, crypto.randomUUID()]
      );
      const dummyPaymentId = payRows[0].id;

      // Insert a commission entry for Merchant A of 50.00 ETB (in addition to prior commEntry2 of 30.00 ETB)
      const { rows: commRows } = await db.query(
        `INSERT INTO commissions (university_id, payment_id, payee_id, payee_role, transaction_type, transaction_id, gross_amount, base_amount, rate, commission_amount, status, description)
         VALUES ($1, $2, $3, 'merchant', 'order', $4, 1000.00, 1000.00, 0.05, 50.00, 'due', 'LOW-02 test entry')
         RETURNING *`,
        [uniA.id, dummyPaymentId, merchantAUser.id, crypto.randomUUID()]
      );
      const low02Comm = commRows[0];

      // Merchant submits payment proof for 65.00 ETB
      // (Oldest entry is 30.00 ETB; remaining 35.00 ETB leaves an unallocated surplus against second entry 50.00 ETB)
      const pngBuf = await makeUniquePngBuffer();
      const fd = new FormData();
      fd.append("screenshot", new Blob([pngBuf], { type: "image/png" }), "surplus.png");
      fd.append("amount", "65.00");
      fd.append("referenceNumber", `SURPLUS-REF-${Date.now()}`);

      const subRes = await apiRequest("/api/commissions/submit-payment", {
        method: "POST",
        headers: { Authorization: `Bearer ${merchantAToken}` },
        body: fd,
      });
      assert.equal(subRes.status, 201);
      const paymentId = subRes.data.payment.id;

      // Admin attempts to verify with 65.00 ETB -> rejected with UNALLOCATED_SURPLUS
      const verRes = await apiRequest(`/api/commissions/admin/payments/${paymentId}/verify`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminAToken}` },
        body: { verifiedAmount: 65.00 },
      });
      assert.equal(verRes.status, 400);
      assert.equal(verRes.data.error.code, "UNALLOCATED_SURPLUS");
      assert.match(verRes.data.error.message, /leaves an unallocated surplus/i);

      // Verify commission row remains due and payment remains submitted
      const { rows: cCheck } = await db.query("SELECT status FROM commissions WHERE id = $1", [low02Comm.id]);
      assert.equal(cCheck[0].status, "due");
      const { rows: pCheck } = await db.query("SELECT status FROM commission_payments WHERE id = $1", [paymentId]);
      assert.equal(pCheck[0].status, "submitted");
    });

    test("6.5 (LOW-03) Legacy admin commission settlement routes are atomic, auditable, and row-locked", async () => {
      // Merchant A currently has outstanding due commission entries (commEntry2 of 30.00 + low02Comm of 50.00 = 80.00 ETB)
      // Admin calls legacy settlement route POST /api/commissions/admin/sellers/:userId/settle
      const setRes = await apiRequest(`/api/commissions/admin/sellers/${merchantAUser.id}/settle`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminAToken}` },
        body: { note: "Administrative direct cash settlement" },
      });
      assert.equal(setRes.status, 200);
      assert.equal(setRes.data.settled, 2);
      assert.equal(Number(setRes.data.total), 80.00);
      assert.ok(setRes.data.referenceNumber.startsWith("MANUAL-SETTLE-"));

      // Verify auditable commission_payments row was created
      const { rows: cpRows } = await db.query(
        "SELECT * FROM commission_payments WHERE reference_number = $1",
        [setRes.data.referenceNumber]
      );
      assert.equal(cpRows.length, 1);
      assert.equal(cpRows[0].status, "verified");
      assert.equal(Number(cpRows[0].amount), 80.00);
      assert.equal(Number(cpRows[0].verified_amount), 80.00);
      assert.equal(cpRows[0].reviewer_id, adminAUser.id);
      assert.equal(cpRows[0].university_id, uniA.id);

      // Verify all commission entries for Merchant A are now settled
      const { rows: cRows } = await db.query(
        "SELECT status FROM commissions WHERE payee_id = $1 AND status = 'due'",
        [merchantAUser.id]
      );
      assert.equal(cRows.length, 0);

      // Re-invoking settle immediately returns HTTP 409 NOTHING_DUE
      const againRes = await apiRequest(`/api/commissions/admin/sellers/${merchantAUser.id}/settle`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminAToken}` },
        body: { note: "Repeat settle" },
      });
      assert.equal(againRes.status, 409);
      assert.equal(againRes.data.error.code, "NOTHING_DUE");
    });

    test("6.6 (CONCURRENCY) Concurrent organizer payouts for same organizer resolve safely with row lock", async () => {
      // Create dedicated organizer with exactly 100.00 ETB available
      const orgConc = await makeUser(uniA.id, "Organizer Concurrency", "organizer.conc", "organizer");
      const organizerConcUser = orgConc.user;

      const { rows: clubRows } = await db.query(
        `INSERT INTO clubs (university_id, name, lead_user_id)
         VALUES ($1, 'Club Concurrency', $2) RETURNING *`,
        [uniA.id, organizerConcUser.id]
      );
      const clubConc = clubRows[0];

      const futDate = new Date(Date.now() + 14 * 86400000).toISOString();
      const { rows: evRows } = await db.query(
        `INSERT INTO events (university_id, club_id, title, description, date_time, location, capacity, status)
         VALUES ($1, $2, 'Concurrency Event', 'Concurrency test', $3, 'Hall Conc', 100, 'published')
         RETURNING *`,
        [uniA.id, clubConc.id, futDate]
      );
      const eventConc = evRows[0];

      // Ticket priced at 102.56 ETB -> commission: 2.56 ETB, net payable to organizer: 100.00 ETB exactly
      const { rows: ttRows } = await db.query(
        `INSERT INTO ticket_types (university_id, event_id, name, price, quantity_total, quantity_sold)
         VALUES ($1, $2, 'Concurrency Pass', 102.56, 50, 0) RETURNING *`,
        [uniA.id, eventConc.id]
      );
      const ticketTypeConc = ttRows[0];

      // Student buys ticket
      const buyRes = await apiRequest(`/api/events/${eventConc.id}/tickets`, {
        method: "POST",
        headers: { Authorization: `Bearer ${studentA1Token}` },
        body: { ticketTypeId: ticketTypeConc.id, quantity: 1 },
      });
      assert.equal(buyRes.status, 201);
      const paymentId = buyRes.data.payment.paymentId;

      // Student submits proof
      const pngBuf = await makeUniquePngBuffer();
      const fd = new FormData();
      fd.append("screenshot", new Blob([pngBuf], { type: "image/png" }), "conc_proof.png");
      fd.append("referenceNumber", `CONC-PROOF-${Date.now()}`);
      await apiRequest(`/api/payments/${paymentId}/proof`, {
        method: "POST",
        headers: { Authorization: `Bearer ${studentA1Token}` },
        body: fd,
      });

      // Admin approves
      await apiRequest(`/api/payments/${paymentId}/approve`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminAToken}` },
      });

      // Verify Organizer has exactly 100.00 ETB available
      const preRes = await apiRequest("/api/admin/payouts/organizers", {
        headers: { Authorization: `Bearer ${adminAToken}` },
      });
      const orgPre = preRes.data.organizers.find((o) => o.organizer_id === organizerConcUser.id);
      assert.equal(Number(orgPre.current_balance), 100.00);

      // Send two concurrent payout requests of 100.00 ETB simultaneously via Promise.all
      const [resA, resB] = await Promise.all([
        apiRequest(`/api/admin/payouts/organizers/${organizerConcUser.id}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${adminAToken}` },
          body: { amount: 100.00, referenceNumber: `CONC-PAY-A-${Date.now()}` },
        }),
        apiRequest(`/api/admin/payouts/organizers/${organizerConcUser.id}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${adminAToken}` },
          body: { amount: 100.00, referenceNumber: `CONC-PAY-B-${Date.now()}` },
        }),
      ]);

      // Exactly ONE request must succeed (HTTP 201) and the other must fail (HTTP 400 or 409)
      const statuses = [resA.status, resB.status];
      const successCount = statuses.filter((s) => s === 201).length;
      const failCount = statuses.filter((s) => s === 400 || s === 409).length;

      assert.equal(successCount, 1, "Exactly one payout request must succeed");
      assert.equal(failCount, 1, "The competing concurrent payout request must fail");

      // Verify database records: total completed payouts must equal exactly 100.00 ETB (NEVER 200.00 ETB)
      const { rows: completedPayouts } = await db.query(
        "SELECT * FROM organizer_payouts WHERE organizer_id = $1 AND status = 'completed'",
        [organizerConcUser.id]
      );
      assert.equal(completedPayouts.length, 1, "Must have exactly 1 completed payout record in DB");
      assert.equal(Number(completedPayouts[0].amount), 100.00);

      // Remaining balance must now be 0.00
      const postRes = await apiRequest("/api/admin/payouts/organizers", {
        headers: { Authorization: `Bearer ${adminAToken}` },
      });
      const orgPost = postRes.data.organizers.find((o) => o.organizer_id === organizerConcUser.id);
      assert.equal(Number(orgPost?.current_balance || 0), 0.00);
    });

    test("6.7 (REFUND-RECONCILIATION) Refund lifecycle enforces non-duplication and blocks payouts on cancelled tickets", async () => {
      // 1. Student A1 buys a ticket on published eventA
      const buyRes = await apiRequest(`/api/events/${eventA.id}/tickets`, {
        method: "POST",
        headers: { Authorization: `Bearer ${studentA1Token}` },
        body: { ticketTypeId: ticketTypePaid.id, quantity: 1 },
      });
      assert.equal(buyRes.status, 201);
      const paymentId = buyRes.data.payment.paymentId;
      const ticketId = buyRes.data.ticket.id;

      // Student uploads proof and admin approves
      const pngBuf = await makeUniquePngBuffer();
      const fd = new FormData();
      fd.append("screenshot", new Blob([pngBuf], { type: "image/png" }), "ref_proof.png");
      fd.append("referenceNumber", `REF-PROOF-${Date.now()}`);
      await apiRequest(`/api/payments/${paymentId}/proof`, {
        method: "POST",
        headers: { Authorization: `Bearer ${studentA1Token}` },
        body: fd,
      });

      await apiRequest(`/api/payments/${paymentId}/approve`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminAToken}` },
      });

      // Confirmed payment + active ticket contributes to organizer payable balance
      const balBefore = await apiRequest("/api/admin/payouts/organizers", {
        headers: { Authorization: `Bearer ${adminAToken}` },
      });
      const orgBefore = balBefore.data.organizers.find((o) => o.organizer_id === organizerAUser.id);
      assert.equal(Number(orgBefore.current_balance), 97.50);

      // Cancel ticket
      await db.query("UPDATE tickets SET status = 'cancelled' WHERE id = $1", [ticketId]);

      // Cancelled ticket does NOT contribute to organizer balance (drops to 0.00)
      const balAfterCancel = await apiRequest("/api/admin/payouts/organizers", {
        headers: { Authorization: `Bearer ${adminAToken}` },
      });
      const orgAfterCancel = balAfterCancel.data.organizers.find((o) => o.organizer_id === organizerAUser.id);
      assert.equal(Number(orgAfterCancel?.current_balance || 0), 0.00);

      // Organizer payout cannot occur against cancelled ticket revenue
      const payoutAttempt = await apiRequest(`/api/admin/payouts/organizers/${organizerAUser.id}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminAToken}` },
        body: { amount: 50.00, referenceNumber: `PAY-CANC-REV-${Date.now()}` },
      });
      assert.equal(payoutAttempt.status, 409);
      assert.equal(payoutAttempt.data.error.code, "NO_OUTSTANDING_BALANCE");

      // Process refund for the payment
      const refundRes1 = await apiRequest(`/api/payments/${paymentId}/refund`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminAToken}` },
        body: { reason: "Customer ticket cancellation" },
      });
      assert.equal(refundRes1.status, 200);
      assert.equal(refundRes1.data.payment.status, "refunded");

      // Refunded payment does NOT contribute to organizer payable balance
      const balAfterRefund = await apiRequest("/api/admin/payouts/organizers", {
        headers: { Authorization: `Bearer ${adminAToken}` },
      });
      const orgAfterRefund = balAfterRefund.data.organizers.find((o) => o.organizer_id === organizerAUser.id);
      assert.equal(Number(orgAfterRefund?.current_balance || 0), 0.00);

      // Duplicate refund attempt MUST be rejected with conflict
      const refundRes2 = await apiRequest(`/api/payments/${paymentId}/refund`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminAToken}` },
        body: { reason: "Second refund attempt" },
      });
      assert.equal(refundRes2.status, 409);
      assert.match(refundRes2.data.error.message, /Only confirmed payments can be refunded/i);
    });
  });
});
