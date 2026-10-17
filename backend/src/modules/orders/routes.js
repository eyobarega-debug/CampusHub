const express = require("express");
const { z } = require("zod");
const db = require("../../db");
const { requireAuth, requireRole } = require("../../middleware/auth");
const { validate } = require("../../middleware/validate");
const { scopeTo, assertSameTenant } = require("../../middleware/tenant");
const { asyncHandler, badRequest, notFound, forbidden, conflict } = require("../../utils/errors");
const { notify, audit } = require("../../utils/notify");
const payments = require("../../services/payments");
const orderStatus = require("../../services/orderStatus");

const router = express.Router();

const idParams = validate({ params: z.object({ id: z.string().uuid() }) });

// One query shape for list + detail: order + store + merchant + buyer + the LATEST payment for the order
// (and, for manual payments, why the seller rejected the last proof).
const ORDER_SELECT = `
  SELECT o.*, s.name AS store_name, s.description AS store_description, s.logo_url AS store_logo_url,
         s.merchant_id, m.name AS merchant_name, u.name AS buyer_name,
         lp.id AS payment_id, lp.status AS payment_status, lp.provider AS payment_provider,
         lp.amount AS payment_amount, lp.confirmed_at AS payment_confirmed_at,
         lp.reject_reason AS payment_reject_reason
    FROM orders o
    JOIN stores s ON s.id = o.store_id
    JOIN users m ON m.id = s.merchant_id
    JOIN users u ON u.id = o.buyer_id
    LEFT JOIN LATERAL (
      SELECT p.id, p.status, p.provider, p.amount, p.confirmed_at,
             (SELECT pp.reject_reason FROM payment_proofs pp
               WHERE pp.payment_id = p.id AND pp.status = 'rejected' ORDER BY pp.created_at DESC LIMIT 1) AS reject_reason
        FROM payments p WHERE p.transaction_type = 'order' AND p.transaction_id = o.id
       ORDER BY p.created_at DESC LIMIT 1
    ) lp ON true`;

// Adds the friendly status name and what THIS caller may do next. The backend enforces it again on PATCH.
function present(order, user) {
  return {
    ...order,
    display: orderStatus.display(order.status),
    allowedTransitions: orderStatus.manualTargets(user.role, order.status),
  };
}

// Loads one order the caller is allowed to see. Anything else is a 404 (never reveals that it exists).
async function loadOrder(req, id) {
  const { rows } = await db.query(`${ORDER_SELECT} WHERE o.id = $1`, [id]);
  const order = rows[0];
  if (!order) throw notFound("Order not found");
  assertSameTenant(req, order.university_id, "Order");
  const { user } = req;
  if (!["student", "merchant", "admin", "super_admin"].includes(user.role)) throw forbidden();
  if (user.role === "student" && order.buyer_id !== user.id) throw notFound("Order not found");
  if (user.role === "merchant" && order.merchant_id !== user.id) throw notFound("Order not found");
  return order;
}

