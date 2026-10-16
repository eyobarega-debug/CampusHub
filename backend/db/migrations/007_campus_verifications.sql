-- CampusHub — verified campus accounts (manual document review).
-- A student whose email domain did not auto-verify at registration
-- (users.verification_method = 'manual_pending') submits official proof of
-- campus membership (student ID / university ID card / enrollment letter);
-- a university admin approves or rejects it from the admin dashboard.
-- Run AFTER 003–006. Idempotent: re-running is a no-op.
-- status full set: pending | approved | rejected.

BEGIN;

CREATE TABLE IF NOT EXISTS verification_requests (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  university_id     UUID NOT NULL REFERENCES universities(id) ON DELETE RESTRICT,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_type     TEXT NOT NULL,   -- student_id | university_id_card | proof_of_enrollment | other
  document_url      TEXT NOT NULL,   -- /private_uploads/proofs/<random>.(png|jpg|pdf) — never publicly served
  student_note      TEXT,
  status            TEXT NOT NULL DEFAULT 'pending',
  admin_reviewer_id UUID REFERENCES users(id) ON DELETE SET NULL,
  rejection_reason  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at       TIMESTAMPTZ
);

DO $$ BEGIN
  ALTER TABLE verification_requests ADD CONSTRAINT verification_requests_status_chk
    CHECK (status IN ('pending','approved','rejected'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A student may only have ONE active request at a time (server also checks,
-- but the index makes the rule race-proof).
CREATE UNIQUE INDEX IF NOT EXISTS uq_verification_requests_pending
  ON verification_requests (user_id) WHERE status = 'pending';

-- Admin queue: pending first, tenant-scoped + searchable.
CREATE INDEX IF NOT EXISTS idx_verification_requests_tenant
  ON verification_requests (university_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_verification_requests_user
  ON verification_requests (user_id, created_at DESC);

COMMIT;
