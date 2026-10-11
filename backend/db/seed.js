/* eslint-disable no-console */
require("dotenv").config({ quiet: true });
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  console.log("Seeding CampusHub demo data...");
  const pw = await bcrypt.hash("Password123!", 10);

  const { rows: uniRows } = await pool.query(
    `INSERT INTO universities (name, domain) VALUES ('Addis Ababa Science and Technology University', 'aastu.edu.et')
     RETURNING *`
  );
  const uni = uniRows[0];

  const cat = async (name) => {
    const { rows } = await pool.query("INSERT INTO categories (name) VALUES ($1) RETURNING *", [name]);
    return rows[0];
  };
  const catBooks = await cat("Books");
  const catElectronics = await cat("Electronics");
  const catStationery = await cat("Stationery");
  const catSports = await cat("Sports Equipment");

  const user = async (name, email, role, verified = true) => {
    const { rows } = await pool.query(
      `INSERT INTO users (university_id, name, email, phone, password_hash, role, verified, verification_method)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'domain') RETURNING *`,
      [uni.id, name, email, "+251900000000", pw, role, verified]
    );
    return rows[0];
  };

  const admin = await user("Admin Bekele", "admin@aastu.edu.et", "admin");
  // Phase 3: the Super Administrator is the only account that may have no university.
  await pool.query(
    `INSERT INTO users (university_id, name, email, phone, password_hash, role, verified, verification_method)
     VALUES (NULL,'Super Admin','super@campushub.et','+251900000001',$1,'super_admin',true,'seed')`,
    [pw]
  );
  const student1 = await user("Sara Tesfaye", "sara@aastu.edu.et", "student");
  const student2 = await user("Dawit Alemu", "dawit@aastu.edu.et", "student");
  const merchantUser = await user("Selam Kebede", "selam@aastu.edu.et", "merchant");
  const organizerUser = await user("Robel Girma", "robel@aastu.edu.et", "organizer");

  // Merchant application (already approved, for demo convenience) + store
  await pool.query(
    `INSERT INTO merchant_applications (user_id, business_name, category, status, decided_at)
     VALUES ($1,'Selam Campus Stationery','Stationery','approved', now())`,
    [merchantUser.id]
  );
  const { rows: storeRows } = await pool.query(
    "INSERT INTO stores (merchant_id, name, description) VALUES ($1,$2,$3) RETURNING *",
    [merchantUser.id, "Selam Campus Stationery", "Books, stationery, and printing services near Gate 2."]
  );
  const store = storeRows[0];

  const products = [
    ["Engineering Mathematics Textbook (3rd Ed.)", catBooks.id, 450, 12],
    ["Scientific Calculator (fx-991)", catElectronics.id, 950, 8],
    ["A4 Notebook (200 pages)", catStationery.id, 60, 100],
    ["USB Flash Drive 32GB", catElectronics.id, 350, 15],
  ];
  for (const [title, categoryId, price, stock] of products) {
    await pool.query(
      "INSERT INTO products (store_id, category_id, title, price, stock, status) VALUES ($1,$2,$3,$4,$5,'active')",
      [store.id, categoryId, title, price, stock]
    );
  }

  // P2P listing
  await pool.query(
    `INSERT INTO p2p_listings (seller_id, title, description, price, condition, category_id, status)
     VALUES ($1,'Used Physics Textbook','Good condition, some highlighting',180,'Good',$2,'active')`,
    [student1.id, catBooks.id]
  );

  // Rental item
  await pool.query(
    `INSERT INTO rental_items (owner_id, title, description, category_id, price_per_day, deposit, available_from, available_to, status)
     VALUES ($1,'Portable Projector','HD mini projector, HDMI + USB',$2,150,1000, CURRENT_DATE, CURRENT_DATE + INTERVAL '60 days','active')`,
    [student2.id, catElectronics.id]
  );

  // Club + event + ticket types
  const { rows: clubRows } = await pool.query(
    "INSERT INTO clubs (university_id, name, lead_user_id, status) VALUES ($1,$2,$3,'active') RETURNING *",
    [uni.id, "AASTU Tech Club", organizerUser.id]
  );
  const club = clubRows[0];

  const { rows: eventRows } = await pool.query(
    `INSERT INTO events (club_id, title, description, date_time, location, capacity, status)
     VALUES ($1,'Hackathon Kickoff Night','An evening of team formation, pizza, and project pitches.',
             now() + interval '14 days','Main Auditorium',150,'published') RETURNING *`,
    [club.id]
  );
  const event = eventRows[0];
  await pool.query("INSERT INTO ticket_types (event_id, name, price, quantity_total) VALUES ($1,'General',50,100)", [event.id]);
  await pool.query("INSERT INTO ticket_types (event_id, name, price, quantity_total) VALUES ($1,'VIP',150,20)", [event.id]);

  // A second, still-pending event to demo the approval workflow
  const { rows: event2Rows } = await pool.query(
    `INSERT INTO events (club_id, title, description, date_time, location, capacity, status)
     VALUES ($1,'Weekend Football Tournament','Inter-department 5-a-side tournament.',
             now() + interval '21 days','Sports Field',200,'pending_review') RETURNING *`,
    [club.id]
  );
  await pool.query("INSERT INTO ticket_types (event_id, name, price, quantity_total) VALUES ($1,'Entry',20,200)", [
    event2Rows[0].id,
  ]);

  console.log("\nSeed complete. Demo accounts (all use password: Password123!):");
  console.log(`  Admin:     ${admin.email}`);
  console.log("  Super:     super@campushub.et");
  console.log(`  Student:   ${student1.email}  (browse/buy/rent/tickets)`);
  console.log(`  Student:   ${student2.email}  (owns the rental item)`);
  console.log(`  Merchant:  ${merchantUser.email}  (already approved, has a store + products)`);
  console.log(`  Organizer: ${organizerUser.email}  (leads "AASTU Tech Club")`);
  console.log(`\nUniversity ID (for new registrations): ${uni.id}`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
