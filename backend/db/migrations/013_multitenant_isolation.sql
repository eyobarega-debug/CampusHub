-- CampusHub — Phase 3 Migration 013: Multi-tenant Architecture & Tenant Isolation
-- (SRS Section 21.2, Shared-Schema Multitenancy).
--
-- Extends tenant relationships, ensures denormalized university_id coverage across
-- all operational tables (rental bookings, tickets, ticket types, reviews, payout
-- accounts, payment proofs), updates derivation triggers, and adds composite
-- indexes for high-performance scoped lookups.
--
-- Hardened with strict conflict-safe backfills, explicit caller tenant validation,
-- and UPDATE immutability protections.
--
-- Safe to run on live databases and completely idempotent (re-running is a no-op).

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Universities: status constraint, permitted domains, and payment config
-- ---------------------------------------------------------------------
UPDATE universities
   SET slug = lower(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g'))
 WHERE slug IS NULL;

DO $$ BEGIN
  ALTER TABLE universities ADD CONSTRAINT universities_status_chk
    CHECK (status IN ('active', 'suspended', 'archived'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE universities
  ADD COLUMN IF NOT EXISTS permitted_domains TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS payment_config   JSONB  NOT NULL DEFAULT '{"allowed_providers":["mock","chapa","manual"]}',
  ADD COLUMN IF NOT EXISTS branding         JSONB  NOT NULL DEFAULT '{}';

-- Seed permitted_domains from primary domain if empty
UPDATE universities
   SET permitted_domains = ARRAY[lower(domain)]
 WHERE domain IS NOT NULL
   AND (permitted_domains IS NULL OR array_length(permitted_domains, 1) IS NULL OR array_length(permitted_domains, 1) = 0);

-- ---------------------------------------------------------------------
-- 2. Denormalized university_id on operational tables
-- ---------------------------------------------------------------------
ALTER TABLE rental_bookings ADD COLUMN IF NOT EXISTS university_id UUID REFERENCES universities(id) ON DELETE RESTRICT;
ALTER TABLE ticket_types    ADD COLUMN IF NOT EXISTS university_id UUID REFERENCES universities(id) ON DELETE RESTRICT;
ALTER TABLE tickets         ADD COLUMN IF NOT EXISTS university_id UUID REFERENCES universities(id) ON DELETE RESTRICT;
ALTER TABLE reviews         ADD COLUMN IF NOT EXISTS university_id UUID REFERENCES universities(id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------
-- 3. Conflict Detection and Safe Authoritative Backfills
-- ---------------------------------------------------------------------

-- A. Detect any conflicting ownership between existing records and authoritative parents
DO $$
DECLARE
  conflict_count INT;
BEGIN
  -- 1. rental_bookings: existing university_id conflicts with rental_item
  SELECT count(*) INTO conflict_count
    FROM rental_bookings b
    JOIN rental_items ri ON ri.id = b.rental_item_id
   WHERE b.university_id IS NOT NULL
     AND ri.university_id IS NOT NULL
     AND b.university_id <> ri.university_id;
  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'BACKFILL_CONFLICT: % rental_bookings have university_id conflicting with rental_item', conflict_count;
  END IF;

  -- 2. rental_bookings: unmigrated booking where rental_item university conflicts with borrower university
  SELECT count(*) INTO conflict_count
    FROM rental_bookings b
    JOIN rental_items ri ON ri.id = b.rental_item_id
    JOIN users u ON u.id = b.borrower_id
   WHERE b.university_id IS NULL
     AND ri.university_id IS NOT NULL
     AND u.university_id IS NOT NULL
     AND ri.university_id <> u.university_id;
  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'BACKFILL_CONFLICT: % rental_bookings have conflicting item vs borrower universities', conflict_count;
  END IF;

  -- 3. tickets: existing university_id conflicts with event
  SELECT count(*) INTO conflict_count
    FROM tickets t
    JOIN events e ON e.id = t.event_id
   WHERE t.university_id IS NOT NULL
     AND e.university_id IS NOT NULL
     AND t.university_id <> e.university_id;
  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'BACKFILL_CONFLICT: % tickets have university_id conflicting with event', conflict_count;
  END IF;

  -- 4. ticket_types: existing university_id conflicts with event
  SELECT count(*) INTO conflict_count
    FROM ticket_types tt
    JOIN events e ON e.id = tt.event_id
   WHERE tt.university_id IS NOT NULL
     AND e.university_id IS NOT NULL
     AND tt.university_id <> e.university_id;
  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'BACKFILL_CONFLICT: % ticket_types have university_id conflicting with event', conflict_count;
  END IF;

  -- 5. payout_accounts: existing university_id conflicts with owner user
  SELECT count(*) INTO conflict_count
    FROM payout_accounts pa
    JOIN users u ON u.id = pa.owner_id
   WHERE pa.university_id IS NOT NULL
     AND u.university_id IS NOT NULL
     AND pa.university_id <> u.university_id;
  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'BACKFILL_CONFLICT: % payout_accounts have university_id conflicting with owner', conflict_count;
  END IF;

  -- 6. payment_proofs: existing university_id conflicts with payment
  SELECT count(*) INTO conflict_count
    FROM payment_proofs pp
    JOIN payments p ON p.id = pp.payment_id
   WHERE pp.university_id IS NOT NULL
     AND p.university_id IS NOT NULL
     AND pp.university_id <> p.university_id;
  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'BACKFILL_CONFLICT: % payment_proofs have university_id conflicting with payment', conflict_count;
  END IF;

  -- 7. reviews: existing university_id conflicts with target resource
  SELECT count(*) INTO conflict_count
    FROM reviews r
    JOIN products p ON r.target_type = 'product' AND r.target_id = p.id
    JOIN stores s ON s.id = p.store_id
   WHERE r.university_id IS NOT NULL
     AND s.university_id IS NOT NULL
     AND r.university_id <> s.university_id;
  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'BACKFILL_CONFLICT: % product reviews have university_id conflicting with store', conflict_count;
  END IF;

  SELECT count(*) INTO conflict_count
    FROM reviews r
    JOIN stores s ON r.target_type = 'store' AND r.target_id = s.id
   WHERE r.university_id IS NOT NULL
     AND s.university_id IS NOT NULL
     AND r.university_id <> s.university_id;
  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'BACKFILL_CONFLICT: % store reviews have university_id conflicting with store', conflict_count;
  END IF;

  SELECT count(*) INTO conflict_count
    FROM reviews r
    JOIN p2p_listings l ON r.target_type = 'listing' AND r.target_id = l.id
   WHERE r.university_id IS NOT NULL
     AND l.university_id IS NOT NULL
     AND r.university_id <> l.university_id;
  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'BACKFILL_CONFLICT: % listing reviews have university_id conflicting with listing', conflict_count;
  END IF;

  SELECT count(*) INTO conflict_count
    FROM reviews r
    JOIN users u ON r.target_type = 'user' AND r.target_id = u.id
   WHERE r.university_id IS NOT NULL
     AND u.university_id IS NOT NULL
     AND r.university_id <> u.university_id;
  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'BACKFILL_CONFLICT: % user reviews have university_id conflicting with user', conflict_count;
  END IF;
END $$;

-- B. Authoritative Backfills: derive university_id only from authoritative parents
-- rental_bookings: authoritative parent is rental_item
UPDATE rental_bookings b
   SET university_id = r.university_id
  FROM rental_items r
 WHERE b.rental_item_id = r.id
   AND b.university_id IS NULL
   AND r.university_id IS NOT NULL;

-- ticket_types & tickets: authoritative parent is event
UPDATE ticket_types tt
   SET university_id = e.university_id
  FROM events e
 WHERE tt.event_id = e.id
   AND tt.university_id IS NULL
   AND e.university_id IS NOT NULL;

UPDATE tickets t
   SET university_id = e.university_id
  FROM events e
 WHERE t.event_id = e.id
   AND t.university_id IS NULL
   AND e.university_id IS NOT NULL;

-- payout_accounts: authoritative owner is user
UPDATE payout_accounts pa
   SET university_id = u.university_id
  FROM users u
 WHERE pa.owner_id = u.id
   AND pa.university_id IS NULL
   AND u.university_id IS NOT NULL;

-- payment_proofs: authoritative parent is payment
UPDATE payment_proofs pp
   SET university_id = p.university_id
  FROM payments p
 WHERE pp.payment_id = p.id
   AND pp.university_id IS NULL
   AND p.university_id IS NOT NULL;

-- reviews: authoritative parent is the reviewed target resource
UPDATE reviews r
   SET university_id = s.university_id
  FROM products p
  JOIN stores s ON s.id = p.store_id
 WHERE r.target_type = 'product'
   AND r.target_id = p.id
   AND r.university_id IS NULL
   AND s.university_id IS NOT NULL;

UPDATE reviews r
   SET university_id = s.university_id
  FROM stores s
 WHERE r.target_type = 'store'
   AND r.target_id = s.id
   AND r.university_id IS NULL
   AND s.university_id IS NOT NULL;

UPDATE reviews r
   SET university_id = l.university_id
  FROM p2p_listings l
 WHERE r.target_type = 'listing'
   AND r.target_id = l.id
   AND r.university_id IS NULL
   AND l.university_id IS NOT NULL;

UPDATE reviews r
   SET university_id = u.university_id
  FROM users u
 WHERE r.target_type = 'user'
   AND r.target_id = u.id
   AND r.university_id IS NULL
   AND u.university_id IS NOT NULL;

-- Fallback for reviews where target does not have a campus association: author's university
UPDATE reviews r
   SET university_id = u.university_id
  FROM users u
 WHERE r.author_id = u.id
   AND r.university_id IS NULL
   AND u.university_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 4. Triggers: Derive and validate university_id on INSERT and enforce immutability on UPDATE
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cn_set_university_id() RETURNS trigger AS $$
DECLARE
  uid UUID;
BEGIN
  -- 1. On UPDATE: strictly enforce immutability of university_id once assigned
  IF TG_OP = 'UPDATE' THEN
    IF OLD.university_id IS NOT NULL AND NEW.university_id IS DISTINCT FROM OLD.university_id THEN
      RAISE EXCEPTION 'TENANT_IMMUTABLE: Changing university_id on existing records is prohibited on table % (old: %, new: %)',
        TG_TABLE_NAME, OLD.university_id, NEW.university_id;
    END IF;
  END IF;

  -- 2. Derive authoritative university_id from parent or owner
  CASE TG_TABLE_NAME
    WHEN 'stores'                THEN SELECT university_id INTO uid FROM users  WHERE id = NEW.merchant_id;
    WHEN 'merchant_applications' THEN SELECT university_id INTO uid FROM users  WHERE id = NEW.user_id;
    WHEN 'p2p_listings'          THEN SELECT university_id INTO uid FROM users  WHERE id = NEW.seller_id;
    WHEN 'rental_items'          THEN SELECT university_id INTO uid FROM users  WHERE id = NEW.owner_id;
    WHEN 'reports'               THEN IF NEW.reporter_id IS NOT NULL THEN SELECT university_id INTO uid FROM users WHERE id = NEW.reporter_id; END IF;
    WHEN 'audit_logs'            THEN IF NEW.actor_id IS NOT NULL THEN SELECT university_id INTO uid FROM users WHERE id = NEW.actor_id; END IF;
    WHEN 'orders'                THEN SELECT university_id INTO uid FROM stores WHERE id = NEW.store_id;
    WHEN 'p2p_orders'            THEN SELECT university_id INTO uid FROM p2p_listings WHERE id = NEW.listing_id;
    WHEN 'events'                THEN SELECT university_id INTO uid FROM clubs  WHERE id = NEW.club_id;
    WHEN 'waitlist_entries'      THEN SELECT university_id INTO uid FROM events WHERE id = NEW.event_id;
    WHEN 'rental_bookings'       THEN SELECT university_id INTO uid FROM rental_items WHERE id = NEW.rental_item_id;
    WHEN 'ticket_types'          THEN SELECT university_id INTO uid FROM events WHERE id = NEW.event_id;
    WHEN 'tickets'               THEN SELECT university_id INTO uid FROM events WHERE id = NEW.event_id;
    WHEN 'payout_accounts'       THEN SELECT university_id INTO uid FROM users  WHERE id = NEW.owner_id;
    WHEN 'payment_proofs'        THEN SELECT university_id INTO uid FROM payments WHERE id = NEW.payment_id;
    WHEN 'disputes'              THEN SELECT ri.university_id INTO uid FROM rental_bookings b JOIN rental_items ri ON ri.id = b.rental_item_id WHERE b.id = NEW.booking_id;
    WHEN 'commissions'           THEN SELECT university_id INTO uid FROM payments WHERE id = NEW.payment_id;
    WHEN 'order_status_history'  THEN SELECT university_id INTO uid FROM orders WHERE id = NEW.order_id;
    WHEN 'verification_requests' THEN SELECT university_id INTO uid FROM users WHERE id = NEW.user_id;
    WHEN 'reviews' THEN
      IF NEW.target_type = 'product' THEN
        SELECT s.university_id INTO uid FROM products pr JOIN stores s ON s.id = pr.store_id WHERE pr.id = NEW.target_id;
      ELSIF NEW.target_type = 'store' THEN
        SELECT university_id INTO uid FROM stores WHERE id = NEW.target_id;
      ELSIF NEW.target_type = 'listing' THEN
        SELECT university_id INTO uid FROM p2p_listings WHERE id = NEW.target_id;
      ELSIF NEW.target_type = 'user' THEN
        SELECT university_id INTO uid FROM users WHERE id = NEW.target_id;
      END IF;
      IF uid IS NULL THEN
        SELECT university_id INTO uid FROM users WHERE id = NEW.author_id;
      END IF;
    WHEN 'payments' THEN
      IF NEW.transaction_type = 'order' THEN
        SELECT university_id INTO uid FROM orders WHERE id = NEW.transaction_id;
      ELSIF NEW.transaction_type = 'booking' THEN
        SELECT university_id INTO uid FROM rental_bookings WHERE id = NEW.transaction_id;
        IF uid IS NULL THEN
          SELECT ri.university_id INTO uid FROM rental_bookings b JOIN rental_items ri ON ri.id = b.rental_item_id WHERE b.id = NEW.transaction_id;
        END IF;
      ELSIF NEW.transaction_type = 'ticket' THEN
        SELECT university_id INTO uid FROM tickets WHERE id = NEW.transaction_id;
        IF uid IS NULL THEN
          SELECT e.university_id INTO uid FROM tickets t JOIN events e ON e.id = t.event_id WHERE t.id = NEW.transaction_id;
        END IF;
      ELSIF NEW.transaction_type = 'promotion' THEN
        SELECT s.university_id INTO uid FROM products pr JOIN stores s ON s.id = pr.store_id WHERE pr.id = NEW.transaction_id;
      ELSIF NEW.transaction_type = 'p2p_order' THEN
        SELECT university_id INTO uid FROM p2p_orders WHERE id = NEW.transaction_id;
      END IF;
    ELSE uid := NULL;
  END CASE;

  -- 3. On UPDATE: prevent moving the record to a parent belonging to a different university
  IF TG_OP = 'UPDATE' THEN
    IF OLD.university_id IS NOT NULL AND uid IS NOT NULL AND uid <> OLD.university_id THEN
      RAISE EXCEPTION 'TENANT_MISMATCH: Changing parent reference to another university is prohibited on table % (record tenant: %, new parent tenant: %)',
        TG_TABLE_NAME, OLD.university_id, uid;
    END IF;
    -- Preserve original university_id on update
    IF OLD.university_id IS NOT NULL THEN
      NEW.university_id := OLD.university_id;
      RETURN NEW;
    END IF;
  END IF;

  -- 4. On INSERT (or UPDATE where OLD.university_id was null):
  IF uid IS NOT NULL THEN
    -- If caller supplied explicit university_id, validate that it matches the authoritative parent
    IF NEW.university_id IS NOT NULL AND NEW.university_id <> uid THEN
      RAISE EXCEPTION 'TENANT_MISMATCH: Provided university_id (%) does not match authoritative parent (%) on table %',
        NEW.university_id, uid, TG_TABLE_NAME;
    END IF;
    -- Set or preserve authoritative university_id
    NEW.university_id := uid;
  ELSE
    -- If no authoritative parent exists (e.g. platform-wide record), do not assign an arbitrary tenant
    NULL;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Attach BEFORE INSERT OR UPDATE triggers across all tenant operational tables
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'stores', 'merchant_applications', 'p2p_listings', 'rental_items', 'orders',
    'events', 'payments', 'reports', 'disputes', 'audit_logs', 'p2p_orders',
    'waitlist_entries', 'rental_bookings', 'ticket_types', 'tickets',
    'payout_accounts', 'payment_proofs', 'reviews',
    'commissions', 'order_status_history', 'verification_requests'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_tenant ON %1$I', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_tenant BEFORE INSERT OR UPDATE ON %1$I
                    FOR EACH ROW EXECUTE FUNCTION cn_set_university_id()', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- 5. Indexes for tenant-scoped browse and operational queries
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_rental_bookings_tenant ON rental_bookings(university_id, status);
CREATE INDEX IF NOT EXISTS idx_ticket_types_tenant    ON ticket_types(university_id);
CREATE INDEX IF NOT EXISTS idx_tickets_tenant         ON tickets(university_id, status);
CREATE INDEX IF NOT EXISTS idx_reviews_tenant         ON reviews(university_id, target_type);
CREATE INDEX IF NOT EXISTS idx_payout_accounts_tenant ON payout_accounts(university_id);
CREATE INDEX IF NOT EXISTS idx_payment_proofs_tenant  ON payment_proofs(university_id);

COMMIT;
