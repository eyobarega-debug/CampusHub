const express = require("express");
const { z } = require("zod");
const db = require("../../db");
const { requireAuth, requireRole } = require("../../middleware/auth");
const { validate } = require("../../middleware/validate");
const { asyncHandler, badRequest, notFound, forbidden, conflict } = require("../../utils/errors");
const { notify } = require("../../utils/notify");
const payments = require("../../services/payments");

const router = express.Router();

// FR-008 — place order. Stock is decremented immediately as a "hold"; if
// payment fails, FR-051 releases it back (see the 'onFailed' finalizer below).
router.post(
  "/",
  requireAuth(),
  requireRole("student"),
  validate({
    body: z.object({
      items: z.array(z.object({ productId: z.string().uuid(), quantity: z.number().int().positive() })).min(1),
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

      return order;
    });

    const payment = await payments.initiatePayment({
      transactionType: "order",
      transactionId: result.id,
      amount: result.total_amount,
      buyerId: req.user.id,
    });

    res.status(201).json({ order: result, payment });
  })
);

// FR-009 — order history / tracking
router.get(
  "/",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const { status, page = "1" } = req.query;
    const limit = 20;
    const offset = (Math.max(1, Number(page)) - 1) * limit;
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
    } // admin sees all

    if (status) {
      params.push(status);
      conditions.push(`o.status = $${params.length}`);
    }
    params.push(limit, offset);

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await db.query(
      `SELECT o.*, s.name AS store_name, u.name AS buyer_name
       FROM orders o JOIN stores s ON s.id = o.store_id JOIN users u ON u.id = o.buyer_id
       ${where} ORDER BY o.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ orders: rows });
  })
);

router.get(
  "/:id",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT o.*, s.name AS store_name, s.merchant_id FROM orders o JOIN stores s ON s.id = o.store_id WHERE o.id = $1`,
      [req.params.id]
    );
    const order = rows[0];
    if (!order) throw notFound("Order not found");
    if (req.user.role === "student" && order.buyer_id !== req.user.id) throw forbidden();
    if (req.user.role === "merchant" && order.merchant_id !== req.user.id) throw forbidden();

    const items = await db.query(
      `SELECT oi.*, p.title FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1`,
      [req.params.id]
    );
    res.json({ order, items: items.rows });
  })
);

const VALID_TRANSITIONS = {
  confirmed: ["ready", "cancellation_requested"],
  ready: ["completed"],
};

// FR-036 — merchant advances order status
router.patch(
  "/:id/status",
  requireAuth(),
  requireRole("merchant", "admin"),
  validate({ body: z.object({ status: z.enum(["ready", "completed"]) }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query("SELECT o.*, s.merchant_id FROM orders o JOIN stores s ON s.id=o.store_id WHERE o.id=$1", [
      req.params.id,
    ]);
    const order = rows[0];
    if (!order) throw notFound("Order not found");
    if (req.user.role === "merchant" && order.merchant_id !== req.user.id) throw forbidden();

    const allowed = VALID_TRANSITIONS[order.status] || [];
    if (!allowed.includes(req.body.status)) {
      throw conflict(`Cannot move order from ${order.status} to ${req.body.status}`, "INVALID_TRANSITION");
    }
    const { rows: updated } = await db.query("UPDATE orders SET status=$1, updated_at=now() WHERE id=$2 RETURNING *", [
      req.body.status,
      order.id,
    ]);
    await notify(order.buyer_id, "order_update", `Your order is now "${req.body.status}"`, `Order #${order.id.slice(0, 8)}`);
    res.json({ order: updated[0] });
  })
);

// FR-011 — buyer/merchant-driven cancellation
router.post(
  "/:id/cancel",
  requireAuth(),
  validate({ body: z.object({ reason: z.string().optional() }) }),
  asyncHandler(async (req, res) => {
    const result = await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        "SELECT o.*, s.merchant_id FROM orders o JOIN stores s ON s.id=o.store_id WHERE o.id=$1 FOR UPDATE",
        [req.params.id]
      );
      const order = rows[0];
      if (!order) throw notFound("Order not found");

      const isBuyer = req.user.role === "student" && order.buyer_id === req.user.id;
      const isMerchant = req.user.role === "merchant" && order.merchant_id === req.user.id;
      const isAdmin = req.user.role === "admin";
      if (!isBuyer && !isMerchant && !isAdmin) throw forbidden();

      if (["completed", "cancelled"].includes(order.status)) {
        throw conflict("This order can no longer be cancelled (already shipped/handed over or completed)");
      }

      // Merchant/admin cancels immediately; buyer request needs merchant/admin approval
      // unless the order is still unpaid, in which case it can be cancelled outright.
      const finalStatus = isBuyer && order.status !== "pending_payment" ? "cancellation_requested" : "cancelled";

      await client.query("UPDATE orders SET status=$1, cancel_reason=$2, updated_at=now() WHERE id=$3", [
        finalStatus,
        req.body.reason || null,
        order.id,
      ]);

      if (finalStatus === "cancelled") {
        const items = await client.query("SELECT * FROM order_items WHERE order_id = $1", [order.id]);
        for (const item of items.rows) {
          await client.query("UPDATE products SET stock = stock + $1, status = 'active' WHERE id = $2", [
            item.quantity,
            item.product_id,
          ]);
        }
      }
      return { ...order, status: finalStatus };
    });

    res.json({ order: result });
  })
);

// --- Payment finalizers registered with the abstraction layer (SRS Section 16) ---
payments.registerFinalizer("order", {
  onConfirmed: async (orderId, client) => {
    const { rows } = await client.query("UPDATE orders SET status='confirmed', updated_at=now() WHERE id=$1 RETURNING *", [orderId]);
    const order = rows[0];
    const store = await client.query("SELECT merchant_id, name FROM stores WHERE id = $1", [order.store_id]);
    await client.query("INSERT INTO notifications (user_id, type, title, body) VALUES ($1,'order_update',$2,$3)", [
      store.rows[0].merchant_id,
      "New order received",
      `Order #${order.id.slice(0, 8)} — ${Number(order.total_amount).toFixed(2)} birr`,
    ]);
    await client.query("INSERT INTO notifications (user_id, type, title, body) VALUES ($1,'order_update',$2,$3)", [
      order.buyer_id,
      "Payment confirmed",
      `Your order #${order.id.slice(0, 8)} is confirmed.`,
    ]);
  },
  onFailed: async (orderId, client) => {
    const { rows } = await client.query("UPDATE orders SET status='cancelled', cancel_reason='payment_failed', updated_at=now() WHERE id=$1 RETURNING *", [orderId]);
    const order = rows[0];
    const items = await client.query("SELECT * FROM order_items WHERE order_id = $1", [orderId]);
    for (const item of items.rows) {
      await client.query("UPDATE products SET stock = stock + $1, status = 'active' WHERE id = $2", [item.quantity, item.product_id]);
    }
    await client.query("INSERT INTO notifications (user_id, type, title, body) VALUES ($1,'order_update',$2,$3)", [
      order.buyer_id,
      "Payment failed",
      `Your order #${order.id.slice(0, 8)} could not be paid for. Stock has been released.`,
    ]);
  },
});

module.exports = router;
