const app = require("./app");
require("dotenv").config({ quiet: true });

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  // Manual payments with no proof uploaded inside their window are failed and
// their stock / seat / dates released. Skipped under test so scripts stay deterministic.
if (process.env.NODE_ENV !== "test") {
  const { expireStaleManualPayments } = require("./services/payments");
  const sweep = () =>
    expireStaleManualPayments()
      .then((n) => n && console.log(`[payments] expired ${n} unpaid manual payment(s)`))
      .catch((err) => console.error("[payments] expiry sweep failed:", err.message));
  setInterval(sweep, 10 * 60 * 1000).unref();
  sweep();
}
  console.log(`CampusHub API listening on http://localhost:${PORT}`);
});
