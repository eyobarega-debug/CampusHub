-- CampusHub — Phase 2 <-> Phase 3 merge migration.
--
-- Brings the Phase 2 features (in-app P2P payment, tiered late fees, recurring
-- events, event waitlists) under the Phase 3 multi-university model.
--
--  * Fresh database:   db:migrate (schema.sql, already contains Phase 2) ->
--                      db:migrate:phase3 (003) -> db:migrate:phase2 (this file).
--  * Existing Phase 3 database that never had Phase 2: just run this file; it
--                      creates whatever Phase 2 structures are missing first.
--
-- Idempotent: re-running is a no-op. Run it AFTER 003.

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Phase 2 structures (no-ops when schema.sql already created them)
-- ---------------------------------------------------------------------
ALTER TABLE rental_items ADD COLUMN IF NOT EXISTS late_fee_policy JSONB;
ALTER TABLE events       ADD COLUMN IF NOT EXISTS recurrence_rule TEXT NOT NULL DEFAULT 'none';
ALTER TABLE events       ADD COLUMN IF NOT EXISTS parent_event_id UUID REFERENCES events(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS p2p_orders (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id  UUID NOT NULL REFERENCES p2p_listings(id) ON DELETE CASCADE,
  request_id  UUID NOT NULL UNIQUE REFERENCES p2p_requests(id) ON DELETE CASCADE,
  buyer_id    UUID NOT NULL REFERENCES users(id),
  seller_id   UUID NOT NULL REFERENCES users(id),
  amount      NUMERIC(12,2) NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending_payment', -- pending_payment | paid | cancelled
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS waitlist_entries (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  ticket_type_id UUID NOT NULL REFERENCES ticket_types(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES users(id),
  status         TEXT NOT NULL DEFAULT 'waiting', -- waiting | notified | expired
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  notified_at    TIMESTAMPTZ,
  UNIQUE (ticket_type_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_p2p_orders_buyer      ON p2p_orders(buyer_id);
CREATE INDEX IF NOT EXISTS idx_p2p_orders_seller     ON p2p_orders(seller_id);
CREATE INDEX IF NOT EXISTS idx_waitlist_ticket_type  ON waitlist_entries(ticket_type_id, status);

-- ---------------------------------------------------------------------
-- 2. Tenancy for the Phase 2 tables
-- ---------------------------------------------------------------------
ALTER TABLE p2p_orders       ADD COLUMN IF NOT EXISTS university_id UUID REFERENCES universities(id);
ALTER TABLE waitlist_entries ADD COLUMN IF NOT EXISTS university_id UUID REFERENCES universities(id);

UPDATE p2p_orders o       SET university_id = l.university_id FROM p2p_listings l WHERE o.listing_id = l.id AND o.university_id IS NULL;
UPDATE waitlist_entries w SET university_id = e.university_id FROM events e        WHERE w.event_id = e.id    AND w.university_id IS NULL;

UPDATE payments p SET university_id = po.university_id
  FROM p2p_orders po
 WHERE p.transaction_type = 'p2p_order' AND p.transaction_id = po.id AND p.university_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_p2p_orders_university ON p2p_orders(university_id);
CREATE INDEX IF NOT EXISTS idx_waitlist_university   ON waitlist_entries(university_id);

-- ---------------------------------------------------------------------
-- 3. Trigger: same function as 003 (now knows the Phase 2 tables / payment type)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cn_set_university_id() RETURNS trigger AS $$
DECLARE uid UUID;
BEGIN
  IF NEW.university_id IS NOT NULL THEN RETURN NEW; END IF;

  CASE TG_TABLE_NAME
    WHEN 'stores'                THEN SELECT university_id INTO uid FROM users  WHERE id = NEW.merchant_id;
    WHEN 'merchant_applications' THEN SELECT university_id INTO uid FROM users  WHERE id = NEW.user_id;
    WHEN 'p2p_listings'          THEN SELECT university_id INTO uid FROM users  WHERE id = NEW.seller_id;
    WHEN 'rental_items'          THEN SELECT university_id INTO uid FROM users  WHERE id = NEW.owner_id;
    WHEN 'reports'               THEN SELECT university_id INTO uid FROM users  WHERE id = NEW.reporter_id;
    WHEN 'audit_logs'            THEN SELECT university_id INTO uid FROM users  WHERE id = NEW.actor_id;
    WHEN 'orders'                THEN SELECT university_id INTO uid FROM stores WHERE id = NEW.store_id;
    -- Phase 2 tables (merged into the same schema):
    WHEN 'p2p_orders'            THEN SELECT university_id INTO uid FROM p2p_listings WHERE id = NEW.listing_id;
    WHEN 'waitlist_entries'      THEN SELECT university_id INTO uid FROM events WHERE id = NEW.event_id;
    WHEN 'events'                THEN SELECT university_id INTO uid FROM clubs  WHERE id = NEW.club_id;
    WHEN 'disputes'              THEN SELECT ri.university_id INTO uid FROM rental_bookings b
                                        JOIN rental_items ri ON ri.id = b.rental_item_id WHERE b.id = NEW.booking_id;
    WHEN 'payments' THEN
      IF NEW.transaction_type = 'order' THEN
        SELECT university_id INTO uid FROM orders WHERE id = NEW.transaction_id;
      ELSIF NEW.transaction_type = 'booking' THEN
        SELECT ri.university_id INTO uid FROM rental_bookings b JOIN rental_items ri ON ri.id = b.rental_item_id WHERE b.id = NEW.transaction_id;
      ELSIF NEW.transaction_type = 'ticket' THEN
        SELECT e.university_id INTO uid FROM tickets t JOIN events e ON e.id = t.event_id WHERE t.id = NEW.transaction_id;
      ELSIF NEW.transaction_type = 'promotion' THEN
        SELECT s.university_id INTO uid FROM products pr JOIN stores s ON s.id = pr.store_id WHERE pr.id = NEW.transaction_id;
      ELSIF NEW.transaction_type = 'p2p_order' THEN
        SELECT university_id INTO uid FROM p2p_orders WHERE id = NEW.transaction_id;
      END IF;
    ELSE NULL;
  END CASE;

  NEW.university_id := uid;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['p2p_orders','waitlist_entries']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_tenant ON %1$I', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_tenant BEFORE INSERT ON %1$I
                    FOR EACH ROW EXECUTE FUNCTION cn_set_university_id()', t);
  END LOOP;
END $$;

COMMIT;
