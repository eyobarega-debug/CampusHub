-- CampusHub — Financial Integrity & Idempotency Hardening
-- Migration 016: Prevent duplicate commission payment and organizer payout references,
-- and store verified settlement amounts.
-- Run AFTER 015. Completely idempotent and safe to re-run.

BEGIN;

-- 1. Commission payments: add verified_amount column
ALTER TABLE commission_payments ADD COLUMN IF NOT EXISTS verified_amount NUMERIC(12,2);

-- 2. Commission payments: partial unique index on reference_number per university
-- Excludes rejected submissions so merchants can correct and resubmit without being blocked forever
CREATE UNIQUE INDEX IF NOT EXISTS uq_commission_payments_ref
  ON commission_payments (university_id, lower(trim(reference_number)))
  WHERE status <> 'rejected';

-- 3. Organizer payouts: partial unique index on reference_number per university for completed payouts
CREATE UNIQUE INDEX IF NOT EXISTS uq_organizer_payouts_ref
  ON organizer_payouts (university_id, lower(trim(reference_number)))
  WHERE status = 'completed';

COMMIT;
