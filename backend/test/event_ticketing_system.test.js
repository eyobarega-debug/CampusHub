/**
 * Automated Integration Test Suite — Event Ticketing System
 *
 * Verifies all business requirements for Gibiyachin Platform (ግቢያችን):
 * 1. Event creation with poster, venue, end_time, category, organizer details.
 * 2. Multi-tier ticket configuration (Free, Regular, VIP) with quotas and purchase limits.
 * 3. Event update (PATCH /api/events/:id) and ownership authorization guards.
 * 4. Free ticket issuance with unique human-readable ticket_number (GIB-XXXXXXXX) and instant activation.
 * 5. Paid ticket reservation with ticket_number and pending payment flow.
 * 6. Payment confirmation finalizer: ticket activation and cryptographic HMAC signature.
 * 7. Enriched attendee ticket retrieval (GET /api/tickets/mine and GET /api/tickets/:id).
 * 8. IDOR authorization guards on ticket retrieval.
 * 9. Ticket inspection (action: "inspect"): attendee preview without status transition.
 * 10. Unpaid reservation inspection: PAYMENT_NOT_APPROVED.
 * 11. Cancelled ticket inspection: CANCELLED.
 * 12. Atomic check-in (action: "check_in"): single-use guarantee, used_at timestamp recording.
 * 13. Re-scan prevention: ALREADY_USED returned with original check-in timestamp.
 * 14. Check-in audit trail: ticket_checkins table and GET /api/tickets/event/:id/checkins.
 * 15. Check-in reversal: authorized restoration to 'active' with audit entry.
 * 16. Multi-tenant campus isolation on check-ins: cross-campus verification blocked (HTTP 403).
 * 17. Concurrency safety: simultaneous check-ins via Promise.all() admit exactly once.
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
const { isValidSignature, signTicket, buildQrPayload, buildVerificationUrl } = require("../src/utils/qr");
const payments = require("../src/services/payments");

let server;
let baseUrl;

// Fixtures
let uniA, uniB;
let adminAToken, adminAUser;
let adminBToken, adminBUser;
let organizerAToken, organizerAUser, clubA;
let organizerBToken, organizerBUser, clubB;
let studentA1Token, studentA1User;
let studentA2Token, studentA2User;
let studentBToken, studentBUser;
let campusHubAccountA;

const cleanupUniIds = [];
const cleanupUserIds = [];

async function apiRequest(endpoint, { method = "GET", headers = {}, body } = {}) {
  const reqHeaders = { ...headers };
  let payload = undefined;

  if (body !== undefined) {
    payload = JSON.stringify(body);
    reqHeaders["Content-Type"] = "application/json";
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
    [uniId, name, `${email}.${runId}@ticketing.edu.et`, pwHash, role]
  );
  cleanupUserIds.push(rows[0].id);
  return { user: rows[0], token: signAccessToken(rows[0]) };
}

before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  runId = crypto.randomBytes(4).toString("hex");
  pwHash = await hashPassword("ValidPassword123!");

  // Create two universities for multi-tenancy verification
  const { rows: uA } = await db.query(
    `INSERT INTO universities (name, domain) VALUES ($1, $2) RETURNING *`,
    [`Ticketing Uni A ${runId}`, `unia-${runId}.edu.et`]
  );
  uniA = uA[0];
  cleanupUniIds.push(uniA.id);

  const { rows: uB } = await db.query(
    `INSERT INTO universities (name, domain) VALUES ($1, $2) RETURNING *`,
    [`Ticketing Uni B ${runId}`, `unib-${runId}.edu.et`]
  );
  uniB = uB[0];
  cleanupUniIds.push(uniB.id);

  // Users for University A
  const admA = await makeUser(uniA.id, "Admin Uni A", "admina", "admin");
  adminAUser = admA.user;
  adminAToken = admA.token;

  const orgA = await makeUser(uniA.id, "Organizer A", "orga", "organizer");
  organizerAUser = orgA.user;
  organizerAToken = orgA.token;

  const stuA1 = await makeUser(uniA.id, "Student A1", "stua1", "student");
  studentA1User = stuA1.user;
  studentA1Token = stuA1.token;

  const stuA2 = await makeUser(uniA.id, "Student A2", "stua2", "student");
  studentA2User = stuA2.user;
  studentA2Token = stuA2.token;

  // Users for University B
  const admB = await makeUser(uniB.id, "Admin Uni B", "adminb", "admin");
  adminBUser = admB.user;
  adminBToken = admB.token;

  const orgB = await makeUser(uniB.id, "Organizer B", "orgb", "organizer");
  organizerBUser = orgB.user;
  organizerBToken = orgB.token;

  const stuB = await makeUser(uniB.id, "Student B", "stub", "student");
  studentBUser = stuB.user;
  studentBToken = stuB.token;

  // Clubs
  const { rows: cA } = await db.query(
    `INSERT INTO clubs (university_id, name, lead_user_id, status)
     VALUES ($1, $2, $3, 'active') RETURNING *`,
    [uniA.id, `Tech Club A ${runId}`, organizerAUser.id]
  );
  clubA = cA[0];

  const { rows: cB } = await db.query(
    `INSERT INTO clubs (university_id, name, lead_user_id, status)
     VALUES ($1, $2, $3, 'active') RETURNING *`,
    [uniB.id, `Robotics Club B ${runId}`, organizerBUser.id]
  );
  clubB = cB[0];

  // CampusHub receiving account for University A
  const { rows: accA } = await db.query(
    `INSERT INTO payout_accounts (university_id, owner_id, method, account_name, account_number, instructions, is_default, is_campus_hub, active)
     VALUES ($1, $2, 'telebirr', 'Gibiyachin Official A', '0911000999', 'Gibiyachin event ticket payment', true, true, true)
     RETURNING *`,
    [uniA.id, adminAUser.id]
  );
  campusHubAccountA = accA[0];
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  for (const uid of cleanupUserIds) {
    await db.query("DELETE FROM users WHERE id = $1", [uid]).catch(() => {});
  }
  for (const unid of cleanupUniIds) {
    await db.query("DELETE FROM universities WHERE id = $1", [unid]).catch(() => {});
  }
});

describe("Complete Event Ticketing System Integration Tests", () => {
  let createdEvent;
  let freeTicketType;
  let paidTicketType;
  let vipTicketType;

  test("1. Organizer creates event with poster_url, venue_name, venue_address, end_time, category, organizer_name, contact_info", async () => {
    const start = new Date(Date.now() + 86400000 * 5); // 5 days in future
    const end = new Date(start.getTime() + 14400000); // 4 hours later

    const res = await apiRequest("/api/events", {
      method: "POST",
      headers: { Authorization: `Bearer ${organizerAToken}` },
      body: {
        title: "Gibiyachin Campus Tech Summit",
        description: "Annual university technology expo and student hackathon.",
        category: "Technology & Innovation",
        organizerName: "Tech Association",
        contactInfo: "tech@unia.edu.et / +251 911 000111",
        dateTime: start.toISOString(),
        endTime: end.toISOString(),
        venueName: "Grand Amphitheater",
        venueAddress: "Block 7, Innovation Center",
        location: "Grand Amphitheater",
        posterUrl: "https://images.unsplash.com/photo-1540575467063-178a50c2df87",
        capacity: 250,
        ticketTypes: [
          { name: "Free Pass", description: "General admission free pass", price: 0, quantityTotal: 100, purchaseLimit: 2 },
          { name: "Regular Entry", description: "Includes summit kit and lunch badge", price: 150, quantityTotal: 100, purchaseLimit: 5 },
          { name: "VIP Pass", description: "Front row seating and backstage access", price: 400, quantityTotal: 50, purchaseLimit: 2 },
        ],
      },
    });

    assert.equal(res.status, 201, `Expected 201 Created: ${JSON.stringify(res.data)}`);
    assert.ok(res.data.event?.id);
    createdEvent = res.data.event;

    // Verify all enhanced fields saved in database
    const { rows } = await db.query("SELECT * FROM events WHERE id = $1", [createdEvent.id]);
    const ev = rows[0];
    assert.equal(ev.poster_url, "https://images.unsplash.com/photo-1540575467063-178a50c2df87");
    assert.equal(ev.venue_name, "Grand Amphitheater");
    assert.equal(ev.venue_address, "Block 7, Innovation Center");
    assert.equal(ev.category, "Technology & Innovation");
    assert.equal(ev.organizer_name, "Tech Association");
    assert.equal(ev.contact_info, "tech@unia.edu.et / +251 911 000111");
    assert.ok(ev.end_time);
  });

  test("2. Multiple ticket tiers created with description, price, purchase_limit, quantity_total", async () => {
    const res = await apiRequest(`/api/events/${createdEvent.id}`, {
      headers: { Authorization: `Bearer ${studentA1Token}` },
    });
    assert.equal(res.status, 200);
    const types = res.data.ticketTypes;
    assert.equal(types.length, 3);

    freeTicketType = types.find((t) => t.name === "Free Pass");
    paidTicketType = types.find((t) => t.name === "Regular Entry");
    vipTicketType = types.find((t) => t.name === "VIP Pass");

    assert.ok(freeTicketType);
    assert.equal(Number(freeTicketType.price), 0);
    assert.equal(freeTicketType.purchase_limit, 2);

    assert.ok(paidTicketType);
    assert.equal(Number(paidTicketType.price), 150);
    assert.equal(paidTicketType.purchase_limit, 5);

    assert.ok(vipTicketType);
    assert.equal(Number(vipTicketType.price), 400);
  });

  test("3. Event update (PATCH /api/events/:id) by owner modifies poster and venue details", async () => {
    const res = await apiRequest(`/api/events/${createdEvent.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${organizerAToken}` },
      body: {
        venueName: "Auditorium Hall A (Updated)",
        posterUrl: "https://example.com/updated-poster.jpg",
      },
    });

    assert.equal(res.status, 200);
    const { rows } = await db.query("SELECT venue_name, poster_url FROM events WHERE id = $1", [createdEvent.id]);
    assert.equal(rows[0].venue_name, "Auditorium Hall A (Updated)");
    assert.equal(rows[0].poster_url, "https://example.com/updated-poster.jpg");
  });

  test("4. Unauthorized event update rejected with HTTP 403 (same tenant) and HTTP 404 (cross-tenant)", async () => {
    // Student from same university attempts to update event -> 403 Forbidden
    const resSameTenant = await apiRequest(`/api/events/${createdEvent.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${studentA1Token}` },
      body: { venueName: "Hacked Venue" },
    });
    assert.equal(resSameTenant.status, 403);

    // Organizer from another university attempts to update event -> 404 Not Found (tenant isolation)
    const resCrossTenant = await apiRequest(`/api/events/${createdEvent.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${organizerBToken}` },
      body: { venueName: "Hacked Venue" },
    });
    assert.equal(resCrossTenant.status, 404);
  });

  // Approve and publish the event so ticket sales are open
  test("Publish event for ticket sales", async () => {
    await db.query("UPDATE events SET status = 'published' WHERE id = $1", [createdEvent.id]);
  });

  let freeTicket;
  test("5. Free ticket issuance generates unique ticket_number (GIB-XXXXXXXX) and status 'active'", async () => {
    const res = await apiRequest(`/api/events/${createdEvent.id}/tickets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${studentA1Token}` },
      body: { ticketTypeId: freeTicketType.id, paymentMethod: "manual" },
    });

    assert.equal(res.status, 201, `Failed to reserve free ticket: ${JSON.stringify(res.data)}`);
    assert.ok(res.data.ticket);
    freeTicket = res.data.ticket;

    assert.equal(freeTicket.status, "active", "Free ticket should be immediately active");
    assert.ok(freeTicket.ticket_number, "ticket_number must be generated");
    assert.match(freeTicket.ticket_number, /^GIB-[A-Z0-9]{8}$/, "ticket_number must match GIB-XXXXXXXX pattern");

    // Cryptographic signature verification
    assert.ok(isValidSignature(freeTicket.id, freeTicket.qr_token_hash));
  });

  let paidTicket;
  let paidPayment;
  test("6. Paid ticket reservation generates ticket_number, status 'reserved', and pending payment", async () => {
    const res = await apiRequest(`/api/events/${createdEvent.id}/tickets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${studentA2Token}` },
      body: { ticketTypeId: paidTicketType.id, paymentMethod: "manual" },
    });

    assert.equal(res.status, 201, `Failed to reserve paid ticket: ${JSON.stringify(res.data)}`);
    assert.ok(res.data.ticket);
    paidTicket = res.data.ticket;
    paidPayment = res.data.payment;

    assert.equal(paidTicket.status, "reserved", "Paid ticket must start as reserved");
    assert.ok(paidTicket.ticket_number, "Paid ticket must receive a ticket_number upon reservation");
    assert.match(paidTicket.ticket_number, /^GIB-[A-Z0-9]{8}$/);
    assert.ok(paidPayment?.paymentId);

    const { rows: payRows } = await db.query("SELECT status FROM payments WHERE id = $1", [paidPayment.paymentId]);
    assert.equal(payRows[0].status, "pending");
  });

  test("7. Payment confirmation activates ticket with valid HMAC signature while preserving ticket_number", async () => {
    // Admin confirms manual payment callback
    await payments.handleProviderCallback(paidPayment.paymentId, "success");

    const { rows } = await db.query("SELECT * FROM tickets WHERE id = $1", [paidTicket.id]);
    const activated = rows[0];
    assert.equal(activated.status, "active");
    assert.equal(activated.ticket_number, paidTicket.ticket_number, "ticket_number must be preserved upon activation");
    assert.ok(isValidSignature(activated.id, activated.qr_token_hash));
    paidTicket = activated;
  });

  test("8. GET /api/tickets/mine returns enriched ticket details (poster, venue, ticket_number, qrUrl, qrDataUrl)", async () => {
    const res = await apiRequest("/api/tickets/mine", {
      headers: { Authorization: `Bearer ${studentA1Token}` },
    });

    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data.tickets));
    const found = res.data.tickets.find((t) => t.id === freeTicket.id);
    assert.ok(found);
    assert.equal(found.ticket_number, freeTicket.ticket_number);
    assert.equal(found.poster_url, "https://example.com/updated-poster.jpg");
    assert.equal(found.venue_name, "Auditorium Hall A (Updated)");
    assert.ok(found.qrUrl);
    assert.ok(found.qrPayload);
    assert.ok(found.qrDataUrl?.startsWith("data:image/png;base64,"));
    assert.equal(found.university_name, uniA.name);
  });

  test("9. Single ticket retrieval by holder (GET /api/tickets/:id) succeeds", async () => {
    const res = await apiRequest(`/api/tickets/${freeTicket.id}`, {
      headers: { Authorization: `Bearer ${studentA1Token}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.ticket.id, freeTicket.id);
    assert.equal(res.data.ticket.ticket_number, freeTicket.ticket_number);
    assert.ok(res.data.ticket.qrDataUrl);
  });

  test("10. IDOR Protection: Third-party student cannot retrieve another user's ticket via GET /api/tickets/:id", async () => {
    const res = await apiRequest(`/api/tickets/${freeTicket.id}`, {
      headers: { Authorization: `Bearer ${studentA2Token}` }, // Student A2 does not own freeTicket
    });
    assert.equal(res.status, 403, "Must return HTTP 403 Forbidden on IDOR attempt");
  });

  test("11. Event organizer can view attendee ticket via GET /api/tickets/:id", async () => {
    const res = await apiRequest(`/api/tickets/${freeTicket.id}`, {
      headers: { Authorization: `Bearer ${organizerAToken}` },
    });
    assert.equal(res.status, 200, "Event organizer must have authorized access to view attendee ticket");
    assert.equal(res.data.ticket.id, freeTicket.id);
  });

  test("12. Ticket inspection (action: 'inspect') previews attendee without changing status to 'used'", async () => {
    const sig = signTicket(freeTicket.id);
    const token = `${freeTicket.id}.${sig}`;

    const res = await apiRequest("/api/tickets/scan", {
      method: "POST",
      headers: { Authorization: `Bearer ${organizerAToken}` },
      body: { qrToken: token, action: "inspect" },
    });

    assert.equal(res.status, 200);
    assert.equal(res.data.result, "VALID");
    assert.equal(res.data.eligible, true);
    assert.equal(res.data.attendeeName, studentA1User.name);
    assert.equal(res.data.ticketNumber, freeTicket.ticket_number);
    assert.equal(res.data.ticketType, "Free Pass");

    // Status MUST remain 'active' in database
    const { rows } = await db.query("SELECT status, used_at FROM tickets WHERE id = $1", [freeTicket.id]);
    assert.equal(rows[0].status, "active", "Inspection must not consume ticket");
    assert.equal(rows[0].used_at, null);
  });

  test("13. Inspection of unpaid/reserved ticket returns PAYMENT_NOT_APPROVED", async () => {
    // Reserve another paid ticket but do not approve payment
    const res1 = await apiRequest(`/api/events/${createdEvent.id}/tickets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${studentA1Token}` },
      body: { ticketTypeId: paidTicketType.id, paymentMethod: "manual" },
    });
    const unpaidTicket = res1.data.ticket;

    const sig = signTicket(unpaidTicket.id);
    const res = await apiRequest("/api/tickets/scan", {
      method: "POST",
      headers: { Authorization: `Bearer ${organizerAToken}` },
      body: { qrToken: `${unpaidTicket.id}.${sig}`, action: "inspect" },
    });

    assert.equal(res.status, 200);
    assert.equal(res.data.result, "PAYMENT_NOT_APPROVED");
    assert.equal(res.data.eligible, false);
  });

  test("14. Inspection of cancelled ticket returns CANCELLED", async () => {
    // Create fresh student without existing tickets
    const stuA3 = await makeUser(uniA.id, "Student A3", "stua3", "student");
    const res1 = await apiRequest(`/api/events/${createdEvent.id}/tickets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${stuA3.token}` },
      body: { ticketTypeId: freeTicketType.id, paymentMethod: "manual" },
    });
    assert.equal(res1.status, 201);
    const cancelMe = res1.data.ticket;
    await db.query("UPDATE tickets SET status = 'cancelled' WHERE id = $1", [cancelMe.id]);

    const sig = signTicket(cancelMe.id);
    const res = await apiRequest("/api/tickets/scan", {
      method: "POST",
      headers: { Authorization: `Bearer ${organizerAToken}` },
      body: { qrToken: `${cancelMe.id}.${sig}`, action: "inspect" },
    });

    assert.equal(res.status, 200);
    assert.equal(res.data.result, "CANCELLED");
    assert.equal(res.data.eligible, false);
  });

  let admissionTime;
  test("15. Atomic check-in (action: 'check_in') admits ticket, sets status to 'used', and logs audit entry", async () => {
    const sig = signTicket(freeTicket.id);
    const fullUrl = buildVerificationUrl(freeTicket.id, sig);

    // Test that scanning a full verification URL also works seamlessly
    const res = await apiRequest("/api/tickets/scan", {
      method: "POST",
      headers: { Authorization: `Bearer ${organizerAToken}` },
      body: { qrToken: fullUrl, action: "check_in", deviceInfo: "Door 1 Handheld Scanner" },
    });

    assert.equal(res.status, 200);
    assert.equal(res.data.result, "ADMIT");
    assert.ok(res.data.checkedInAt);
    admissionTime = res.data.checkedInAt;

    // Database check
    const { rows } = await db.query("SELECT * FROM tickets WHERE id = $1", [freeTicket.id]);
    assert.equal(rows[0].status, "used");
    assert.ok(rows[0].used_at);
    assert.equal(rows[0].used_by, organizerAUser.id);

    // Verify ticket_checkins audit table entry
    const { rows: chk } = await db.query(
      "SELECT * FROM ticket_checkins WHERE ticket_id = $1 AND is_reversal = false",
      [freeTicket.id]
    );
    assert.equal(chk.length, 1);
    assert.equal(chk[0].staff_id, organizerAUser.id);
    assert.equal(chk[0].device_info, "Door 1 Handheld Scanner");
  });

  test("16. Second check-in of same ticket returns ALREADY_USED and preserves original timestamp", async () => {
    const sig = signTicket(freeTicket.id);
    const res = await apiRequest("/api/tickets/scan", {
      method: "POST",
      headers: { Authorization: `Bearer ${organizerAToken}` },
      body: { qrToken: `${freeTicket.id}.${sig}`, action: "check_in" },
    });

    assert.equal(res.status, 200);
    assert.equal(res.data.result, "ALREADY_USED");
    assert.ok(res.data.previousScanAt);

    // Ensure database timestamp was NOT overwritten
    const { rows } = await db.query("SELECT used_at FROM tickets WHERE id = $1", [freeTicket.id]);
    assert.equal(new Date(rows[0].used_at).toISOString(), new Date(admissionTime).toISOString());
  });

  test("17. GET /api/tickets/event/:eventId/checkins returns live admissions feed", async () => {
    const res = await apiRequest(`/api/tickets/event/${createdEvent.id}/checkins`, {
      headers: { Authorization: `Bearer ${organizerAToken}` },
    });

    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data.checkins));
    const found = res.data.checkins.find((c) => c.ticket_id === freeTicket.id);
    assert.ok(found);
    assert.equal(found.staff_name, organizerAUser.name);
    assert.equal(found.holder_name, studentA1User.name);
    assert.equal(found.ticket_number, freeTicket.ticket_number);
  });

  test("18. Check-in reversal (POST /api/tickets/:id/reverse-checkin) restores status to 'active' with audit entry", async () => {
    const res = await apiRequest(`/api/tickets/${freeTicket.id}/reverse-checkin`, {
      method: "POST",
      headers: { Authorization: `Bearer ${organizerAToken}` },
      body: { reason: "Attendee stepped out briefly before entry gate" },
    });

    assert.equal(res.status, 200);
    assert.equal(res.data.success, true);

    // Database check
    const { rows } = await db.query("SELECT status, used_at, used_by FROM tickets WHERE id = $1", [freeTicket.id]);
    assert.equal(rows[0].status, "active", "Ticket must be active again");
    assert.equal(rows[0].used_at, null);
    assert.equal(rows[0].used_by, null);

    // Verify reversal entry in ticket_checkins
    const { rows: revRows } = await db.query(
      "SELECT * FROM ticket_checkins WHERE ticket_id = $1 AND is_reversal = true",
      [freeTicket.id]
    );
    assert.equal(revRows.length, 1);
    assert.equal(revRows[0].reversed_by, organizerAUser.id);
    assert.equal(revRows[0].notes, "Attendee stepped out briefly before entry gate");
  });

  test("19. Re-scanning reversed ticket allows fresh admission", async () => {
    const sig = signTicket(freeTicket.id);
    const res = await apiRequest("/api/tickets/scan", {
      method: "POST",
      headers: { Authorization: `Bearer ${organizerAToken}` },
      body: { qrToken: `${freeTicket.id}.${sig}`, action: "check_in" },
    });

    assert.equal(res.status, 200);
    assert.equal(res.data.result, "ADMIT");

    const { rows } = await db.query("SELECT status FROM tickets WHERE id = $1", [freeTicket.id]);
    assert.equal(rows[0].status, "used");
  });

  test("20. Unauthorized reversal rejected with HTTP 403", async () => {
    const res = await apiRequest(`/api/tickets/${freeTicket.id}/reverse-checkin`, {
      method: "POST",
      headers: { Authorization: `Bearer ${organizerBToken}` }, // Organizer B from different university
      body: { reason: "Unauthorized attempt" },
    });
    assert.equal(res.status, 403);
  });

  test("21. Cross-campus check-in isolation: staff from Uni B cannot scan Uni A ticket", async () => {
    const sig = signTicket(paidTicket.id);
    const res = await apiRequest("/api/tickets/scan", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminBToken}` }, // Admin from University B
      body: { qrToken: `${paidTicket.id}.${sig}`, action: "check_in" },
    });

    assert.equal(res.status, 403, "Must reject cross-campus verification with 403 Forbidden");
  });

  test("22. Concurrency Safety: Two simultaneous check-ins via Promise.all() admit exactly ONE and reject the other", async () => {
    // Issue a fresh active ticket to a new student
    const stuA4 = await makeUser(uniA.id, "Student A4", "stua4", "student");
    const res1 = await apiRequest(`/api/events/${createdEvent.id}/tickets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${stuA4.token}` },
      body: { ticketTypeId: freeTicketType.id, paymentMethod: "manual" },
    });
    assert.equal(res1.status, 201);
    const concurrentTicket = res1.data.ticket;
    assert.equal(concurrentTicket.status, "active");

    const sig = signTicket(concurrentTicket.id);
    const token = `${concurrentTicket.id}.${sig}`;

    // Send two check-in requests simultaneously against real Express server
    const [scanA, scanB] = await Promise.all([
      apiRequest("/api/tickets/scan", {
        method: "POST",
        headers: { Authorization: `Bearer ${organizerAToken}` },
        body: { qrToken: token, action: "check_in", deviceInfo: "Scanner Alpha" },
      }),
      apiRequest("/api/tickets/scan", {
        method: "POST",
        headers: { Authorization: `Bearer ${organizerAToken}` },
        body: { qrToken: token, action: "check_in", deviceInfo: "Scanner Beta" },
      }),
    ]);

    const results = [scanA.data.result, scanB.data.result];
    assert.ok(
      results.includes("ADMIT"),
      `Exactly one scan must be ADMIT, received: ${JSON.stringify(results)}`
    );
    assert.ok(
      results.includes("ALREADY_USED"),
      `The conflicting scan must receive ALREADY_USED, received: ${JSON.stringify(results)}`
    );

    // Database check: Exactly 1 admission checkin entry
    const { rows: chk } = await db.query(
      "SELECT * FROM ticket_checkins WHERE ticket_id = $1 AND is_reversal = false",
      [concurrentTicket.id]
    );
    assert.equal(chk.length, 1, "Exactly one check-in audit entry must be recorded");

    // Final status must be 'used'
    const { rows: tRows } = await db.query("SELECT status FROM tickets WHERE id = $1", [concurrentTicket.id]);
    assert.equal(tRows[0].status, "used");
  });

  test("23. Backward compatibility: Legacy POST /api/tickets/:id/verify continues to work", async () => {
    // Issue a fresh active ticket
    const res1 = await apiRequest(`/api/events/${createdEvent.id}/tickets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${studentA1Token}` },
      body: { ticketTypeId: freeTicketType.id, paymentMethod: "manual" },
    });
    const legTicket = res1.data.ticket;

    const sig = signTicket(legTicket.id);
    const token = `${legTicket.id}.${sig}`;

    // First call: ADMIT
    const resFirst = await apiRequest(`/api/tickets/${legTicket.id}/verify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${organizerAToken}` },
      body: { qrToken: token },
    });
    assert.equal(resFirst.status, 200);
    assert.equal(resFirst.data.result, "ADMIT");

    // Second call: ALREADY_USED
    const resSecond = await apiRequest(`/api/tickets/${legTicket.id}/verify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${organizerAToken}` },
      body: { qrToken: token },
    });
    assert.equal(resSecond.status, 200);
    assert.equal(resSecond.data.result, "ALREADY_USED");
  });

  test("24. Poster URL validation rejects dangerous schemes (javascript:, data:) with HTTP 400", async () => {
    // Malicious javascript: scheme
    const resXss = await apiRequest("/api/events", {
      method: "POST",
      headers: { Authorization: `Bearer ${organizerAToken}` },
      body: {
        title: "Malicious Poster Event",
        category: "Other Campus Event",
        dateTime: new Date(Date.now() + 86400000).toISOString(),
        venueName: "Campus Hall",
        posterUrl: "javascript:alert(document.cookie)",
        capacity: 50,
        ticketTypes: [{ name: "General", price: 0, quantityTotal: 50 }],
      },
    });
    assert.equal(resXss.status, 400, "Must reject javascript: URI with HTTP 400");

    // Malicious data: scheme
    const resData = await apiRequest("/api/events", {
      method: "POST",
      headers: { Authorization: `Bearer ${organizerAToken}` },
      body: {
        title: "Data URI Poster Event",
        category: "Other Campus Event",
        dateTime: new Date(Date.now() + 86400000).toISOString(),
        venueName: "Campus Hall",
        posterUrl: "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
        capacity: 50,
        ticketTypes: [{ name: "General", price: 0, quantityTotal: 50 }],
      },
    });
    assert.equal(resData.status, 400, "Must reject data: URI with HTTP 400");

    // Safe /uploads/ path succeeds
    const resSafe = await apiRequest("/api/events", {
      method: "POST",
      headers: { Authorization: `Bearer ${organizerAToken}` },
      body: {
        title: "Safe Poster Event",
        category: "Other Campus Event",
        dateTime: new Date(Date.now() + 86400000).toISOString(),
        venueName: "Campus Hall",
        posterUrl: "/uploads/4085a0ca1b09813d85f3c128cbc292a411e0d9ae.png",
        capacity: 50,
        ticketTypes: [{ name: "General", price: 0, quantityTotal: 50 }],
      },
    });
    assert.equal(resSafe.status, 201, "Safe upload path must be accepted");
  });

  test("25. Ticket tier purchaseLimit enforcement blocks hoarding with PURCHASE_LIMIT_EXCEEDED (HTTP 409)", async () => {
    // vipTicketType has purchase_limit = 2
    const stuVip = await makeUser(uniA.id, "Student VIP", "stuvip", "student");

    // Purchase 1
    const p1 = await apiRequest(`/api/events/${createdEvent.id}/tickets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${stuVip.token}` },
      body: { ticketTypeId: vipTicketType.id, paymentMethod: "manual" },
    });
    assert.equal(p1.status, 201);

    // Purchase 2
    const p2 = await apiRequest(`/api/events/${createdEvent.id}/tickets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${stuVip.token}` },
      body: { ticketTypeId: vipTicketType.id, paymentMethod: "manual" },
    });
    assert.equal(p2.status, 201);

    // Purchase 3: Exceeds purchase_limit (2)
    const p3 = await apiRequest(`/api/events/${createdEvent.id}/tickets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${stuVip.token}` },
      body: { ticketTypeId: vipTicketType.id, paymentMethod: "manual" },
    });
    assert.equal(p3.status, 409);
    assert.equal(p3.data.error.code, "PURCHASE_LIMIT_EXCEEDED");
  });

  test("26. Cancelled event rejects attendee admission with EVENT_CANCELLED", async () => {
    // Create and publish an event, issue a ticket, then cancel the event
    const start = new Date(Date.now() + 86400000 * 2);
    const { rows: evR } = await db.query(
      `INSERT INTO events (club_id, title, date_time, location, capacity, status, university_id)
       VALUES ($1, 'Event to be Cancelled', $2, 'Room 101', 50, 'published', $3) RETURNING *`,
      [clubA.id, start.toISOString(), uniA.id]
    );
    const canEv = evR[0];
    const { rows: ttR } = await db.query(
      `INSERT INTO ticket_types (event_id, name, price, quantity_total)
       VALUES ($1, 'General', 0, 50) RETURNING *`,
      [canEv.id]
    );
    const canTt = ttR[0];

    const stuCan = await makeUser(uniA.id, "Student CancelEv", "stucanev", "student");
    const tRes = await apiRequest(`/api/events/${canEv.id}/tickets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${stuCan.token}` },
      body: { ticketTypeId: canTt.id, paymentMethod: "manual" },
    });
    assert.equal(tRes.status, 201);
    const ticketToReject = tRes.data.ticket;

    // Organizer cancels the event
    await db.query("UPDATE events SET status = 'cancelled' WHERE id = $1", [canEv.id]);

    const sig = signTicket(ticketToReject.id);
    const token = `${ticketToReject.id}.${sig}`;

    // Staff attempts to scan / check in
    const scanRes = await apiRequest("/api/tickets/scan", {
      method: "POST",
      headers: { Authorization: `Bearer ${organizerAToken}` },
      body: { qrToken: token, action: "check_in" },
    });

    assert.equal(scanRes.status, 200);
    assert.equal(scanRes.data.result, "EVENT_CANCELLED");

    // Database status remains unadmitted
    const { rows: postRows } = await db.query("SELECT status, used_at FROM tickets WHERE id = $1", [ticketToReject.id]);
    assert.notEqual(postRows[0].status, "used");
    assert.equal(postRows[0].used_at, null);
  });

  test("27. Concurrent check-in and buyer cancellation resolve safely without double-dipping", async () => {
    // Issue a fresh active free ticket to a new student
    const stuRace = await makeUser(uniA.id, "Student Race", "sturace", "student");
    const tRes = await apiRequest(`/api/events/${createdEvent.id}/tickets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${stuRace.token}` },
      body: { ticketTypeId: freeTicketType.id, paymentMethod: "manual" },
    });
    assert.equal(tRes.status, 201);
    const raceTicket = tRes.data.ticket;

    const sig = signTicket(raceTicket.id);
    const token = `${raceTicket.id}.${sig}`;

    // Concurrently: Attendee cancels ticket while Staff scans ticket for admission
    const [cancelOutcome, scanOutcome] = await Promise.all([
      apiRequest(`/api/tickets/${raceTicket.id}/cancel`, {
        method: "POST",
        headers: { Authorization: `Bearer ${stuRace.token}` },
        body: { reason: "Last minute conflict" },
      }),
      apiRequest("/api/tickets/scan", {
        method: "POST",
        headers: { Authorization: `Bearer ${organizerAToken}` },
        body: { qrToken: token, action: "check_in" },
      }),
    ]);

    // Either check-in succeeded and cancellation failed, or cancellation succeeded and check-in rejected
    if (scanOutcome.data.result === "ADMIT") {
      assert.equal(cancelOutcome.status, 409, "Cancellation must be rejected if ticket was admitted");
      const { rows } = await db.query("SELECT status FROM tickets WHERE id = $1", [raceTicket.id]);
      assert.equal(rows[0].status, "used");
    } else {
      assert.equal(cancelOutcome.status, 200, "Cancellation succeeded");
      assert.notEqual(scanOutcome.data.result, "ADMIT", "Check-in must NOT admit a cancelled ticket");
      const { rows } = await db.query("SELECT status FROM tickets WHERE id = $1", [raceTicket.id]);
      assert.equal(rows[0].status, "cancelled");
    }
  });

  test("28. Production secret enforcement rejects weak or missing TICKET_QR_SECRET in production", () => {
    const origEnv = process.env.NODE_ENV;
    const origSecret = process.env.TICKET_QR_SECRET;
    try {
      process.env.NODE_ENV = "production";
      process.env.TICKET_QR_SECRET = "short_insecure_secret";

      assert.throws(
        () => signTicket("test-ticket-id"),
        /TICKET_QR_SECRET/i,
        "signTicket must throw an error when secret is weak or missing in production"
      );
    } finally {
      process.env.NODE_ENV = origEnv;
      process.env.TICKET_QR_SECRET = origSecret;
    }
  });

  test("29. Constant-time signature comparison rejects forged or malformed signatures", () => {
    const ticketId = crypto.randomUUID();
    const validSig = signTicket(ticketId);

    // Valid signature passes
    assert.equal(isValidSignature(ticketId, validSig), true);

    // Forged signature (flipped single bit) fails
    const tampered = validSig.slice(0, -1) + (validSig.endsWith("a") ? "b" : "a");
    assert.equal(isValidSignature(ticketId, tampered), false);

    // Null, empty, or mismatched length fails without throwing
    assert.equal(isValidSignature(ticketId, ""), false);
    assert.equal(isValidSignature(ticketId, null), false);
    assert.equal(isValidSignature(ticketId, undefined), false);
    assert.equal(isValidSignature(ticketId, "abc"), false);
    assert.equal(isValidSignature(null, validSig), false);
    assert.equal(isValidSignature("", validSig), false);
  });

  test("30. Reverse check-in cannot reactivate a ticket for a cancelled event (HTTP 409)", async () => {
    // Create event, issue ticket, check it in, then cancel the event
    const start = new Date(Date.now() + 86400000 * 3);
    const { rows: evR } = await db.query(
      `INSERT INTO events (club_id, title, date_time, location, capacity, status, university_id)
       VALUES ($1, 'Event for Reversal Test', $2, 'Auditorium A', 50, 'published', $3) RETURNING *`,
      [clubA.id, start.toISOString(), uniA.id]
    );
    const revEv = evR[0];
    const { rows: ttR } = await db.query(
      `INSERT INTO ticket_types (event_id, name, price, quantity_total)
       VALUES ($1, 'General', 0, 50) RETURNING *`,
      [revEv.id]
    );
    const revTt = ttR[0];

    const stuRev = await makeUser(uniA.id, "Student Reversal Test", "sturev", "student");
    const tRes = await apiRequest(`/api/events/${revEv.id}/tickets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${stuRev.token}` },
      body: { ticketTypeId: revTt.id, paymentMethod: "manual" },
    });
    assert.equal(tRes.status, 201);
    const revTicket = tRes.data.ticket;

    // Check in the ticket
    const sig = signTicket(revTicket.id);
    const token = `${revTicket.id}.${sig}`;
    const scanRes = await apiRequest("/api/tickets/scan", {
      method: "POST",
      headers: { Authorization: `Bearer ${organizerAToken}` },
      body: { qrToken: token, action: "check_in" },
    });
    assert.equal(scanRes.status, 200);
    assert.equal(scanRes.data.result, "ADMIT");

    // Event is cancelled
    await db.query("UPDATE events SET status = 'cancelled' WHERE id = $1", [revEv.id]);

    // Attempt to reverse check-in on cancelled event must be rejected
    const revRes = await apiRequest(`/api/tickets/${revTicket.id}/reverse-checkin`, {
      method: "POST",
      headers: { Authorization: `Bearer ${organizerAToken}` },
      body: { reason: "Attempting to reverse check-in on cancelled event" },
    });
    assert.equal(revRes.status, 409, "Must reject check-in reversal for cancelled event with HTTP 409");

    // Ticket must remain in used status and not become active
    const { rows } = await db.query("SELECT status FROM tickets WHERE id = $1", [revTicket.id]);
    assert.notEqual(rows[0].status, "active", "Ticket must not be reactivated for cancelled event");
  });

  test("31. Reverse check-in cannot reactivate a refunded ticket (HTTP 409)", async () => {
    // Issue paid ticket, confirm payment, check in, refund payment, attempt reversal
    const stuRefund = await makeUser(uniA.id, "Student Refund Rev", "sturefundrev", "student");
    const tRes = await apiRequest(`/api/events/${createdEvent.id}/tickets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${stuRefund.token}` },
      body: { ticketTypeId: paidTicketType.id, paymentMethod: "manual" },
    });
    assert.equal(tRes.status, 201);
    const refTicket = tRes.data.ticket;

    // Confirm payment so ticket becomes active
    const { rows: pRows } = await db.query(
      "SELECT id FROM payments WHERE transaction_type='ticket' AND transaction_id=$1",
      [refTicket.id]
    );
    await payments.handleProviderCallback(pRows[0].id, "success");

    // Check in ticket
    const sig = signTicket(refTicket.id);
    const token = `${refTicket.id}.${sig}`;
    const scanRes = await apiRequest("/api/tickets/scan", {
      method: "POST",
      headers: { Authorization: `Bearer ${organizerAToken}` },
      body: { qrToken: token, action: "check_in" },
    });
    assert.equal(scanRes.status, 200);
    assert.equal(scanRes.data.result, "ADMIT");

    // Admin refunds payment
    await payments.refundPayment(pRows[0].id, null, "Administrative refund", adminAUser.id);

    // Attempt to reverse check-in on refunded ticket
    const revRes = await apiRequest(`/api/tickets/${refTicket.id}/reverse-checkin`, {
      method: "POST",
      headers: { Authorization: `Bearer ${organizerAToken}` },
      body: { reason: "Mistaken admission" },
    });
    assert.equal(revRes.status, 409, "Must reject check-in reversal on refunded ticket with HTTP 409");

    // Ticket must not be reactivated to active
    const { rows } = await db.query("SELECT status FROM tickets WHERE id = $1", [refTicket.id]);
    assert.notEqual(rows[0].status, "active", "Refunded ticket must never be reactivated to active");
  });

  test("32. Secret rotation: validates tickets signed with TICKET_QR_SECRET_PREVIOUS during rotation window", () => {
    const oldSecret = "old_secret_012345678901234567890123456789012";
    const newSecret = "new_secret_987654321098765432109876543210987";
    const origSecret = process.env.TICKET_QR_SECRET;
    const origPrev = process.env.TICKET_QR_SECRET_PREVIOUS;

    try {
      // 1. Ticket issued before rotation
      process.env.TICKET_QR_SECRET = oldSecret;
      delete process.env.TICKET_QR_SECRET_PREVIOUS;

      const ticketId = crypto.randomUUID();
      const legacySig = signTicket(ticketId);
      assert.equal(isValidSignature(ticketId, legacySig), true);

      // 2. Secret is rotated: new active secret, previous secret preserved
      process.env.TICKET_QR_SECRET = newSecret;
      process.env.TICKET_QR_SECRET_PREVIOUS = oldSecret;

      // Newly signed ticket uses new secret
      const freshSig = signTicket(ticketId);
      assert.notEqual(freshSig, legacySig, "New signature must differ from old signature");
      assert.equal(isValidSignature(ticketId, freshSig), true, "Fresh ticket signed with new secret must validate");

      // Already-printed ticket with old secret still validates at the door
      assert.equal(isValidSignature(ticketId, legacySig), true, "Pre-rotation ticket must still validate during transition");

      // Forged / unknown secret fails
      const forgedSig = crypto.createHmac("sha256", "completely_unknown_secret_32chars").update(ticketId).digest("hex");
      assert.equal(isValidSignature(ticketId, forgedSig), false, "Forged signature must fail");
    } finally {
      process.env.TICKET_QR_SECRET = origSecret;
      if (origPrev) {
        process.env.TICKET_QR_SECRET_PREVIOUS = origPrev;
      } else {
        delete process.env.TICKET_QR_SECRET_PREVIOUS;
      }
    }
  });
});


