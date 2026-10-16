-- CampusHub — Order status tracking.
--
-- * orders.status already exists (TEXT). Existing values are KEPT so no existing code, test
--   or report breaks:
--       pending_payment | confirmed | ready | completed | cancellation_requested | cancelled
--   and ONE new value is added: refunded.
--   In the UI these are shown as Pending | Paid | Ready for pickup | Completed | ... | Refunded.
-- * New table order_status_history: one row per status change (who, when, from, to, note).
-- * Idempotent: safe to re-run. Run it AFTER 003-006.

BEGIN;

CREATE TABLE IF NOT EXISTS order_status_history (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  university_id  UUID REFERENCES universities(id),
  from_status    TEXT,                                   -- NULL for the first row of an order
  to_status      TEXT NOT NULL,
  changed_by     UUID REFERENCES users(id) ON DELETE SET NULL,  -- NULL = system (payment callback)
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT order_status_history_to_chk CHECK (to_status IN
    ('pending_payment','confirmed','ready','completed','cancellation_requested','cancelled','refunded')),
  CONSTRAINT order_status_history_from_chk CHECK (from_status IS NULL OR from_status IN
    ('pending_payment','confirmed','ready','completed','cancellation_requested','cancelled','refunded'))
);

CREATE INDEX IF NOT EXISTS idx_order_status_history_order      ON order_status_history(order_id, created_at);
CREATE INDEX IF NOT EXISTS idx_order_status_history_university ON order_status_history(university_id);
CREATE INDEX IF NOT EXISTS idx_order_status_history_changed_by ON order_status_history(changed_by);

-- Backfill: every existing order gets one history row describing the status it has today,
-- so the tracker is never empty for old orders. (Earlier transitions were never recorded.)
INSERT INTO order_status_history (order_id, university_id, from_status, to_status, note, created_at)
SELECT o.id, o.university_id, NULL, o.status, 'Recorded when status tracking was enabled',
       CASE WHEN o.status = 'pending_payment' THEN o.created_at ELSE COALESCE(o.updated_at, o.created_at) END
  FROM orders o
 WHERE NOT EXISTS (SELECT 1 FROM order_status_history h WHERE h.order_id = o.id);

-- Only known statuses may be stored on an order (adds 'refunded' to the allowed set).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_status_chk') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_status_chk CHECK (status IN
      ('pending_payment','confirmed','ready','completed','cancellation_requested','cancelled','refunded')) NOT VALID;
  END IF;
END $$;
ALTER TABLE orders VALIDATE CONSTRAINT orders_status_chk;

-- List screens: a student's orders newest-first, a store's orders by status.
CREATE INDEX IF NOT EXISTS idx_orders_buyer_created  ON orders(buyer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_store_status   ON orders(store_id, status, created_at DESC);

COMMIT;