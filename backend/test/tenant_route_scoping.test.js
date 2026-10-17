/**
 * Automated Security Test Suite - Phase 3 Stage 3
 * Route Scoping & Query Hardening Multi-Tenant Isolation Suite
 *
 * Verifies strict tenant scoping across all 12 modules:
 * 1. Products & Stores (read, patch, delete, favorites, analytics)
 * 2. Merchant Applications & Notifications
 * 3. Events, Tickets & Waitlist (attendees, decisions, ticket verification, occurrences)
 * 4. P2P Listings & Orders (listings, requests, orders, payments)
 * 5. Rental Items & Bookings (items, bookings, pickup, return, disputes)
 * 6. Payment IDOR Prevention & Admin Boundaries
 * 7. Commissions & Reports Scoping
 * 8. Notifications IDOR & Public Profile Cross-Campus Privacy
 * 9. Super Admin Cross-Tenant Access
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
const { signTicket, buildQrPayload } = require("../src/utils/qr");

let server;
let baseUrl;

// Universities
let uniA, uniB, uniSuspended;

// Actors and tokens
let superAdminToken, superAdminUser;
let adminAToken, adminAUser;
let adminBToken, adminBUser;
let studentA1Token, studentA1User;
let studentA2Token, studentA2User;
let studentB1Token, studentB1User;
let merchantAToken, merchantAUser, storeA, productA;
let merchantBToken, merchantBUser, storeB, productB;
let organizerAToken, organizerAUser, clubA, eventA, ticketTypeA, ticketA;
let organizerBToken, organizerBUser, clubB, eventB, ticketTypeB, ticketB;
let rentalItemA, bookingA;
let listingA;
let paymentA;
let suspendedUser;

const cleanupUniIds = [];
const cleanupUserIds = [];

async function apiRequest(path, { method = "GET", headers = {}, body } = {}) {
  const url = `${baseUrl}${path}`;
  const reqHeaders = { ...headers };

  let reqBody = undefined;
  if (body !== undefined) {
    reqHeaders["Content-Type"] = "application/json";
    reqBody = typeof body === "string" ? body : JSON.stringify(body);
  }

  const res = await fetch(url, {
    method,
    headers: reqHeaders,
    body: reqBody,
  });

  let data = null;
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    data = await res.json();
  } else {
    data = await res.text();
  }

  return { status: res.status, data, headers: res.headers };
}

async function createTestUser({ name, email, role, universityId, verified = true, department = "CS", year = 3, suspended = false, emailVerified = true }) {
  const hash = await hashPassword("Password123!");
  const { rows } = await db.query(
    `INSERT INTO users (name, email, role, university_id, verified, verification_method, password_hash, department, year, suspended, email_verified)
     VALUES ($1, $2, $3, $4, $5, 'domain', $6, $7, $8, $9, $10)
     RETURNING *`,
    [name, email, role, universityId, verified, hash, department, year, suspended, emailVerified]
  );
  cleanupUserIds.push(rows[0].id);
  const token = signAccessToken(rows[0]);
  return { user: rows[0], token };
}

before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await db.query("DELETE FROM tickets WHERE qr_token_hash = 'b0e9c3fe3ff97a4fd6e596c6ee43587cb50a1d3c2edcceeb114b7a248f52ed9b'").catch(() => {});

  const ts = Date.now();

  // Create Uni A, Uni B, and Uni Suspended
  const uniARes = await db.query(
    `INSERT INTO universities (name, slug, domain, permitted_domains, status)
     VALUES ($1, $2, $3, $4, 'active') RETURNING *`,
    ["University A", `uni-a-${ts}`, `unia-${ts}.edu.et`, [`unia-${ts}.edu.et`]]
  );
  uniA = uniARes.rows[0];
  cleanupUniIds.push(uniA.id);

  const uniBRes = await db.query(
    `INSERT INTO universities (name, slug, domain, permitted_domains, status)
     VALUES ($1, $2, $3, $4, 'active') RETURNING *`,
    ["University B", `uni-b-${ts}`, `unib-${ts}.edu.et`, [`unib-${ts}.edu.et`]]
  );
  uniB = uniBRes.rows[0];
  cleanupUniIds.push(uniB.id);

  const uniSuspRes = await db.query(
    `INSERT INTO universities (name, slug, domain, permitted_domains, status)
     VALUES ($1, $2, $3, $4, 'suspended') RETURNING *`,
    ["University Suspended", `uni-susp-${ts}`, `unisusp-${ts}.edu.et`, [`unisusp-${ts}.edu.et`]]
  );
  uniSuspended = uniSuspRes.rows[0];
  cleanupUniIds.push(uniSuspended.id);

  // Users
  const superA = await createTestUser({ name: "Super Admin", email: `super_${ts}@platform.local`, role: "super_admin", universityId: null });
  superAdminUser = superA.user; superAdminToken = superA.token;

  const admA = await createTestUser({ name: "Admin A", email: `admin_${ts}@unia-${ts}.edu.et`, role: "admin", universityId: uniA.id });
  adminAUser = admA.user; adminAToken = admA.token;

  const admB = await createTestUser({ name: "Admin B", email: `admin_${ts}@unib-${ts}.edu.et`, role: "admin", universityId: uniB.id });
  adminBUser = admB.user; adminBToken = admB.token;

  const stA1 = await createTestUser({ name: "Student A1", email: `st_a1_${ts}@unia-${ts}.edu.et`, role: "student", universityId: uniA.id });
  studentA1User = stA1.user; studentA1Token = stA1.token;

  const stA2 = await createTestUser({ name: "Student A2", email: `st_a2_${ts}@unia-${ts}.edu.et`, role: "student", universityId: uniA.id });
  studentA2User = stA2.user; studentA2Token = stA2.token;

  const stB1 = await createTestUser({ name: "Student B1", email: `st_b1_${ts}@unib-${ts}.edu.et`, role: "student", universityId: uniB.id });
  studentB1User = stB1.user; studentB1Token = stB1.token;

  const merA = await createTestUser({ name: "Merchant A", email: `mer_a_${ts}@unia-${ts}.edu.et`, role: "merchant", universityId: uniA.id });
  merchantAUser = merA.user; merchantAToken = merA.token;

  const merB = await createTestUser({ name: "Merchant B", email: `mer_b_${ts}@unib-${ts}.edu.et`, role: "merchant", universityId: uniB.id });
  merchantBUser = merB.user; merchantBToken = merB.token;

  const orgA = await createTestUser({ name: "Organizer A", email: `org_a_${ts}@unia-${ts}.edu.et`, role: "organizer", universityId: uniA.id });
  organizerAUser = orgA.user; organizerAToken = orgA.token;

  const orgB = await createTestUser({ name: "Organizer B", email: `org_b_${ts}@unib-${ts}.edu.et`, role: "organizer", universityId: uniB.id });
  organizerBUser = orgB.user; organizerBToken = orgB.token;

  const suspU = await createTestUser({ name: "Suspended Uni Student", email: `susp_${ts}@unisusp-${ts}.edu.et`, role: "student", universityId: uniSuspended.id });
  suspendedUser = suspU.user;

  // Stores and Products
  const stARes = await db.query(
    `INSERT INTO stores (name, merchant_id, university_id, status) VALUES ($1, $2, $3, 'active') RETURNING *`,
    ["Store A", merchantAUser.id, uniA.id]
  );
  storeA = stARes.rows[0];

  const stBRes = await db.query(
    `INSERT INTO stores (name, merchant_id, university_id, status) VALUES ($1, $2, $3, 'active') RETURNING *`,
    ["Store B", merchantBUser.id, uniB.id]
  );
  storeB = stBRes.rows[0];

  const prARes = await db.query(
    `INSERT INTO products (store_id, title, price, stock, status) VALUES ($1, 'Product A', 100.00, 10, 'active') RETURNING *`,
    [storeA.id]
  );
  productA = prARes.rows[0];

  const prBRes = await db.query(
    `INSERT INTO products (store_id, title, price, stock, status) VALUES ($1, 'Product B', 200.00, 10, 'active') RETURNING *`,
    [storeB.id]
  );
  productB = prBRes.rows[0];

  // Clubs and Events
  const clARes = await db.query(
    `INSERT INTO clubs (name, university_id, lead_user_id, status) VALUES ($1, $2, $3, 'active') RETURNING *`,
    ["Club A", uniA.id, organizerAUser.id]
  );
  clubA = clARes.rows[0];

  const clBRes = await db.query(
    `INSERT INTO clubs (name, university_id, lead_user_id, status) VALUES ($1, $2, $3, 'active') RETURNING *`,
    ["Club B", uniB.id, organizerBUser.id]
  );
  clubB = clBRes.rows[0];

  const evARes = await db.query(
    `INSERT INTO events (club_id, title, date_time, location, capacity, status, university_id)
     VALUES ($1, 'Event A', now() + interval '2 days', 'Campus A Hall', 100, 'published', $2) RETURNING *`,
    [clubA.id, uniA.id]
  );
  eventA = evARes.rows[0];

  const evBRes = await db.query(
    `INSERT INTO events (club_id, title, date_time, location, capacity, status, university_id)
     VALUES ($1, 'Event B', now() + interval '3 days', 'Campus B Hall', 100, 'published', $2) RETURNING *`,
    [clubB.id, uniB.id]
  );
  eventB = evBRes.rows[0];

  const ttARes = await db.query(
    `INSERT INTO ticket_types (event_id, name, price, quantity_total, quantity_sold, university_id)
     VALUES ($1, 'General', 50.00, 100, 1, $2) RETURNING *`,
    [eventA.id, uniA.id]
  );
  ticketTypeA = ttARes.rows[0];

  const ticketId = crypto.randomUUID();
  const sigA = signTicket(ticketId);
  const tkARes = await db.query(
    `INSERT INTO tickets (id, event_id, ticket_type_id, holder_id, status, qr_token_hash, university_id)
     VALUES ($1, $2, $3, $4, 'active', $5, $6) RETURNING *`,
    [ticketId, eventA.id, ticketTypeA.id, studentA1User.id, sigA, uniA.id]
  );
  ticketA = tkARes.rows[0];

  // Rentals
  const riARes = await db.query(
    `INSERT INTO rental_items (owner_id, title, price_per_day, deposit, available_from, available_to, status, university_id)
     VALUES ($1, 'Calculus Book A', 20.00, 50.00, now() - interval '1 day', now() + interval '10 days', 'active', $2) RETURNING *`,
    [studentA1User.id, uniA.id]
  );
  rentalItemA = riARes.rows[0];

  const bkARes = await db.query(
    `INSERT INTO rental_bookings (rental_item_id, borrower_id, start_date, end_date, total_amount, status, university_id)
     VALUES ($1, $2, now()::date, (now() + interval '3 days')::date, 110.00, 'confirmed_awaiting_pickup', $3) RETURNING *`,
    [rentalItemA.id, studentA2User.id, uniA.id]
  );
  bookingA = bkARes.rows[0];

  // P2P Listing
  const lsARes = await db.query(
    `INSERT INTO p2p_listings (seller_id, title, price, status, university_id)
     VALUES ($1, 'Desk Lamp A', 150.00, 'active', $2) RETURNING *`,
    [studentA1User.id, uniA.id]
  );
  listingA = lsARes.rows[0];

  // Payment record in Uni A (for bookingA)
  const payARes = await db.query(
    `INSERT INTO payments (transaction_type, transaction_id, amount, status, payer_id, university_id, provider)
     VALUES ('booking', $1, 110.00, 'confirmed', $2, $3, 'mock') RETURNING *`,
    [bookingA.id, studentA2User.id, uniA.id]
  );
  paymentA = payARes.rows[0];
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const unid of cleanupUniIds) {
    await db.query("DELETE FROM payments WHERE university_id = $1", [unid]).catch(() => {});
    await db.query("DELETE FROM tickets WHERE university_id = $1", [unid]).catch(() => {});
    await db.query("DELETE FROM ticket_types WHERE university_id = $1", [unid]).catch(() => {});
    await db.query("DELETE FROM events WHERE university_id = $1", [unid]).catch(() => {});
    await db.query("DELETE FROM clubs WHERE university_id = $1", [unid]).catch(() => {});
    await db.query("DELETE FROM rental_bookings WHERE university_id = $1", [unid]).catch(() => {});
    await db.query("DELETE FROM rental_items WHERE university_id = $1", [unid]).catch(() => {});
    await db.query("DELETE FROM p2p_orders WHERE university_id = $1", [unid]).catch(() => {});
    await db.query("DELETE FROM p2p_requests WHERE listing_id IN (SELECT id FROM p2p_listings WHERE university_id = $1)", [unid]).catch(() => {});
    await db.query("DELETE FROM p2p_listings WHERE university_id = $1", [unid]).catch(() => {});
    await db.query("DELETE FROM products WHERE store_id IN (SELECT id FROM stores WHERE university_id = $1)", [unid]).catch(() => {});
    await db.query("DELETE FROM stores WHERE university_id = $1", [unid]).catch(() => {});
    await db.query("DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE university_id = $1)", [unid]).catch(() => {});
    await db.query("DELETE FROM merchant_applications WHERE university_id = $1", [unid]).catch(() => {});
    await db.query("DELETE FROM reports WHERE university_id = $1", [unid]).catch(() => {});
    await db.query("DELETE FROM users WHERE university_id = $1", [unid]).catch(() => {});
    await db.query("DELETE FROM universities WHERE id = $1", [unid]).catch(() => {});
  }
  for (const uid of cleanupUserIds) {
    await db.query("DELETE FROM notifications WHERE user_id = $1", [uid]).catch(() => {});
    await db.query("DELETE FROM users WHERE id = $1", [uid]).catch(() => {});
  }
});

describe("Stage 3: Products & Stores Tenant Isolation", () => {
  test("3.1 Cross-tenant product fetch returns HTTP 404", async () => {
    const res = await apiRequest(`/api/products/${productA.id}`, {
      headers: { Authorization: `Bearer ${studentB1Token}` },
    });
    assert.equal(res.status, 404, "Student B must not be able to read Product A");
  });

  test("3.2 Cross-tenant product PATCH returns HTTP 404", async () => {
    const res = await apiRequest(`/api/products/${productA.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${merchantBToken}` },
      body: { title: "Hacked Title" },
    });
    assert.equal(res.status, 404, "Merchant B modifying Product A must receive 404");
  });

  test("3.3 Cross-tenant product DELETE returns HTTP 404", async () => {
    const res = await apiRequest(`/api/products/${productA.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${merchantBToken}` },
    });
    assert.equal(res.status, 404, "Merchant B deleting Product A must receive 404");
  });

  test("3.4 Cross-tenant product favorite returns HTTP 404", async () => {
    const res = await apiRequest(`/api/products/${productA.id}/favorite`, {
      method: "POST",
      headers: { Authorization: `Bearer ${studentB1Token}` },
    });
    assert.equal(res.status, 404, "Student B favoriting Product A must receive 404");
  });

  test("3.5 GET /api/merchants/:storeId/analytics rejects cross-tenant admin with HTTP 404", async () => {
    const res = await apiRequest(`/api/merchants/${storeA.id}/analytics`, {
      headers: { Authorization: `Bearer ${adminBToken}` },
    });
    assert.equal(res.status, 404, "Admin B querying Store A analytics must receive 404");
  });

  test("3.6 Superadmin can view store analytics across universities", async () => {
    const res = await apiRequest(`/api/merchants/${storeA.id}/analytics`, {
      headers: { Authorization: `Bearer ${superAdminToken}` },
    });
    assert.equal(res.status, 200, "Superadmin should have cross-tenant access to store analytics");
    assert.ok(res.data.orderCount !== undefined);
  });
});

describe("Stage 3: Merchant Applications & Scoped Admin Notifications", () => {
  test("3.7 POST /api/merchants/apply notifies ONLY admins of the applicant's university", async () => {
    // Clear notifications for adminA and adminB before applying
    await db.query("DELETE FROM notifications WHERE user_id IN ($1, $2)", [adminAUser.id, adminBUser.id]);

    const res = await apiRequest("/api/merchants/apply", {
      method: "POST",
      headers: { Authorization: `Bearer ${studentA2Token}` },
      body: { businessName: "Student A2 Shop", category: "Books" },
    });
    assert.equal(res.status, 201);

    const notifsAdminA = await db.query("SELECT * FROM notifications WHERE user_id = $1 AND type = 'merchant_application'", [adminAUser.id]);
    const notifsAdminB = await db.query("SELECT * FROM notifications WHERE user_id = $1 AND type = 'merchant_application'", [adminBUser.id]);

    assert.equal(notifsAdminA.rows.length, 1, "Admin A must receive notification for Uni A application");
    assert.equal(notifsAdminB.rows.length, 0, "Admin B must NOT receive notification for Uni A application");
  });

  test("3.8 Admin A cannot decide applications belonging to University B", async () => {
    // Create an application for student B1
    const { rows: appB } = await db.query(
      `INSERT INTO merchant_applications (user_id, university_id, business_name, status)
       VALUES ($1, $2, 'B1 Shop', 'pending_review') RETURNING *`,
      [studentB1User.id, uniB.id]
    );

    const res = await apiRequest(`/api/merchants/${appB[0].id}/decision`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${adminAToken}` },
      body: { decision: "approve" },
    });
    assert.equal(res.status, 404, "Admin A must receive 404 trying to decide Uni B application");
  });
});

describe("Stage 3: Events, Tickets & Waitlist Tenant Isolation", () => {
  test("3.9 Cross-tenant event access returns HTTP 404", async () => {
    const res = await apiRequest(`/api/events/${eventA.id}`, {
      headers: { Authorization: `Bearer ${studentB1Token}` },
    });
    assert.equal(res.status, 404, "Student B accessing Event A must receive 404");
  });

  test("3.10 Cross-tenant event admin decision returns HTTP 404", async () => {
    const res = await apiRequest(`/api/events/${eventA.id}/admin-decision`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${adminBToken}` },
      body: { decision: "approve" },
    });
    assert.equal(res.status, 404, "Admin B approving Event A must receive 404");
  });

  test("3.11 Cross-tenant attendees list returns HTTP 404", async () => {
    const res = await apiRequest(`/api/events/${eventA.id}/attendees`, {
      headers: { Authorization: `Bearer ${adminBToken}` },
    });
    assert.equal(res.status, 404, "Admin B inspecting Event A attendees must receive 404");
  });

  test("3.12 Cross-tenant ticket scanning by campus admin returns HTTP 403", async () => {
    const qrPayload = buildQrPayload(ticketA.id, signTicket(ticketA.id));
    const res = await apiRequest(`/api/tickets/${ticketA.id}/verify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminBToken}` },
      body: { qrToken: qrPayload },
    });
    assert.equal(res.status, 403, "Admin B scanning Ticket A from Uni A must receive 403 forbidden");
  });

  test("3.13 Super admin can verify tickets across any university", async () => {
    const qrPayload = buildQrPayload(ticketA.id, signTicket(ticketA.id));
    const res = await apiRequest(`/api/tickets/${ticketA.id}/verify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${superAdminToken}` },
      body: { qrToken: qrPayload },
    });
    assert.equal(res.status, 200, "Super admin must be authorized to verify tickets");
    assert.equal(res.data.result, "ADMIT");
  });

  test("3.14 Cross-tenant event occurrences list returns HTTP 404", async () => {
    const res = await apiRequest(`/api/events/${eventA.id}/occurrences`, {
      headers: { Authorization: `Bearer ${studentB1Token}` },
    });
    assert.equal(res.status, 404, "Student B querying occurrences of Event A must receive 404");
  });
});

describe("Stage 3: P2P Listings & Orders Scoping", () => {
  test("3.15 Cross-tenant P2P listing fetch returns HTTP 404", async () => {
    const res = await apiRequest(`/api/listings/${listingA.id}`, {
      headers: { Authorization: `Bearer ${studentB1Token}` },
    });
    assert.equal(res.status, 404, "Student B querying Listing A must receive 404");
  });

  test("3.16 Cross-tenant P2P listing PATCH returns HTTP 404", async () => {
    const res = await apiRequest(`/api/listings/${listingA.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${studentB1Token}` },
      body: { price: 10 },
    });
    assert.equal(res.status, 404, "Student B attempting to PATCH Listing A must receive 404");
  });

  test("3.17 Cross-tenant P2P buy request returns HTTP 404", async () => {
    const res = await apiRequest(`/api/listings/${listingA.id}/requests`, {
      method: "POST",
      headers: { Authorization: `Bearer ${studentB1Token}` },
      body: { message: "I want this" },
    });
    assert.equal(res.status, 404, "Student B requesting to buy Listing A must receive 404");
  });

  test("3.18 Cross-tenant P2P request decision returns HTTP 404", async () => {
    // Create request by Student A2 on Listing A
    const { rows: reqA } = await db.query(
      `INSERT INTO p2p_requests (listing_id, buyer_id, message, status)
       VALUES ($1, $2, 'Hello', 'pending') RETURNING *`,
      [listingA.id, studentA2User.id]
    );

    const res = await apiRequest(`/api/listings/requests/${reqA[0].id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${studentB1Token}` },
      body: { status: "accepted" },
    });
    assert.equal(res.status, 404, "Student B deciding Uni A request must receive 404");
  });
});

describe("Stage 3: Rental Items & Bookings Tenant Isolation", () => {
  test("3.19 Cross-tenant rental item fetch returns HTTP 404", async () => {
    const res = await apiRequest(`/api/rentals/${rentalItemA.id}`, {
      headers: { Authorization: `Bearer ${studentB1Token}` },
    });
    assert.equal(res.status, 404, "Student B querying Rental Item A must receive 404");
  });

  test("3.20 Cross-tenant rental item PATCH returns HTTP 404", async () => {
    const res = await apiRequest(`/api/rentals/${rentalItemA.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${studentB1Token}` },
      body: { pricePerDay: 5 },
    });
    assert.equal(res.status, 404, "Student B attempting to PATCH Rental Item A must receive 404");
  });

  test("3.21 Cross-tenant rental booking creation returns HTTP 404", async () => {
    const res = await apiRequest(`/api/rentals/${rentalItemA.id}/bookings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${studentB1Token}` },
      body: {
        startDate: new Date(Date.now() + 86400000).toISOString().split("T")[0],
        endDate: new Date(Date.now() + 86400000 * 3).toISOString().split("T")[0],
      },
    });
    assert.equal(res.status, 404, "Student B attempting to book Rental Item A must receive 404");
  });

  test("3.22 Cross-tenant rental pickup, return, and dispute return HTTP 404", async () => {
    const pickupRes = await apiRequest(`/api/rentals/bookings/${bookingA.id}/pickup`, {
      method: "POST",
      headers: { Authorization: `Bearer ${studentB1Token}` },
    });
    assert.equal(pickupRes.status, 404, "Student B confirming pickup on Booking A must receive 404");

    const returnRes = await apiRequest(`/api/rentals/bookings/${bookingA.id}/return`, {
      method: "POST",
      headers: { Authorization: `Bearer ${studentB1Token}` },
    });
    assert.equal(returnRes.status, 404, "Student B confirming return on Booking A must receive 404");

    const disputeRes = await apiRequest(`/api/rentals/bookings/${bookingA.id}/dispute`, {
      method: "POST",
      headers: { Authorization: `Bearer ${studentB1Token}` },
      body: { reason: "Broken item" },
    });
    assert.equal(disputeRes.status, 404, "Student B filing dispute on Booking A must receive 404");
  });
});

describe("Stage 3: Payment Record IDOR Protection & Admin Boundaries", () => {
  test("3.23 GET /api/payments/:id returns HTTP 404 for unrelated user in same university (IDOR prevention)", async () => {
    // studentA1 is in Uni A, but paymentA belongs to studentA2 (payer)
    const res = await apiRequest(`/api/payments/${paymentA.id}`, {
      headers: { Authorization: `Bearer ${studentA1Token}` },
    });
    assert.equal(res.status, 404, "Unrelated student in same university must receive 404 on payment record");
  });

  test("3.24 GET /api/payments/:id returns HTTP 404 for user in another university", async () => {
    const res = await apiRequest(`/api/payments/${paymentA.id}`, {
      headers: { Authorization: `Bearer ${studentB1Token}` },
    });
    assert.equal(res.status, 404, "User in another university must receive 404 on payment record");
  });

  test("3.25 Payer can view their own payment record", async () => {
    const res = await apiRequest(`/api/payments/${paymentA.id}`, {
      headers: { Authorization: `Bearer ${studentA2Token}` },
    });
    assert.equal(res.status, 200, "Payer must be able to view their payment record");
    assert.equal(res.data.payment.id, paymentA.id);
  });

  test("3.26 Campus Admin A can view payment record for University A", async () => {
    const res = await apiRequest(`/api/payments/${paymentA.id}`, {
      headers: { Authorization: `Bearer ${adminAToken}` },
    });
    assert.equal(res.status, 200, "Campus Admin A must be able to view payment in their university");
    assert.equal(res.data.payment.id, paymentA.id);
  });

  test("3.27 Campus Admin B receives HTTP 404 attempting to view or refund Payment A", async () => {
    const viewRes = await apiRequest(`/api/payments/${paymentA.id}`, {
      headers: { Authorization: `Bearer ${adminBToken}` },
    });
    assert.equal(viewRes.status, 404, "Campus Admin B must receive 404 viewing Payment A");

    const refundRes = await apiRequest(`/api/payments/${paymentA.id}/refund`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminBToken}` },
      body: { amount: 50, reason: "Cross-campus refund attempt" },
    });
    assert.equal(refundRes.status, 404, "Campus Admin B must receive 404 refunding Payment A");
  });

  test("3.28 Super admin can view Payment A", async () => {
    const res = await apiRequest(`/api/payments/${paymentA.id}`, {
      headers: { Authorization: `Bearer ${superAdminToken}` },
    });
    assert.equal(res.status, 200, "Super admin must be able to view payments across universities");
    assert.equal(res.data.payment.id, paymentA.id);
  });
});

describe("Stage 3: Commissions & Reports Scoping", () => {
  test("3.29 Admin B querying seller drilldown for Uni A seller returns HTTP 404", async () => {
    const res = await apiRequest(`/api/commissions/admin/sellers/${merchantAUser.id}`, {
      headers: { Authorization: `Bearer ${adminBToken}` },
    });
    assert.equal(res.status, 404, "Admin B inspecting Uni A seller commissions must receive 404");
  });

  test("3.30 Super admin can view seller drilldown for Uni A seller", async () => {
    const res = await apiRequest(`/api/commissions/admin/sellers/${merchantAUser.id}`, {
      headers: { Authorization: `Bearer ${superAdminToken}` },
    });
    assert.equal(res.status, 200, "Super admin must have access to seller commissions drilldown");
    assert.equal(res.data.seller.id, merchantAUser.id);
  });

  test("3.31 POST /api/reports notifies ONLY admins of the reporter's university", async () => {
    await db.query("DELETE FROM notifications WHERE user_id IN ($1, $2)", [adminAUser.id, adminBUser.id]);

    const res = await apiRequest("/api/reports", {
      method: "POST",
      headers: { Authorization: `Bearer ${studentA1Token}` },
      body: {
        targetType: "product",
        targetId: productA.id,
        reason: "Defective item",
      },
    });
    assert.equal(res.status, 201);

    const notifsA = await db.query("SELECT * FROM notifications WHERE user_id = $1 AND type = 'report'", [adminAUser.id]);
    const notifsB = await db.query("SELECT * FROM notifications WHERE user_id = $1 AND type = 'report'", [adminBUser.id]);

    assert.equal(notifsA.rows.length, 1, "Admin A must receive report notification");
    assert.equal(notifsB.rows.length, 0, "Admin B must NOT receive report notification for Uni A report");
  });
});

describe("Stage 3: Notifications IDOR & Public User Profile Privacy", () => {
  test("3.32 PATCH /api/notifications/:id/read returns HTTP 404 for notification belonging to another user", async () => {
    // Insert a notification for studentA1
    const { rows: notif } = await db.query(
      `INSERT INTO notifications (user_id, type, title, body)
       VALUES ($1, 'general', 'Secret Note', 'Private message') RETURNING id`,
      [studentA1User.id]
    );

    // Student A2 tries to mark Student A1's notification as read
    const res = await apiRequest(`/api/notifications/${notif[0].id}/read`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${studentA2Token}` },
    });
    assert.equal(res.status, 404, "Marking another user's notification as read must return 404 (no existence probe)");
  });

  test("3.33 Public profile for user belonging to suspended university returns HTTP 404", async () => {
    const res = await apiRequest(`/api/users/${suspendedUser.id}/public`);
    assert.equal(res.status, 404, "Public profile of suspended university user must return 404");
  });

  test("3.34 Public profile masks department & year for students accessed across campuses", async () => {
    // Student B1 views Student A1's public profile
    const crossRes = await apiRequest(`/api/users/${studentA1User.id}/public`, {
      headers: { Authorization: `Bearer ${studentB1Token}` },
    });
    assert.equal(crossRes.status, 200);
    assert.equal(crossRes.data.user.name, studentA1User.name);
    assert.equal(crossRes.data.user.department, null, "Department must be masked across campuses");
    assert.equal(crossRes.data.user.year, null, "Year must be masked across campuses");

    // Student A2 (same campus) views Student A1's public profile
    const sameRes = await apiRequest(`/api/users/${studentA1User.id}/public`, {
      headers: { Authorization: `Bearer ${studentA2Token}` },
    });
    assert.equal(sameRes.status, 200);
    assert.equal(sameRes.data.user.department, studentA1User.department, "Department visible to same campus");
    assert.equal(sameRes.data.user.year, studentA1User.year, "Year visible to same campus");
  });
});

describe("Stage 3: Promotion, Verification & Manual Payments Boundaries", () => {
  test("3.35 POST /api/products/:id/promote returns HTTP 404 for cross-tenant product (IDOR prevention)", async () => {
    const res = await apiRequest(`/api/products/${productA.id}/promote`, {
      method: "POST",
      headers: { Authorization: `Bearer ${merchantBToken}` },
      body: { days: 7 },
    });
    assert.equal(res.status, 404, "Merchant B promoting Product A must receive 404");
  });

  test("3.36 Public profile cross-tenant roleData is completely masked", async () => {
    // Cross-campus visitor receives empty roleData
    const crossRes = await apiRequest(`/api/users/${studentA1User.id}/public`, {
      headers: { Authorization: `Bearer ${studentB1Token}` },
    });
    assert.equal(crossRes.status, 200);
    assert.deepEqual(crossRes.data.roleData, {}, "Cross-campus visitor must not receive student listings or rentals");

    // Same-campus student receives student's listings/rentals showcase
    const sameRes = await apiRequest(`/api/users/${studentA1User.id}/public`, {
      headers: { Authorization: `Bearer ${studentA2Token}` },
    });
    assert.equal(sameRes.status, 200);
    assert.ok(Array.isArray(sameRes.data.roleData.activeListings), "Same campus student sees active listings");
  });

  test("3.37 POST /api/events/:eventId/tickets returns HTTP 404 for cross-campus purchase", async () => {
    const res = await apiRequest(`/api/events/${eventA.id}/tickets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${studentB1Token}` },
      body: { ticketTypeId: ticketTypeA.id },
    });
    assert.equal(res.status, 404, "Student B purchasing ticket for Event A must receive 404");
  });

  test("3.38 POST /api/events/:eventId/tickets succeeds for same-campus student", async () => {
    const res = await apiRequest(`/api/events/${eventA.id}/tickets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${studentA2Token}` },
      body: { ticketTypeId: ticketTypeA.id },
    });
    assert.equal(res.status, 201, "Student A2 must be able to buy ticket for Event A");
    assert.equal(res.data.ticket.status, "reserved");
  });

  test("3.39 POST /api/events/:eventId/waitlist returns HTTP 404 for cross-campus student", async () => {
    const res = await apiRequest(`/api/events/${eventA.id}/waitlist`, {
      method: "POST",
      headers: { Authorization: `Bearer ${studentB1Token}` },
      body: { ticketTypeId: ticketTypeA.id },
    });
    assert.equal(res.status, 404, "Student B joining waitlist for Event A must receive 404");
  });

  test("3.40 Admin B cannot review verification requests of University A students", async () => {
    // Create verification request for Student A1
    const { rows: reqA } = await db.query(
      `INSERT INTO verification_requests (user_id, university_id, document_type, document_url, status)
       VALUES ($1, $2, 'student_id', '/private_uploads/proofs/test.pdf', 'pending') RETURNING *`,
      [studentA1User.id, uniA.id]
    );

    const approveRes = await apiRequest(`/api/admin/verifications/requests/${reqA[0].id}/approve`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${adminBToken}` },
    });
    assert.equal(approveRes.status, 404, "Admin B must receive 404 approving Uni A verification request");

    const rejectRes = await apiRequest(`/api/admin/verifications/requests/${reqA[0].id}/reject`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${adminBToken}` },
      body: { rejectionReason: "Invalid document" },
    });
    assert.equal(rejectRes.status, 404, "Admin B must receive 404 rejecting Uni A verification request");
  });

  test("3.41 Admin A can approve verification request for University A student", async () => {
    const { rows: reqA2 } = await db.query(
      `INSERT INTO verification_requests (user_id, university_id, document_type, document_url, status)
       VALUES ($1, $2, 'student_id', '/private_uploads/proofs/test2.pdf', 'pending') RETURNING *`,
      [studentA2User.id, uniA.id]
    );

    const approveRes = await apiRequest(`/api/admin/verifications/requests/${reqA2[0].id}/approve`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${adminAToken}` },
    });
    assert.equal(approveRes.status, 200, "Admin A must be able to approve Uni A verification request");
    assert.equal(approveRes.data.status, "approved");
  });

  test("3.42 GET /api/payments/manual/incoming scopes strictly to caller's university for campus admin", async () => {
    const resA = await apiRequest("/api/payments/manual/incoming?status=all", {
      headers: { Authorization: `Bearer ${adminAToken}` },
    });
    assert.equal(resA.status, 200);
    for (const p of resA.data.payments) {
      assert.equal(p.university_id || uniA.id, uniA.id, "Admin A must only see Uni A manual payments");
    }

    const resB = await apiRequest("/api/payments/manual/incoming?status=all", {
      headers: { Authorization: `Bearer ${adminBToken}` },
    });
    assert.equal(resB.status, 200);
    // Uni B has no payments created in test fixture
    assert.equal(resB.data.payments.length, 0, "Admin B must not see any Uni A payments");
  });
});

describe("Stage 3: Verified Same-Campus Positive Operations", () => {
  test("3.43 Student A1 can read Product A, and Merchant A can update it", async () => {
    const readRes = await apiRequest(`/api/products/${productA.id}`, {
      headers: { Authorization: `Bearer ${studentA1Token}` },
    });
    assert.equal(readRes.status, 200);
    assert.equal(readRes.data.product.title, "Product A");

    const patchRes = await apiRequest(`/api/products/${productA.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${merchantAToken}` },
      body: { title: "Product A Renamed" },
    });
    assert.equal(patchRes.status, 200);
    assert.equal(patchRes.data.product.title, "Product A Renamed");
  });

  test("3.44 Student A1 can read Event A, and Organizer A can view attendees", async () => {
    const readRes = await apiRequest(`/api/events/${eventA.id}`, {
      headers: { Authorization: `Bearer ${studentA1Token}` },
    });
    assert.equal(readRes.status, 200);
    assert.equal(readRes.data.event.title, "Event A");

    const attendeesRes = await apiRequest(`/api/events/${eventA.id}/attendees`, {
      headers: { Authorization: `Bearer ${organizerAToken}` },
    });
    assert.equal(attendeesRes.status, 200);
    assert.ok(Array.isArray(attendeesRes.data.attendees));
  });

  test("3.45 Student A2 can read Rental Item A, and Student A1 can read Listing A", async () => {
    const rentalRes = await apiRequest(`/api/rentals/${rentalItemA.id}`, {
      headers: { Authorization: `Bearer ${studentA2Token}` },
    });
    assert.equal(rentalRes.status, 200);
    assert.equal(rentalRes.data.item.title, "Calculus Book A");

    const listingRes = await apiRequest(`/api/listings/${listingA.id}`, {
      headers: { Authorization: `Bearer ${studentA1Token}` },
    });
    assert.equal(listingRes.status, 200);
    assert.equal(listingRes.data.listing.title, "Desk Lamp A");
  });
});
