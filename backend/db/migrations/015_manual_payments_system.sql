-- CampusHub — Manual Payment & Transaction Confirmation System
-- Migration 015: Support separate material confirmations, rental confirmations,
-- official CampusHub receiving accounts, organizer payouts, and merchant commission evidence.

BEGIN;

-- 1. Orders: record merchant payment receipt and student delivery/collection confirmations separately
ALTER TABLE orders ADD COLUMN IF NOT EXISTS merchant_confirmed_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS buyer_confirmed_at TIMESTAMPTZ;

-- 2. Rental bookings: record owner payment confirmation and renter physical item receipt separately
ALTER TABLE rental_bookings ADD COLUMN IF NOT EXISTS owner_confirmed_at TIMESTAMPTZ;
ALTER TABLE rental_bookings ADD COLUMN IF NOT EXISTS renter_confirmed_at TIMESTAMPTZ;

-- 3. Payout accounts: support official CampusHub admin receiving accounts for events and commissions
ALTER TABLE payout_accounts ADD COLUMN IF NOT EXISTS is_campus_hub BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_payout_accounts_campushub 
  ON payout_accounts (university_id) WHERE is_campus_hub AND active;

-- 4. Organizer payouts: track verified ticket revenue transfers to event organizers
CREATE TABLE IF NOT EXISTS organizer_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  university_id UUID REFERENCES universities(id),
  organizer_id UUID NOT NULL REFERENCES users(id),
  event_id UUID REFERENCES events(id),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'completed', -- 'pending' | 'completed' | 'cancelled'
  reference_number TEXT NOT NULL,
  notes TEXT,
  recorded_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_organizer_payouts_org ON organizer_payouts (organizer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_organizer_payouts_tenant ON organizer_payouts (university_id);

-- 5. Commission payments: track merchant submissions of accumulated commission to CampusHub
CREATE TABLE IF NOT EXISTS commission_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  university_id UUID REFERENCES universities(id),
  merchant_id UUID NOT NULL REFERENCES users(id),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  reference_number TEXT NOT NULL,
  proof_file_name TEXT,
  status TEXT NOT NULL DEFAULT 'submitted', -- 'submitted' | 'verified' | 'rejected'
  reviewer_id UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_commission_payments_merchant ON commission_payments (merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commission_payments_tenant ON commission_payments (university_id);

COMMIT;
