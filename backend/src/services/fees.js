// Per-university fee schedules (SRS Section 18). Falls back to the platform
// default row (university_id IS NULL), then to the Phase 1 env values.
const db = require("../db");

const ENV_DEFAULT = {
  commissionRate: Number(process.env.COMMISSION_RATE || 0.05),
  featuredRatePerDay: Number(process.env.FEATURED_RATE_PER_DAY || 20),
};

async function getFees(universityId, client = db) {
  const { rows } = await client.query(
    `SELECT commission_rate, featured_rate_per_day FROM fee_schedules
      WHERE (university_id = $1 OR university_id IS NULL) AND effective_from <= now()
      ORDER BY (university_id IS NOT NULL) DESC, effective_from DESC LIMIT 1`,
    [universityId || null]
  );
  if (!rows[0]) return ENV_DEFAULT;
  return {
    commissionRate: Number(rows[0].commission_rate),
    featuredRatePerDay: Number(rows[0].featured_rate_per_day),
  };
}

module.exports = { getFees, ENV_DEFAULT };
