-- CampusHub — manual payment with proof (student pays the seller/organizer
-- directly, uploads a screenshot, the payee approves or rejects it).
-- Run AFTER 003 and 004. Idempotent: re-running is a no-op.
-- payments.status gains one value: 'under_review'.
-- Full set: pending | under_review | confirmed | failed | refunded.

BEGIN;

ALTER TABLE payments ADD COLUMN IF NOT EXISTS payer_id        UUID REFERENCES users(id);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS payee_id        UUID REFERENCES users(id);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS payee_accounts  JSONB;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS description     TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS expires_at      TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS proof_attempts  INT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_payments_payee ON payments(payee_id, status) WHERE provider = 'manual';
CREATE INDEX IF NOT EXISTS idx_payments_payer ON payments(payer_id, status) WHERE provider = 'manual';
CREATE INDEX IF NOT EXISTS idx_payments_manual_expiry ON payments(expires_at) WHERE provider = 'manual' AND status = 'pending';

CREATE TABLE IF NOT EXISTS payout_accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  university_id   UUID REFERENCES universities(id),
  owner_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method          TEXT NOT NULL,   -- cbe | telebirr | awash | dashen | abyssinia | other
  account_name    TEXT NOT NULL,
  account_number  TEXT NOT NULL,
  instructions    TEXT,            -- optional note for buyers
  is_default      BOOLEAN NOT NULL DEFAULT false,
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE payout_accounts ADD COLUMN IF NOT EXISTS instructions TEXT;
CREATE INDEX IF NOT EXISTS idx_payout_accounts_owner ON payout_accounts(owner_id) WHERE active;

CREATE TABLE IF NOT EXISTS payment_proofs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  university_id     UUID REFERENCES universities(id),
  payment_id        UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  payer_id          UUID NOT NULL REFERENCES users(id),
  payee_id          UUID NOT NULL REFERENCES users(id),
  file_name         TEXT NOT NULL,
  image_sha256      TEXT NOT NULL,
  reference_number  TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'submitted', -- submitted | approved | rejected
  reviewer_id       UUID REFERENCES users(id),
  reviewed_at       TIMESTAMPTZ,
  reject_reason     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payment_proofs_payment ON payment_proofs(payment_id, created_at DESC);

-- Fraud guards: same screenshot can't back two live payments; same transaction
-- reference can't be reused for the same payee. Rejected proofs are excluded.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_proofs_hash
  ON payment_proofs (image_sha256) WHERE status <> 'rejected';
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_proofs_reference
  ON payment_proofs (payee_id, lower(reference_number)) WHERE status <> 'rejected';

COMMIT;