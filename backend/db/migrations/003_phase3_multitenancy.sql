-- CampusHub — Phase 3 migration: multi-university tenancy (SRS Section 21.2,
-- shared-schema default). Safe to run on a live Phase 1/2 database and
-- idempotent (re-running is a no-op).
--
-- Strategy: every tenant-owned table gets a denormalised university_id,
-- backfilled from its owner, kept correct on INSERT by a trigger that derives
-- it from the owning row. The trigger means no existing INSERT statement in
-- the Phase 1/2 code has to change, and application code cannot forget it.

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Tenants
-- ---------------------------------------------------------------------
ALTER TABLE universities
  ADD COLUMN IF NOT EXISTS slug           TEXT,
  ADD COLUMN IF NOT EXISTS feature_flags  JSONB NOT NULL DEFAULT '{}',
  -- 'shared' = default shared schema. 'dedicated' = flagged as needing the
  -- database-per-tenant treatment (data residency / contractual). The flag is
  -- the documented decision record; actually provisioning a separate DB is an
  -- ops task — see PHASE3.md.
  ADD COLUMN IF NOT EXISTS isolation_mode TEXT NOT NULL DEFAULT 'shared',
  ADD COLUMN IF NOT EXISTS isolation_reason TEXT,
  ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE universities
   SET slug = lower(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g'))
 WHERE slug IS NULL;

DO $$ BEGIN
  ALTER TABLE universities ADD CONSTRAINT universities_isolation_mode_chk
    CHECK (isolation_mode IN ('shared','dedicated'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_universities_slug   ON universities (slug);
CREATE UNIQUE INDEX IF NOT EXISTS uq_universities_domain ON universities (lower(domain)) WHERE domain IS NOT NULL;

-- ---------------------------------------------------------------------
-- 2. Users: a non-super-admin must belong to a university, and deleting a
--    university must never silently orphan its users into "no tenant".
-- ---------------------------------------------------------------------
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_university_id_fkey;
ALTER TABLE users ADD CONSTRAINT users_university_id_fkey
  FOREIGN KEY (university_id) REFERENCES universities(id) ON DELETE RESTRICT;

-- NOT VALID: enforced for every new/updated row without failing the
-- migration if a legacy row has no university. Run
--   ALTER TABLE users VALIDATE CONSTRAINT users_tenant_required_chk;
-- once you've cleaned up legacy rows (see PHASE3.md).
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_tenant_required_chk
    CHECK (role = 'super_admin' OR university_id IS NOT NULL) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------
-- 3. university_id on tenant-owned tables
-- ---------------------------------------------------------------------
ALTER TABLE stores                ADD COLUMN IF NOT EXISTS university_id UUID REFERENCES universities(id);
ALTER TABLE merchant_applications ADD COLUMN IF NOT EXISTS university_id UUID REFERENCES universities(id);
ALTER TABLE p2p_listings          ADD COLUMN IF NOT EXISTS university_id UUID REFERENCES universities(id);
ALTER TABLE rental_items          ADD COLUMN IF NOT EXISTS university_id UUID REFERENCES universities(id);
ALTER TABLE orders                ADD COLUMN IF NOT EXISTS university_id UUID REFERENCES universities(id);
ALTER TABLE events                ADD COLUMN IF NOT EXISTS university_id UUID REFERENCES universities(id);
ALTER TABLE payments              ADD COLUMN IF NOT EXISTS university_id UUID REFERENCES universities(id);
ALTER TABLE reports               ADD COLUMN IF NOT EXISTS university_id UUID REFERENCES universities(id);
ALTER TABLE disputes              ADD COLUMN IF NOT EXISTS university_id UUID REFERENCES universities(id);
ALTER TABLE audit_logs            ADD COLUMN IF NOT EXISTS university_id UUID REFERENCES universities(id);
-- Per-payment facts the finalizers need (e.g. days purchased for a promotion), so they
-- never have to be re-derived from a fee rate that may have changed since.
ALTER TABLE payments              ADD COLUMN IF NOT EXISTS details JSONB;

-- clubs already has university_id; backfill any NULLs from the club lead.
UPDATE clubs c SET university_id = u.university_id
  FROM users u WHERE c.lead_user_id = u.id AND c.university_id IS NULL;

-- ---------------------------------------------------------------------
-- 4. Backfill existing rows from their owners
-- ---------------------------------------------------------------------
UPDATE stores s                SET university_id = u.university_id FROM users u WHERE s.merchant_id = u.id AND s.university_id IS NULL;
UPDATE merchant_applications m SET university_id = u.university_id FROM users u WHERE m.user_id = u.id     AND m.university_id IS NULL;
UPDATE p2p_listings l          SET university_id = u.university_id FROM users u WHERE l.seller_id = u.id   AND l.university_id IS NULL;
UPDATE rental_items r          SET university_id = u.university_id FROM users u WHERE r.owner_id = u.id    AND r.university_id IS NULL;
UPDATE orders o                SET university_id = s.university_id FROM stores s WHERE o.store_id = s.id   AND o.university_id IS NULL;
UPDATE events e                SET university_id = c.university_id FROM clubs c  WHERE e.club_id = c.id    AND e.university_id IS NULL;
UPDATE reports r               SET university_id = u.university_id FROM users u WHERE r.reporter_id = u.id AND r.university_id IS NULL;
UPDATE audit_logs a            SET university_id = u.university_id FROM users u WHERE a.actor_id = u.id    AND a.university_id IS NULL;
UPDATE disputes d              SET university_id = r.university_id
  FROM rental_bookings b JOIN rental_items r ON r.id = b.rental_item_id
 WHERE d.booking_id = b.id AND d.university_id IS NULL;

UPDATE payments p SET university_id = x.uid FROM (
  SELECT p2.id, CASE p2.transaction_type
      WHEN 'order'     THEN (SELECT university_id FROM orders        WHERE id = p2.transaction_id)
      WHEN 'booking'   THEN (SELECT ri.university_id FROM rental_bookings b JOIN rental_items ri ON ri.id = b.rental_item_id WHERE b.id = p2.transaction_id)
      WHEN 'ticket'    THEN (SELECT e.university_id FROM tickets t JOIN events e ON e.id = t.event_id WHERE t.id = p2.transaction_id)
      WHEN 'promotion' THEN (SELECT s.university_id FROM products pr JOIN stores s ON s.id = pr.store_id WHERE pr.id = p2.transaction_id)
    END AS uid
  FROM payments p2
) x WHERE p.id = x.id AND p.university_id IS NULL;

-- ---------------------------------------------------------------------
-- 5. Triggers: derive university_id on INSERT when the caller didn't set it
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
  FOREACH t IN ARRAY ARRAY['stores','merchant_applications','p2p_listings','rental_items','orders',
                           'events','payments','reports','disputes','audit_logs']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_tenant ON %1$I', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_tenant BEFORE INSERT ON %1$I
                    FOR EACH ROW EXECUTE FUNCTION cn_set_university_id()', t);
  END LOOP;
END $$;

-- Clubs are the one table whose tenant can't be derived: it must be explicit.
ALTER TABLE clubs ALTER COLUMN university_id SET NOT NULL;

-- ---------------------------------------------------------------------
-- 6. Indexes for tenant-scoped browse queries
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_users_university      ON users(university_id);
CREATE INDEX IF NOT EXISTS idx_stores_university     ON stores(university_id);
CREATE INDEX IF NOT EXISTS idx_listings_university   ON p2p_listings(university_id, status);
CREATE INDEX IF NOT EXISTS idx_rentals_university    ON rental_items(university_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_university     ON orders(university_id);
CREATE INDEX IF NOT EXISTS idx_events_university     ON events(university_id, status);
CREATE INDEX IF NOT EXISTS idx_payments_university   ON payments(university_id);
CREATE INDEX IF NOT EXISTS idx_reports_university    ON reports(university_id);
CREATE INDEX IF NOT EXISTS idx_audit_university      ON audit_logs(university_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_apps_university       ON merchant_applications(university_id);

-- ---------------------------------------------------------------------
-- 7. Per-university fee schedules (SRS Section 18). university_id NULL is the
--    platform-wide default. Append-only: the effective row is the newest one
--    whose effective_from has passed, so history is never rewritten.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fee_schedules (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  university_id         UUID REFERENCES universities(id) ON DELETE CASCADE,
  commission_rate       NUMERIC(6,4) NOT NULL CHECK (commission_rate >= 0 AND commission_rate <= 0.5),
  featured_rate_per_day NUMERIC(12,2) NOT NULL CHECK (featured_rate_per_day >= 0),
  effective_from        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by            UUID REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fee_schedules_lookup ON fee_schedules(university_id, effective_from DESC);

INSERT INTO fee_schedules (university_id, commission_rate, featured_rate_per_day)
SELECT NULL, 0.05, 20
WHERE NOT EXISTS (SELECT 1 FROM fee_schedules WHERE university_id IS NULL);

COMMIT;