// FR-008 — place order. Stock is decremented immediately as a "hold"; if
// payment fails, FR-051 releases it back (see the 'onFailed' finalizer below).
router.post(
  "/",
  requireAuth(),
  requireRole("student"),
  validate({
    body: z.object({
      items: z.array(z.object({ productId: z.string().uuid(), quantity: z.number().int().positive() })).min(1),
      paymentMethod: z.enum(["online", "manual"]).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    if (!req.user.verified) throw forbidden("Verify your student account before purchasing");

    const result = await db.withTransaction(async (client) => {
      let storeId = null;
      let total = 0;
      const lineItems = [];

      for (const item of req.body.items) {
        const { rows } = await client.query("SELECT * FROM products WHERE id = $1 AND status <> 'removed' FOR UPDATE", [
          item.productId,
        ]);
        const product = rows[0];
        if (!product) throw notFound(`Product ${item.productId} not found`);
        const { rows: st } = await client.query("SELECT university_id FROM stores WHERE id = $1", [product.store_id]);
        if (st[0].university_id !== req.user.university_id) throw notFound(`Product ${item.productId} not found`);
        if (storeId && product.store_id !== storeId) {
          throw badRequest("All items in one order must be from the same store (create separate orders otherwise)");
        }
        storeId = product.store_id;
        if (product.stock < item.quantity) {
          throw conflict(`"${product.title}" only has ${product.stock} left in stock`, "OUT_OF_STOCK");
        }
        await client.query("UPDATE products SET stock = stock - $1, status = CASE WHEN stock - $1 <= 0 THEN 'out_of_stock' ELSE status END WHERE id = $2", [
          item.quantity,
          product.id,
        ]);
        total += Number(product.price) * item.quantity;
        lineItems.push({ product, quantity: item.quantity });
      }

      const { rows: orderRows } = await client.query(
        "INSERT INTO orders (buyer_id, store_id, status, total_amount) VALUES ($1,$2,'pending_payment',$3) RETURNING *",
        [req.user.id, storeId, total]
      );
      const order = orderRows[0];

      for (const li of lineItems) {
        await client.query("INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES ($1,$2,$3,$4)", [
          order.id,
          li.product.id,
          li.quantity,
          li.product.price,
        ]);
      }

      // Status tracking: the order's history starts here, in the same transaction as the order itself.
      await orderStatus.recordInitial(client, order, req.user.id);
      return order;
    });

    const payment = await payments.initiatePayment({
      transactionType: "order",
      transactionId: result.id,
      amount: result.total_amount,
      buyerId: req.user.id,
      method: req.body.paymentMethod,
    });

    res.status(201).json({ order: present(result, req.user), payment });
  })
);

// FR-009 — order history / tracking.
//   student  -> their own orders      merchant -> orders of their store
//   admin    -> every order of THEIR university (super_admin: all, or one via X-University-Id)
router.get(
  "/",
  requireAuth(),
  validate({
    query: z.object({
      status: z.enum(orderStatus.STATUSES).optional(),
      page: z.coerce.number().int().min(1).default(1),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { status, page } = req.query;
    const limit = 20;
    const offset = (page - 1) * limit;
    const params = [];
    const conditions = [];

    if (req.user.role === "student") {
      params.push(req.user.id);
      conditions.push(`o.buyer_id = $${params.length}`);
    } else if (req.user.role === "merchant") {
      const { rows } = await db.query("SELECT id FROM stores WHERE merchant_id = $1", [req.user.id]);
      if (!rows[0]) return res.json({ orders: [] });
      params.push(rows[0].id);
      conditions.push(`o.store_id = $${params.length}`);
    } else if (!["admin", "super_admin"].includes(req.user.role)) {
      return res.json({ orders: [] }); // organizers have no orders
    }
    scopeTo(req, "o.university_id", conditions, params); // tenant isolation, whatever the role

    if (status) {
      params.push(status);
      conditions.push(`o.status = $${params.length}`);
    }
    params.push(limit, offset);

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await db.query(
      `${ORDER_SELECT} ${where} ORDER BY o.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ orders: rows.map((o) => present(o, req.user)) });
  })
);

// Order details: order, items, store/merchant, payment, status history, and what the caller can do next.
router.get(
  "/:id",
  requireAuth(),
  idParams,
  asyncHandler(async (req, res) => {
    const order = await loadOrder(req, req.params.id);
    const [items, history] = await Promise.all([
      db.query(
        `SELECT oi.*, p.title FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1 ORDER BY p.title`,
        [order.id]
      ),
      orderStatus.getHistory(db, order.id),
    ]);

    res.json({
      order: present(order, req.user),
      items: items.rows,
      history,
      store: {
        id: order.store_id,
        name: order.store_name,
        description: order.store_description,
        logoUrl: order.store_logo_url,
        merchantName: order.merchant_name,
      },
      payment: order.payment_id
        ? {
            id: order.payment_id,
            status: order.payment_status,
            provider: order.payment_provider,
            amount: Number(order.payment_amount),
            confirmedAt: order.payment_confirmed_at,
            rejectReason: order.payment_reject_reason,
          }
        : null,
      // Refunds go through the existing admin-only payment refund; the order follows automatically.
      canRefund:
        req.user.role === "admin" &&
        order.payment_status === "confirmed" &&
        orderStatus.REFUNDABLE.includes(order.status),
    });
  })
);

// Lightweight status poll.
router.get(
  "/:id/status",
  requireAuth(),
  idParams,
  asyncHandler(async (req, res) => {
    const order = await loadOrder(req, req.params.id);
    res.json({
      orderId: order.id,
      status: order.status,
      display: orderStatus.display(order.status),
      updatedAt: order.updated_at,
      paymentStatus: order.payment_status || null,
      allowedTransitions: orderStatus.manualTargets(req.user.role, order.status),
    });
  })
);

router.get(
  "/:id/history",
  requireAuth(),
  idParams,
  asyncHandler(async (req, res) => {
    const order = await loadOrder(req, req.params.id);
    res.json({ orderId: order.id, history: await orderStatus.getHistory(db, order.id) });
  })
);

// FR-036 — merchant (or admin) advances an order: paid -> ready for pickup -> completed.
// "Paid" and "Refunded" are NOT set here: they follow the payment (confirmation / admin refund).
router.patch(
  "/:id/status",
  requireAuth(),
  requireRole("merchant", "admin", "super_admin"),
  idParams,
  validate({ body: z.object({ status: z.enum(["ready", "completed"]), note: z.string().trim().max(500).optional() }) }),
  asyncHandler(async (req, res) => {
    const target = req.body.status;
    const { order, previous } = await db.withTransaction((client) =>
      orderStatus.transition(client, req.params.id, target, {
        actorId: req.user.id,
        note: req.body.note,
        guard: (o) => {
          assertSameTenant(req, o.university_id, "Order");
          if (req.user.role === "merchant" && o.merchant_id !== req.user.id) throw notFound("Order not found");
          if (!orderStatus.canTransition(o.status, target)) {
            throw conflict(`Cannot move order from ${o.status} to ${target}`, "INVALID_TRANSITION");
          }
          if (!orderStatus.manualTargets(req.user.role, o.status).includes(target)) {
            throw forbidden("You are not allowed to make this status change");
          }
        },
      })
    );

    try {
      await notify(order.buyer_id, "order_update", orderStatus.BUYER_MESSAGE[target], `Order #${orderStatus.shortId(order.id)}`);
    } catch (err) {
      console.warn("[orders] status notification failed (non-fatal):", err.message); // the status change already committed
    }
    res.json({ order: present(order, req.user), previousStatus: previous });
  })
);

// FR-011 — buyer/merchant-driven cancellation
router.post(
  "/:id/cancel",
  requireAuth(),
  idParams,
  validate({ body: z.object({ reason: z.string().optional() }) }),
  asyncHandler(async (req, res) => {
    const result = await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        "SELECT o.*, s.merchant_id FROM orders o JOIN stores s ON s.id=o.store_id WHERE o.id=$1 FOR UPDATE OF o",
        [req.params.id]
      );
      const order = rows[0];
      if (!order) throw notFound("Order not found");
      assertSameTenant(req, order.university_id, "Order");

      const isBuyer = req.user.role === "student" && order.buyer_id === req.user.id;
      const isMerchant = req.user.role === "merchant" && order.merchant_id === req.user.id;
      const isAdmin = ["admin", "super_admin"].includes(req.user.role);
      if (!isBuyer && !isMerchant && !isAdmin) throw forbidden();

      if (["completed", "cancelled", "refunded"].includes(order.status)) {
        throw conflict("This order can no longer be cancelled (already handed over, completed or refunded)");
      }

      // Merchant/admin cancels immediately; buyer request needs merchant/admin approval
      // unless the order is still unpaid, in which case it can be cancelled outright.
      const finalStatus = isBuyer && order.status !== "pending_payment" ? "cancellation_requested" : "cancelled";
      if (finalStatus === "cancellation_requested" && order.status === "cancellation_requested") return order; // already asked

      const { order: updated } = await orderStatus.transition(client, order.id, finalStatus, {
        actorId: req.user.id,
        note: req.body.reason || null,
        cancelReason: req.body.reason || null,
      });
      if (finalStatus === "cancelled") await orderStatus.releaseStock(client, order.id);
      return updated;
    });

    res.json({ order: present(result, req.user) });
  })
);

// Buyer confirmation: student confirms receiving the physical material when delivered or collected
router.post(
  "/:id/confirm-receipt",
  requireAuth(),
  requireRole("student"),
  idParams,
  asyncHandler(async (req, res) => {
    const result = await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        "SELECT o.*, s.merchant_id FROM orders o JOIN stores s ON s.id=o.store_id WHERE o.id=$1 FOR UPDATE OF o",
        [req.params.id]
      );
      const order = rows[0];
      if (!order) throw notFound("Order not found");
      assertSameTenant(req, order.university_id, "Order");
      if (order.buyer_id !== req.user.id) throw forbidden("Only the buyer can confirm receiving this order");
      if (!["confirmed", "ready"].includes(order.status)) {
        throw conflict(`Order cannot be confirmed as received while in status "${order.status}"`, "INVALID_STATUS");
      }
      await client.query("UPDATE orders SET buyer_confirmed_at = now() WHERE id = $1", [order.id]);
      const { order: updated } = await orderStatus.transition(client, order.id, "completed", {
        actorId: req.user.id,
        note: "Buyer confirmed material receipt",
      });
      return updated;
    });

    await audit(req.user.id, "order.buyer_confirmed", "order", result.id, {
      orderId: result.id, buyerConfirmedAt: new Date().toISOString(),
    });
    try {
      await notify(
        result.merchant_id,
        "order_update",
        "Material receipt confirmed",
        `The buyer confirmed receiving Order #${orderStatus.shortId(result.id)}.`
      );
    } catch (err) {
      console.warn("[orders] receipt notification failed (non-fatal):", err.message);
    }
    res.json({ order: present(result, req.user) });
  })
);

