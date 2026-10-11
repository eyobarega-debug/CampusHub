const { Pool } = require("pg");
require("dotenv").config({ quiet: true });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on("error", (err) => {
  // Idle client error — log and let the process supervisor restart if needed.
  console.error("Unexpected PG pool error", err);
});

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
  // Use for anything that needs more than one statement to be atomic
  // (stock decrement, ticket verification, refund bookkeeping, etc.)
  withTransaction: async (fn) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  },
};
