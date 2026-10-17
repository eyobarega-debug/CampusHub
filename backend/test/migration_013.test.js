const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const db = require("../src/db");

describe("Migration 013: Multi-tenant Architecture & Isolation", () => {
  const migrationSql = fs.readFileSync(
    path.join(__dirname, "../db/migrations/013_multitenant_isolation.sql"),
    "utf8"
  );

  it("13.1 Applies migration 013 cleanly and idempotently", async () => {
    // First run
    await db.query(migrationSql);

    // Second run (proves idempotency)
    await db.query(migrationSql);

    // Verify universities columns
    const { rows: uniCols } = await db.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'universities'
       AND column_name IN ('permitted_domains', 'payment_config', 'branding', 'slug', 'status')`
    );
    const uniColNames = uniCols.map((c) => c.column_name);
    assert.ok(uniColNames.includes("permitted_domains"), "universities.permitted_domains column missing");
    assert.ok(uniColNames.includes("payment_config"), "universities.payment_config column missing");
    assert.ok(uniColNames.includes("branding"), "universities.branding column missing");
    assert.ok(uniColNames.includes("slug"), "universities.slug column missing");

    // Verify operational table columns
    const { rows: opCols } = await db.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'university_id'
       AND table_name IN ('rental_bookings', 'ticket_types', 'tickets', 'reviews', 'payout_accounts', 'payment_proofs')`
    );
    const opTableNames = opCols.map((c) => c.table_name);
    assert.ok(opTableNames.includes("rental_bookings"), "rental_bookings.university_id missing");
    assert.ok(opTableNames.includes("ticket_types"), "ticket_types.university_id missing");
    assert.ok(opTableNames.includes("tickets"), "tickets.university_id missing");
    assert.ok(opTableNames.includes("reviews"), "reviews.university_id missing");
    assert.ok(opTableNames.includes("payout_accounts"), "payout_accounts.university_id missing");
    assert.ok(opTableNames.includes("payment_proofs"), "payment_proofs.university_id missing");
  });

  it("13.2 Preserves existing data and backfills tenant IDs correctly", async () => {
    // Verify no NULL university_id in rental_bookings
    const { rows: nullBookings } = await db.query(
      "SELECT count(*)::int AS count FROM rental_bookings WHERE university_id IS NULL"
    );
    assert.strictEqual(nullBookings[0].count, 0, "Found rental_bookings with NULL university_id");

    // Verify no NULL university_id in tickets
    const { rows: nullTickets } = await db.query(
      "SELECT count(*)::int AS count FROM tickets WHERE university_id IS NULL"
    );
    assert.strictEqual(nullTickets[0].count, 0, "Found tickets with NULL university_id");

    // Verify no NULL university_id in ticket_types
    const { rows: nullTicketTypes } = await db.query(
      "SELECT count(*)::int AS count FROM ticket_types WHERE university_id IS NULL"
    );
    assert.strictEqual(nullTicketTypes[0].count, 0, "Found ticket_types with NULL university_id");

    // Verify AASTU has non-empty permitted_domains
    const { rows: aastu } = await db.query(
      "SELECT permitted_domains FROM universities WHERE domain = 'aastu.edu.et'"
    );
    assert.ok(aastu[0], "AASTU university row not found");
    assert.ok(Array.isArray(aastu[0].permitted_domains), "permitted_domains is not an array");
    assert.ok(aastu[0].permitted_domains.includes("aastu.edu.et"), "aastu.edu.et missing from permitted_domains");
  });

  it("13.3 Automatic trigger derivations on INSERT for all operational tables", async () => {
    // 1. Get an active university
    const { rows: unis } = await db.query(
      "SELECT id FROM universities WHERE status = 'active' LIMIT 1"
    );
    assert.ok(unis[0], "No active university found");
    const testUniId = unis[0].id;

    // 2. Create test user belonging to testUniId
    const testEmail = `trg_test_${Date.now()}@aastu.edu.et`;
    const { rows: userRows } = await db.query(
      `INSERT INTO users (university_id, name, email, password_hash, role, verified, email_verified)
       VALUES ($1, 'Trigger Tester', $2, 'dummyhash', 'student', true, true)
       RETURNING id, university_id`,
      [testUniId, testEmail]
    );
    const testUser = userRows[0];

    try {
      // 3. Test payout_accounts trigger
      const { rows: paRows } = await db.query(
        `INSERT INTO payout_accounts (owner_id, method, account_name, account_number)
         VALUES ($1, 'cbe', 'Trigger Tester', '1000123456789')
         RETURNING id, university_id`,
        [testUser.id]
      );
      assert.strictEqual(paRows[0].university_id, testUniId, "payout_accounts trigger did not derive university_id");

      // 4. Test rental_items & rental_bookings trigger
      const { rows: itemRows } = await db.query(
        `INSERT INTO rental_items (owner_id, title, price_per_day, available_from, available_to)
         VALUES ($1, 'Trigger Item', 50, now(), now() + interval '7 days')
         RETURNING id, university_id`,
        [testUser.id]
      );
      assert.strictEqual(itemRows[0].university_id, testUniId, "rental_items trigger did not derive university_id");

      const { rows: bookingRows } = await db.query(
        `INSERT INTO rental_bookings (rental_item_id, borrower_id, start_date, end_date, total_amount)
         VALUES ($1, $2, CURRENT_DATE, CURRENT_DATE + 3, 150)
         RETURNING id, university_id`,
        [itemRows[0].id, testUser.id]
      );
      assert.strictEqual(bookingRows[0].university_id, testUniId, "rental_bookings trigger did not derive university_id");

      // 5. Test clubs, events, ticket_types & tickets triggers
      const { rows: clubRows } = await db.query(
        `INSERT INTO clubs (university_id, name, lead_user_id)
         VALUES ($1, 'Trigger Club', $2)
         RETURNING id, university_id`,
        [testUniId, testUser.id]
      );
      assert.strictEqual(clubRows[0].university_id, testUniId, "club did not have university_id");

      const { rows: eventRows } = await db.query(
        `INSERT INTO events (club_id, title, date_time, capacity)
         VALUES ($1, 'Trigger Event', now() + interval '10 days', 100)
         RETURNING id, university_id`,
        [clubRows[0].id]
      );
      assert.strictEqual(eventRows[0].university_id, testUniId, "events trigger did not derive university_id");

      const { rows: ttRows } = await db.query(
        `INSERT INTO ticket_types (event_id, name, price, quantity_total)
         VALUES ($1, 'Regular', 100, 50)
         RETURNING id, university_id`,
        [eventRows[0].id]
      );
      assert.strictEqual(ttRows[0].university_id, testUniId, "ticket_types trigger did not derive university_id");

      const { rows: ticketRows } = await db.query(
        `INSERT INTO tickets (event_id, ticket_type_id, holder_id, qr_token_hash)
         VALUES ($1, $2, $3, 'trg_qr_' || gen_random_uuid()::text)
         RETURNING id, university_id`,
        [eventRows[0].id, ttRows[0].id, testUser.id]
      );
      assert.strictEqual(ticketRows[0].university_id, testUniId, "tickets trigger did not derive university_id");

      // 6. Test stores & reviews trigger
      const { rows: storeRows } = await db.query(
        `INSERT INTO stores (merchant_id, name)
         VALUES ($1, 'Trigger Store')
         RETURNING id, university_id`,
        [testUser.id]
      );
      assert.strictEqual(storeRows[0].university_id, testUniId, "stores trigger did not derive university_id");

      const { rows: reviewRows } = await db.query(
        `INSERT INTO reviews (author_id, target_type, target_id, rating, comment)
         VALUES ($1, 'store', $2, 5, 'Great trigger test!')
         RETURNING id, university_id`,
        [testUser.id, storeRows[0].id]
      );
      assert.strictEqual(reviewRows[0].university_id, testUniId, "reviews trigger did not derive university_id");
    } finally {
      // Clean up test rows in dependency order
      await db.query("DELETE FROM reviews WHERE author_id = $1", [testUser.id]);
      await db.query("DELETE FROM rental_bookings WHERE borrower_id = $1", [testUser.id]);
      await db.query("DELETE FROM rental_items WHERE owner_id = $1", [testUser.id]);
      await db.query("DELETE FROM tickets WHERE holder_id = $1", [testUser.id]);
      await db.query("DELETE FROM ticket_types WHERE event_id IN (SELECT e.id FROM events e JOIN clubs c ON c.id = e.club_id WHERE c.lead_user_id = $1)", [testUser.id]);
      await db.query("DELETE FROM events WHERE club_id IN (SELECT id FROM clubs WHERE lead_user_id = $1)", [testUser.id]);
      await db.query("DELETE FROM clubs WHERE lead_user_id = $1", [testUser.id]);
      await db.query("DELETE FROM stores WHERE merchant_id = $1", [testUser.id]);
      await db.query("DELETE FROM payout_accounts WHERE owner_id = $1", [testUser.id]);
      await db.query("DELETE FROM users WHERE id = $1", [testUser.id]);
    }
  });

  it("13.4 Status check constraint enforces valid university statuses", async () => {
    // Valid status update
    await db.query("UPDATE universities SET status = 'active' WHERE domain = 'aastu.edu.et'");

    // Invalid status update should throw check constraint violation
    await assert.rejects(
      async () => {
        await db.query("UPDATE universities SET status = 'invalid_status' WHERE domain = 'aastu.edu.et'");
      },
      (err) => {
        return err.code === "23514"; // check_violation
      },
      "Expected check constraint violation for invalid university status"
    );
  });
});
