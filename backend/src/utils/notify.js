const db = require("../db");

// Phase 2: notification type -> preference category, matching the 4 toggles
// exposed in Profile (FR-046). Types not listed here are treated as
// "mandatory" per FR-046's alt flow ("certain critical notifications ...
// remain mandatory and cannot be disabled") — e.g. merchant/report
// notifications, which aren't really optional the way "order updates" are.
const CATEGORY_BY_TYPE = {
  order_update: "orders",
  rental_update: "rentals",
  event_review: "events",
  ticket_update: "events",
};

// FR-045: create an in-app notification, and — Phase 2 — simulate an SMS
// send on the same channel logic as the Phase 1 "dev email" pattern: no
// real SMS provider is configured, so this logs what would have been sent
// instead of actually sending it. See backend README for exactly where a
// real provider (e.g., a local telco SMS gateway) would plug in — the
// `sendSms()` function below is the single call site to replace.
async function notify(userId, type, title, body) {
  await db.query(
    "INSERT INTO notifications (user_id, type, title, body) VALUES ($1,$2,$3,$4)",
    [userId, type, title, body]
  );

  const category = CATEGORY_BY_TYPE[type];
  try {
    const { rows } = await db.query("SELECT phone, notification_prefs FROM users WHERE id = $1", [userId]);
    const user = rows[0];
    if (!user || !user.phone) return;
    const mandatory = !category; // not in the map => always send, per FR-046
    const allowed = mandatory || user.notification_prefs?.[category] !== false;
    if (allowed) sendSms(user.phone, `${title}${body ? " — " + body : ""}`);
  } catch (err) {
    // Never let a notification-preference lookup failure break the action
    // that triggered it (an order/booking/ticket must still succeed).
    console.warn("[notify] SMS dispatch check failed (non-fatal):", err.message);
  }
}

function sendSms(phone, message) {
  // Replace this with a real SMS gateway call in Phase 2 production
  // rollout (SRS Section 19: "SMS option"). Truncated to a typical SMS
  // length to keep the simulation realistic.
  const truncated = message.length > 160 ? message.slice(0, 157) + "..." : message;
  console.log(`[DEV SMS] -> ${phone}: ${truncated}`);
}

// Section 15: sensitive administrative / ticket-verification actions are
// written to an append-only audit log.
async function audit(actorId, action, targetType, targetId, details) {
  await db.query(
    "INSERT INTO audit_logs (actor_id, action, target_type, target_id, details) VALUES ($1,$2,$3,$4,$5)",
    [actorId || null, action, targetType || null, targetId || null, details ? JSON.stringify(details) : null]
  );
}

module.exports = { notify, audit, sendSms };
