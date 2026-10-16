-- CampusHub — Email OTP verification for signup (email ownership proof).
--
-- This adds a SECOND, independent axis of verification to `users`:
--
--   * `verified` / `verification_method`  -> CAMPUS verification (existing):
--         'domain' | 'manual_pending' | 'manual_document'. Unchanged.
--   * `email_verified` / `email_verified_at` -> EMAIL ownership (new), proven
--         by a 6-digit OTP sent to the address the student signed up with.
--
-- A university-domain student therefore still gets campus verification
-- automatically (existing behaviour, kept intact so smoke.sh / tenancy.sh
-- keep passing) while ALSO proving they control the email address.
--
-- The OTP itself lives in `email_otps`, NOT on `users`, so we keep exactly one
-- active code per (user, purpose), store only a hash, and can rate-limit
-- attempts and resends without bloating the users row. The pre-existing
-- `users.email_verify_token` column stays untouched/unused.
--
-- Idempotent: safe to re-run. Run it AFTER 001-008.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. users: email-verification columns.
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified    BOOLEAN     NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- 2. email_otps: one active row per (user, purpose). The UNIQUE constraint
--    turns "resend" into a single UPSERT, which is also what stops a user
--    from accumulating an unlimited pile of live codes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_otps (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose      TEXT NOT NULL DEFAULT 'signup',
  code_hash    TEXT NOT NULL,                                   -- HMAC/SHA-256 of the 6-digit code; plaintext is never stored
  expires_at   TIMESTAMPTZ NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,                      -- failed verification attempts against this code
  max_attempts INTEGER NOT NULL DEFAULT 5,
  send_count   INTEGER NOT NULL DEFAULT 0,                      -- how many codes we've issued for this purpose (resend budget)
  last_sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),             -- drives the resend cooldown
  consumed_at  TIMESTAMPTZ,                                    -- set when the code is used successfully
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT email_otps_purpose_chk CHECK (purpose IN ('signup')),
  CONSTRAINT email_otps_user_purpose_uniq UNIQUE (user_id, purpose)
);

CREATE INDEX IF NOT EXISTS idx_email_otps_user     ON email_otps(user_id, purpose);
CREATE INDEX IF NOT EXISTS idx_email_otps_expires  ON email_otps(expires_at);

-- ---------------------------------------------------------------------------
-- 3. Backfill: accounts that pre-date this feature have no OTP history, so
--    they are trusted (otherwise every existing user would be locked out).
--    Excluding anyone who DOES have an email_otps row makes re-running safe:
--    a post-migration signup that is still mid-OTP always has a row.
-- ---------------------------------------------------------------------------
UPDATE users u
   SET email_verified = true
 WHERE u.email_verified = false
   AND NOT EXISTS (SELECT 1 FROM email_otps e WHERE e.user_id = u.id);

COMMIT;
