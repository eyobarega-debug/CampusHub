require("dotenv").config({ quiet: true });

function validateProductionConfig() {
  if (process.env.NODE_ENV !== "production") return;
  const secrets = ["JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET", "TICKET_QR_SECRET"];
  const weakValues = new Set([
    "change_me_to_a_long_random_string",
    "change_me_to_a_different_long_random_string",
    "change_me_to_another_long_random_string",
    "dev_access_secret_change_me",
    "dev_refresh_secret_change_me",
    "dev_ticket_qr_secret_change_me",
  ]);
  const invalid = secrets.filter((name) => {
    const value = process.env[name] || "";
    return value.length < 32 || weakValues.has(value);
  });
  const values = secrets.map((name) => process.env[name]);
  if (invalid.length || new Set(values).size !== values.length) {
    const problems = invalid.length ? invalid.join(", ") : secrets.join(", ");
    throw new Error(`Refusing to start in production: set strong, unique values for ${problems} (at least 32 characters each).`);
  }
  const origins = (process.env.CORS_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean);
  if (!origins.length || origins.some((origin) => {
    try {
      const parsed = new URL(origin);
      return parsed.protocol !== "https:" || parsed.origin !== origin;
    } catch {
      return true;
    }
  })) {
    throw new Error("Refusing to start in production: set CORS_ORIGINS to exact HTTPS frontend origins.");
  }
}

validateProductionConfig();
const app = require("./app");

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