// --- Payment finalizers registered with the abstraction layer (SRS Section 16) ---
// The payment layer calls these inside ITS transaction, so the order status, its history row and the
// payment/commission records commit (or roll back) together.
payments.registerFinalizer("order", {
  isOpen: async (orderId, client) => {
    const { rows } = await client.query("SELECT status FROM orders WHERE id = $1", [orderId]);
    return rows[0]?.status === "pending_payment";
  },
  getRecipient: async (orderId) => {
    const { rows } = await db.query(
      `SELECT s.merchant_id, s.name, o.total_amount,
              (SELECT COALESCE(SUM(quantity),0) FROM order_items WHERE order_id = o.id) AS items
         FROM orders o JOIN stores s ON s.id = o.store_id WHERE o.id = $1`,
      [orderId]
    );
    if (!rows[0]) return null;
    return { userId: rows[0].merchant_id, description: `Order #${orderId.slice(0, 8)} from ${rows[0].name} (${rows[0].items} item(s))` };
  },
  // Merchant confirms payment receipt -> Pending becomes Paid.
  onConfirmed: async (orderId, client) => {
    await client.query("UPDATE orders SET merchant_confirmed_at = now() WHERE id = $1", [orderId]);
    const { order } = await orderStatus.transition(client, orderId, "confirmed", { actorId: null, note: "Merchant confirmed payment receipt" });
    await orderStatus.queueNotification(
      client, order.merchant_id, "New order received",
      `Order #${orderStatus.shortId(order.id)} — ${Number(order.total_amount).toFixed(2)} birr`
    );
    await orderStatus.queueNotification(
      client, order.buyer_id, "Payment confirmed",
      `${orderStatus.BUYER_MESSAGE.confirmed} (Order #${orderStatus.shortId(order.id)})`
    );
  },
  // Payment failed / expired -> cancel the unpaid order and give the stock back.
  onFailed: async (orderId, client) => {
    const { rows } = await client.query("SELECT status FROM orders WHERE id = $1 FOR UPDATE", [orderId]);
    if (!rows[0] || rows[0].status !== "pending_payment") return; // already cancelled/closed: nothing left to release
    const { order } = await orderStatus.transition(client, orderId, "cancelled", {
      actorId: null, note: "Payment failed", cancelReason: "payment_failed",
    });
    await orderStatus.releaseStock(client, orderId);
    await orderStatus.queueNotification(
      client, order.buyer_id, "Payment failed",
      `Your order #${orderStatus.shortId(order.id)} could not be paid for. Stock has been released.`
    );
  },
  // Full refund of the payment -> the order becomes Refunded and the stock goes back on sale.
  // Orders that are already completed or cancelled keep their status (only the payment is refunded).
  onRefunded: async (orderId, client, { reason, actorId } = {}) => {
    const { rows } = await client.query("SELECT status FROM orders WHERE id = $1 FOR UPDATE", [orderId]);
    if (!rows[0] || !orderStatus.REFUNDABLE.includes(rows[0].status)) return;
    const { order } = await orderStatus.transition(client, orderId, "refunded", {
      actorId, note: reason ? `Refunded: ${reason}` : "Payment refunded",
    });
    await orderStatus.releaseStock(client, orderId);
    await orderStatus.queueNotification(
      client, order.buyer_id, "Order refunded",
      `${orderStatus.BUYER_MESSAGE.refunded} (Order #${orderStatus.shortId(order.id)})`
    );
    await orderStatus.queueNotification(
      client, order.merchant_id, "Order refunded", `Order #${orderStatus.shortId(order.id)} was refunded.`
    );
  },
});

module.exports = router;