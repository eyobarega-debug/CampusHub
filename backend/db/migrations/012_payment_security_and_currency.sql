-- CampusHub — Payment security & currency support
-- Adds explicit currency column to payments table and index on provider_ref.
-- Run AFTER 011. Idempotent: safe to re-run.

BEGIN;

-- Explicit currency tracking for payments (defaults to Ethiopian Birr 'ETB')
ALTER TABLE payments ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'ETB';

-- Index on provider_ref for fast webhook / lookup queries
CREATE INDEX IF NOT EXISTS idx_payments_provider_ref ON payments (provider_ref) WHERE provider_ref IS NOT NULL;

COMMIT;
