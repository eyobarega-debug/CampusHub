const { describe, it, before } = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const db = require("../src/db");

describe("Database Tenant Isolation & Integrity Tests", () => {
  let uniA;
  let uniB;

  before(async () => {
    const { rows: unis } = await db.query(
      "SELECT id, name FROM universities WHERE status = 'active' ORDER BY name LIMIT 2"
    );
    assert.ok(unis.length >= 2, "At least 2 active universities are required to test cross-tenant isolation");
    uniA = unis[0].id;
    uniB = unis[1].id;
  });

  // Helper to run any test within an isolated database transaction that is ALWAYS rolled back
  async function withTx(testFn) {
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      await testFn(client);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  }

  // Helper to assert an expected PostgreSQL error using savepoints within a transaction
  async function expectDbError(client, operationFn, expectedErrorSubstring) {
    await client.query("SAVEPOINT sp_error_probe");
    try {
      await operationFn();
      await client.query("RELEASE SAVEPOINT sp_error_probe");
      return false; // Did not throw
    } catch (err) {
      await client.query("ROLLBACK TO SAVEPOINT sp_error_probe");
      if (err.message && err.message.includes(expectedErrorSubstring)) {
        return true;
      }
      throw err; // Threw unexpected error
    }
  }

  // Helper to create a test user
  async function createTestUser(client, universityId, role = "student") {
    const email = `tenant_test_${Date.now()}_${crypto.randomBytes(4).toString("hex")}@campus.test`;
    const { rows } = await client.query(
      `INSERT INTO users (university_id, name, email, password_hash, role, verified, email_verified)
       VALUES ($1, 'Test User', $2, 'dummyhash', $3, true, true)
       RETURNING id, university_id`,
      [universityId, email, role]
    );
    return rows[0];
  }

  it("1. An INSERT with the correct tenant succeeds", async () => {
    await withTx(async (client) => {
      const user = await createTestUser(client, uniA);
      const { rows } = await client.query(
        `INSERT INTO payout_accounts (university_id, owner_id, method, account_name, account_number)
         VALUES ($1, $2, 'cbe', 'Correct Tenant User', '1000111122223')
         RETURNING id, university_id`,
        [uniA, user.id]
      );
      assert.strictEqual(rows[0].university_id, uniA, "Explicit matching tenant was not retained");
    });
  });

  it("2. An INSERT with a conflicting explicit tenant fails", async () => {
    await withTx(async (client) => {
      const user = await createTestUser(client, uniA);
      const threw = await expectDbError(
        client,
        async () => {
          await client.query(
            `INSERT INTO payout_accounts (university_id, owner_id, method, account_name, account_number)
             VALUES ($1, $2, 'cbe', 'Mismatched Tenant User', '1000111122223')`,
            [uniB, user.id] // User is in uniA, explicit university is uniB
          );
        },
        "TENANT_MISMATCH"
      );
      assert.ok(threw, "Expected INSERT with conflicting tenant to be rejected with TENANT_MISMATCH");
    });
  });

  it("3. An INSERT that omits the tenant derives it correctly when derivation is possible", async () => {
    await withTx(async (client) => {
      const user = await createTestUser(client, uniA);
      const { rows } = await client.query(
        `INSERT INTO payout_accounts (owner_id, method, account_name, account_number)
         VALUES ($1, 'telebirr', 'Derived Tenant User', '0911223344')
         RETURNING id, university_id`,
        [user.id] // university_id omitted
      );
      assert.strictEqual(rows[0].university_id, uniA, "Trigger did not derive university_id from owner user");
    });
  });

  it("4. An UPDATE attempting to change university_id fails", async () => {
    await withTx(async (client) => {
      const user = await createTestUser(client, uniA);
      const { rows } = await client.query(
        `INSERT INTO payout_accounts (owner_id, method, account_name, account_number)
         VALUES ($1, 'cbe', 'Immutable Test', '1000999988887')
         RETURNING id, university_id`,
        [user.id]
      );
      const accountId = rows[0].id;

      const threw = await expectDbError(
        client,
        async () => {
          await client.query(
            "UPDATE payout_accounts SET university_id = $1 WHERE id = $2",
            [uniB, accountId]
          );
        },
        "TENANT_IMMUTABLE"
      );
      assert.ok(threw, "Expected UPDATE changing university_id to be rejected with TENANT_IMMUTABLE");
    });
  });

  it("5. Updating unrelated fields on an existing record still succeeds", async () => {
    await withTx(async (client) => {
      const user = await createTestUser(client, uniA);
      const { rows } = await client.query(
        `INSERT INTO payout_accounts (owner_id, method, account_name, account_number)
         VALUES ($1, 'cbe', 'Initial Account Name', '1000999988887')
         RETURNING id, university_id`,
        [user.id]
      );
      const accountId = rows[0].id;

      const { rows: updatedRows } = await client.query(
        `UPDATE payout_accounts SET account_name = 'Updated Account Name', instructions = 'Call before sending'
         WHERE id = $1 RETURNING id, account_name, instructions, university_id`,
        [accountId]
      );
      assert.strictEqual(updatedRows[0].account_name, "Updated Account Name");
      assert.strictEqual(updatedRows[0].instructions, "Call before sending");
      assert.strictEqual(updatedRows[0].university_id, uniA, "university_id should remain unchanged");
    });
  });

  it("6. Tickets cannot be assigned to a university different from their event", async () => {
    await withTx(async (client) => {
      const user = await createTestUser(client, uniA);
      const { rows: clubRows } = await client.query(
        "INSERT INTO clubs (university_id, name, lead_user_id) VALUES ($1, 'Tenant Club A', $2) RETURNING id",
        [uniA, user.id]
      );
      const { rows: eventRows } = await client.query(
        "INSERT INTO events (club_id, title, date_time, capacity) VALUES ($1, 'Tenant Event A', now() + interval '3 days', 100) RETURNING id",
        [clubRows[0].id]
      );
      const { rows: ttRows } = await client.query(
        "INSERT INTO ticket_types (event_id, name, price, quantity_total) VALUES ($1, 'Standard', 50, 100) RETURNING id",
        [eventRows[0].id]
      );

      // Attempt explicit mismatched university on ticket
      const threw = await expectDbError(
        client,
        async () => {
          await client.query(
            `INSERT INTO tickets (university_id, event_id, ticket_type_id, holder_id, qr_token_hash)
             VALUES ($1, $2, $3, $4, $5)`,
            [uniB, eventRows[0].id, ttRows[0].id, user.id, `qr_spoof_${Date.now()}`]
          );
        },
        "TENANT_MISMATCH"
      );
      assert.ok(threw, "Expected ticket insertion with mismatched event tenant to fail with TENANT_MISMATCH");

      // Successful insertion with omitted tenant
      const { rows: ticketRows } = await client.query(
        `INSERT INTO tickets (event_id, ticket_type_id, holder_id, qr_token_hash)
         VALUES ($1, $2, $3, $4) RETURNING id, university_id`,
        [eventRows[0].id, ttRows[0].id, user.id, `qr_valid_${Date.now()}`]
      );
      assert.strictEqual(ticketRows[0].university_id, uniA, "Ticket did not derive university_id from event");
    });
  });

  it("7. Rental bookings cannot be assigned to a university different from their rental item", async () => {
    await withTx(async (client) => {
      const owner = await createTestUser(client, uniA);
      const { rows: itemRows } = await client.query(
        `INSERT INTO rental_items (owner_id, title, price_per_day, available_from, available_to)
         VALUES ($1, 'Drill Tool', 25, now(), now() + interval '7 days') RETURNING id`,
        [owner.id]
      );

      // Attempt explicit mismatched university on rental booking
      const threw = await expectDbError(
        client,
        async () => {
          await client.query(
            `INSERT INTO rental_bookings (university_id, rental_item_id, borrower_id, start_date, end_date, total_amount)
             VALUES ($1, $2, $3, CURRENT_DATE, CURRENT_DATE + 2, 50)`,
            [uniB, itemRows[0].id, owner.id]
          );
        },
        "TENANT_MISMATCH"
      );
      assert.ok(threw, "Expected rental booking with mismatched item tenant to fail with TENANT_MISMATCH");

      // Successful insertion with omitted tenant
      const { rows: bookingRows } = await client.query(
        `INSERT INTO rental_bookings (rental_item_id, borrower_id, start_date, end_date, total_amount)
         VALUES ($1, $2, CURRENT_DATE, CURRENT_DATE + 2, 50) RETURNING id, university_id`,
        [itemRows[0].id, owner.id]
      );
      assert.strictEqual(bookingRows[0].university_id, uniA, "Rental booking did not derive university_id from rental item");
    });
  });

  it("8. Reviews cannot claim a different tenant from their reviewed resource", async () => {
    await withTx(async (client) => {
      const merchant = await createTestUser(client, uniA, "merchant");
      const { rows: storeRows } = await client.query(
        "INSERT INTO stores (merchant_id, name) VALUES ($1, 'Store Uni A') RETURNING id",
        [merchant.id]
      );

      // Attempt explicit mismatched university on review
      const threw = await expectDbError(
        client,
        async () => {
          await client.query(
            `INSERT INTO reviews (university_id, author_id, target_type, target_id, rating, comment)
             VALUES ($1, $2, 'store', $3, 5, 'Fake cross-tenant review')`,
            [uniB, merchant.id, storeRows[0].id]
          );
        },
        "TENANT_MISMATCH"
      );
      assert.ok(threw, "Expected review with mismatched resource tenant to fail with TENANT_MISMATCH");

      // Successful insertion with omitted tenant
      const { rows: reviewRows } = await client.query(
        `INSERT INTO reviews (author_id, target_type, target_id, rating, comment)
         VALUES ($1, 'store', $2, 5, 'Genuine tenant review') RETURNING id, university_id`,
        [merchant.id, storeRows[0].id]
      );
      assert.strictEqual(reviewRows[0].university_id, uniA, "Review did not derive university_id from reviewed store");
    });
  });

  it("9. Payment and payout ownership cannot be spoofed", async () => {
    await withTx(async (client) => {
      const merchant = await createTestUser(client, uniA, "merchant");
      const buyer = await createTestUser(client, uniA, "student");
      const { rows: storeRows } = await client.query(
        "INSERT INTO stores (merchant_id, name) VALUES ($1, 'Store For Payment') RETURNING id",
        [merchant.id]
      );
      const { rows: orderRows } = await client.query(
        "INSERT INTO orders (store_id, buyer_id, total_amount) VALUES ($1, $2, 200) RETURNING id",
        [storeRows[0].id, buyer.id]
      );

      // 9a: Payment spoofing rejected
      const paymentSpoofThrew = await expectDbError(
        client,
        async () => {
          await client.query(
            `INSERT INTO payments (university_id, transaction_type, transaction_id, provider, amount, payer_id)
             VALUES ($1, 'order', $2, 'mock', 200, $3)`,
            [uniB, orderRows[0].id, buyer.id]
          );
        },
        "TENANT_MISMATCH"
      );
      assert.ok(paymentSpoofThrew, "Expected payment spoofing to fail with TENANT_MISMATCH");

      // 9b: Valid payment succeeds and derives correct tenant
      const { rows: paymentRows } = await client.query(
        `INSERT INTO payments (transaction_type, transaction_id, provider, amount, payer_id)
         VALUES ('order', $1, 'mock', 200, $2) RETURNING id, university_id`,
        [orderRows[0].id, buyer.id]
      );
      assert.strictEqual(paymentRows[0].university_id, uniA, "Payment did not derive university_id from parent order");

      // 9c: Payment proof spoofing rejected
      const proofSpoofThrew = await expectDbError(
        client,
        async () => {
          await client.query(
            `INSERT INTO payment_proofs (university_id, payment_id, payer_id, payee_id, file_name, image_sha256, reference_number)
             VALUES ($1, $2, $3, $4, 'proof.jpg', 'sha256dummy', 'REF12345')`,
            [uniB, paymentRows[0].id, buyer.id, merchant.id]
          );
        },
        "TENANT_MISMATCH"
      );
      assert.ok(proofSpoofThrew, "Expected payment proof spoofing to fail with TENANT_MISMATCH");
    });
  });

  it("10. Unresolved backfill conflicts cause safe failure rather than incorrect reassignment", async () => {
    await withTx(async (client) => {
      const user = await createTestUser(client, uniA);
      const { rows: clubRows } = await client.query(
        "INSERT INTO clubs (university_id, name, lead_user_id) VALUES ($1, 'Conflict Club', $2) RETURNING id",
        [uniA, user.id]
      );
      const { rows: eventRows } = await client.query(
        "INSERT INTO events (club_id, title, date_time, capacity) VALUES ($1, 'Conflict Event', now() + interval '5 days', 50) RETURNING id",
        [clubRows[0].id]
      );
      const { rows: ttRows } = await client.query(
        "INSERT INTO ticket_types (event_id, name, price, quantity_total) VALUES ($1, 'Conflict TT', 20, 50) RETURNING id",
        [eventRows[0].id]
      );

      // Temporarily disable trigger to fabricate an existing inconsistent ticket row
      await client.query("ALTER TABLE tickets DISABLE TRIGGER trg_tickets_tenant");
      await client.query(
        `INSERT INTO tickets (university_id, event_id, ticket_type_id, holder_id, qr_token_hash)
         VALUES ($1, $2, $3, $4, 'qr_conflict_test')`,
        [uniB, eventRows[0].id, ttRows[0].id, user.id]
      );
      await client.query("ALTER TABLE tickets ENABLE TRIGGER trg_tickets_tenant");

      // Assert that running the conflict detection block detects this inconsistency and aborts
      const conflictDetected = await expectDbError(
        client,
        async () => {
          await client.query(`
            DO $$
            DECLARE conflict_count INT;
            BEGIN
              SELECT count(*) INTO conflict_count
                FROM tickets t
                JOIN events e ON e.id = t.event_id
               WHERE t.university_id IS NOT NULL
                 AND e.university_id IS NOT NULL
                 AND t.university_id <> e.university_id;
              IF conflict_count > 0 THEN
                RAISE EXCEPTION 'BACKFILL_CONFLICT: % tickets have university_id conflicting with event', conflict_count;
              END IF;
            END $$;
          `);
        },
        "BACKFILL_CONFLICT"
      );
      assert.ok(conflictDetected, "Migration conflict detector must raise BACKFILL_CONFLICT upon detecting mismatched ownership");
    });
  });

  it("11. An UPDATE attempting to change parent reference to another university is rejected", async () => {
    await withTx(async (client) => {
      // 1. Entities in Uni A
      const userA = await createTestUser(client, uniA);
      const { rows: clubA } = await client.query(
        "INSERT INTO clubs (university_id, name, lead_user_id) VALUES ($1, 'Club A', $2) RETURNING id",
        [uniA, userA.id]
      );
      const { rows: evA1 } = await client.query(
        "INSERT INTO events (club_id, title, date_time, capacity) VALUES ($1, 'Event A1', now() + interval '2 days', 50) RETURNING id",
        [clubA[0].id]
      );
      const { rows: evA2 } = await client.query(
        "INSERT INTO events (club_id, title, date_time, capacity) VALUES ($1, 'Event A2', now() + interval '3 days', 50) RETURNING id",
        [clubA[0].id]
      );
      const { rows: ttA1 } = await client.query(
        "INSERT INTO ticket_types (event_id, name, price, quantity_total) VALUES ($1, 'Type A1', 10, 50) RETURNING id",
        [evA1[0].id]
      );
      const { rows: ticketA } = await client.query(
        "INSERT INTO tickets (event_id, ticket_type_id, holder_id, qr_token_hash) VALUES ($1, $2, $3, 'qr_parent_test') RETURNING id, university_id, event_id",
        [evA1[0].id, ttA1[0].id, userA.id]
      );
      const ticketId = ticketA[0].id;

      // 2. Event in Uni B
      const userB = await createTestUser(client, uniB);
      const { rows: clubB } = await client.query(
        "INSERT INTO clubs (university_id, name, lead_user_id) VALUES ($1, 'Club B', $2) RETURNING id",
        [uniB, userB.id]
      );
      const { rows: evB } = await client.query(
        "INSERT INTO events (club_id, title, date_time, capacity) VALUES ($1, 'Event B', now() + interval '2 days', 50) RETURNING id",
        [clubB[0].id]
      );

      // 11a: Attempt to update ticket's event_id from evA1 (Uni A) to evB (Uni B) -> MUST FAIL
      const ticketMoveThrew = await expectDbError(
        client,
        async () => {
          await client.query(
            "UPDATE tickets SET event_id = $1 WHERE id = $2",
            [evB[0].id, ticketId]
          );
        },
        "TENANT_MISMATCH"
      );
      assert.ok(ticketMoveThrew, "Expected cross-tenant event_id reassignment on ticket to be rejected with TENANT_MISMATCH");

      // 11b: Attempt to update ticket's event_id within the SAME university (evA1 -> evA2) -> MUST SUCCEED
      const { rows: updatedSameTenant } = await client.query(
        "UPDATE tickets SET event_id = $1 WHERE id = $2 RETURNING id, university_id, event_id",
        [evA2[0].id, ticketId]
      );
      assert.strictEqual(updatedSameTenant[0].event_id, evA2[0].id);
      assert.strictEqual(updatedSameTenant[0].university_id, uniA);

      // 11c: Rental Booking parent item change test across universities
      const { rows: itemA } = await client.query(
        "INSERT INTO rental_items (owner_id, title, price_per_day, available_from, available_to) VALUES ($1, 'Item A', 10, now(), now() + interval '5 days') RETURNING id",
        [userA.id]
      );
      const { rows: itemB } = await client.query(
        "INSERT INTO rental_items (owner_id, title, price_per_day, available_from, available_to) VALUES ($1, 'Item B', 10, now(), now() + interval '5 days') RETURNING id",
        [userB.id]
      );
      const { rows: booking } = await client.query(
        "INSERT INTO rental_bookings (rental_item_id, borrower_id, start_date, end_date, total_amount) VALUES ($1, $2, CURRENT_DATE, CURRENT_DATE + 1, 10) RETURNING id, university_id",
        [itemA[0].id, userA.id]
      );
      const bookingMoveThrew = await expectDbError(
        client,
        async () => {
          await client.query(
            "UPDATE rental_bookings SET rental_item_id = $1 WHERE id = $2",
            [itemB[0].id, booking[0].id]
          );
        },
        "TENANT_MISMATCH"
      );
      assert.ok(bookingMoveThrew, "Expected cross-tenant rental_item_id reassignment on booking to be rejected with TENANT_MISMATCH");
    });
  });
});

