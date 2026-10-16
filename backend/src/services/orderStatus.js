// Centralised order-status rules. EVERY change to orders.status goes through transition(), so:
//   * the rules live in one place (the frontend is never trusted),
//   * the status change and its order_status_history row are written in the same DB transaction,
//   * stock is released in one place (cancel / payment failed / refund).
//
// Stored values are the ones CampusHub already used; the UI shows friendlier names:
//   pending_payment -> "Pending"      confirmed -> "Paid"        ready -> "Ready for pickup"
//   completed       -> "Completed"    refunded  -> "Refunded"    cancelled -> "Cancelled"
const { conflict, notFound } = require("../utils/errors");

const STATUSES = ["pending_payment", "confirmed", "ready", "completed", "cancellation_requested", "cancelled", "refunded"];

const DISPLAY = {
  pending_payment: { key: "pending", label: "Pending" },
  confirmed: { key: "paid", label: "Paid" },
  ready: { key: "ready_for_pickup", label: "Ready for pickup" },
  completed: { key: "completed", label: "Completed" },
  cancellation_requested: { key: "cancellation_requested", label: "Cancellation requested" },
  cancelled: { key: "cancelled", label: "Cancelled" },
  refunded: { key: "refunded", label: "Refunded" },
};

// The complete state machine. Terminal states (completed, cancelled, refunded) have no exits.
//   pending_payment -> confirmed     : only by the payment layer (mock success / manual approval)
//   pending_payment -> cancelled     : payment failed, or buyer/merchant cancelled before paying
//   confirmed|ready -> refunded      : only by the payment layer (admin refund)
//   ... -> cancellation_requested / cancelled : the existing FR-011 cancellation flow
const TRANSITIONS = {
  pending_payment: ["confirmed", "cancelled"],
  confirmed: ["ready", "refunded", "cancellation_requested", "cancelled"],
  ready: ["completed", "refunded", "cancellation_requested", "cancelled"],
  cancellation_requested: ["cancelled", "refunded"],
  completed: [],
  cancelled: [],
  refunded: [],
};

// Which of those transitions a person may trigger directly via PATCH /orders/:id/status.
// (Paid and Refunded are deliberately NOT here: they happen when a payment is confirmed / refunded,
// so the order, the payment and the commission ledger can never disagree.)
const MANUAL = {
  merchant: { confirmed: ["ready"], ready: ["completed"] },
  admin: { confirmed: ["ready"], ready: ["completed"] },
};
MANUAL.super_admin = MANUAL.admin;

const REFUNDABLE = ["confirmed", "ready", "cancellation_requested"];

const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);
const manualTargets = (role, status) => ((MANUAL[role] || {})[status] || []).filter((to) => canTransition(status, to));
const display = (status) => DISPLAY[status] || { key: status, label: status };

// Notification copy shown to the student when an important status is reached.
const BUYER_MESSAGE = {
  confirmed: "Your order has been paid.",
  ready: "Your order is ready for pickup.",
  completed: "Your order has been completed.",
  refunded: "Your order has been refunded.",
};

const shortId = (id) => String(id).slice(0, 8);

// Moves an order to `to` and records the change. Must run inside a transaction (pass the tx client).
//   opts.actorId     user who caused it (null = system / payment callback)
//   opts.note        optional free text stored on the history row
//   opts.cancelReason  stored in orders.cancel_reason (cancellation flow)
//   opts.guard(order)  called after the row is locked and before anything is written; throw to veto
async function transition(client, orderId, to, opts = {}) {
  const { rows } = await client.query(
    "SELECT o.*, s.merchant_id FROM orders o JOIN stores s ON s.id = o.store_id WHERE o.id = $1 FOR UPDATE OF o",
    [orderId]
  );
  const order = rows[0];
  if (!order) throw notFound("Order not found");
  if (opts.guard) await opts.guard(order);

  if (!canTransition(order.status, to)) {
    throw conflict(`Cannot move order from ${order.status} to ${to}`, "INVALID_TRANSITION");
  }

  const { rows: updated } = await client.query(
    `UPDATE orders SET status = $1, cancel_reason = COALESCE($3, cancel_reason), updated_at = now()
      WHERE id = $2 RETURNING *`,
    [to, orderId, opts.cancelReason || null]
  );
  await client.query(
    `INSERT INTO order_status_history (order_id, university_id, from_status, to_status, changed_by, note)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [orderId, order.university_id, order.status, to, opts.actorId || null, opts.note || null]
  );
  return { order: { ...updated[0], merchant_id: order.merchant_id }, previous: order.status };
}

// First history row for a brand-new order.
async function recordInitial(client, order, actorId) {
  await client.query(
    `INSERT INTO order_status_history (order_id, university_id, from_status, to_status, changed_by, note)
     VALUES ($1,$2,NULL,$3,$4,'Order placed')`,
    [order.id, order.university_id, order.status, actorId || null]
  );
}

// Gives the held stock back (same SQL the cancel / payment-failed paths always used).
async function releaseStock(client, orderId) {
  const items = await client.query("SELECT * FROM order_items WHERE order_id = $1", [orderId]);
  for (const item of items.rows) {
    await client.query("UPDATE products SET stock = stock + $1, status = 'active' WHERE id = $2", [item.quantity, item.product_id]);
  }
}

// In-transaction notification (same table/type the payment finalizers already write to).
async function queueNotification(client, userId, title, body) {
  await client.query("INSERT INTO notifications (user_id, type, title, body) VALUES ($1,'order_update',$2,$3)", [userId, title, body]);
}

async function getHistory(queryable, orderId) {
  const { rows } = await queryable.query(
    `SELECT h.id, h.from_status, h.to_status, h.note, h.created_at, h.changed_by,
            u.name AS changed_by_name, u.role AS changed_by_role
       FROM order_status_history h LEFT JOIN users u ON u.id = h.changed_by
      WHERE h.order_id = $1 ORDER BY h.created_at, h.id`,
    [orderId]
  );
  return rows.map((r) => ({
    id: r.id,
    fromStatus: r.from_status,
    toStatus: r.to_status,
    from: r.from_status ? display(r.from_status) : null,
    to: display(r.to_status),
    note: r.note,
    createdAt: r.created_at,
    changedBy: r.changed_by ? { id: r.changed_by, name: r.changed_by_name, role: r.changed_by_role } : null,
  }));
}

module.exports = {
  STATUSES, REFUNDABLE, BUYER_MESSAGE,
  canTransition, manualTargets, display, shortId,
  transition, recordInitial, releaseStock, queueNotification, getHistory,
};