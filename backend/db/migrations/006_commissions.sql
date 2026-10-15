BEGIN;

CREATE TABLE IF NOT EXISTS commissions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  university_id     UUID REFERENCES universities(id),
  payment_id        UUID NOT NULL UNIQUE REFERENCES payments(id) ON DELETE CASCADE,
  transaction_type  TEXT NOT NULL,
  transaction_id    UUID NOT NULL,
  description       TEXT,
  payee_id          UUID NOT NULL REFERENCES users(id),
  payee_role        TEXT,
  gross_amount      NUMERIC(12,2) NOT NULL,
  base_amount       NUMERIC(12,2) NOT NULL,
  rate              NUMERIC(6,4) NOT NULL,
  commission_amount NUMERIC(12,2) NOT NULL,
  status            TEXT NOT NULL DEFAULT 'due',
  settled_at        TIMESTAMPTZ,
  settled_by        UUID REFERENCES users(id),
  settle_note       TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_commissions_payee ON commissions(payee_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commissions_university ON commissions(university_id, status);

COMMIT;