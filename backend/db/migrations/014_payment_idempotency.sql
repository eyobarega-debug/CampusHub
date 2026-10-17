-- CampusHub — Phase 3 Fix: Payment Idempotency & Concurrency Safety
-- Migration 014: Ensure at most one active (pending or under_review) payment per transaction.
-- Run AFTER 013. Completely idempotent and safe to re-run.

BEGIN;

-- 1. Defensively mark any legacy duplicate active payments as failed (keeping the latest)
UPDATE payments
   SET status = 'failed'
 WHERE id IN (
   SELECT id FROM (
     SELECT id, ROW_NUMBER() OVER (
       PARTITION BY transaction_type, transaction_id
       ORDER BY created_at DESC
     ) AS rn
     FROM payments
     WHERE status IN ('pending', 'under_review')
   ) sub
   WHERE sub.rn > 1
 );

-- 2. Partial unique index enforcing at most one active payment record per transaction.
-- Legitimate retries after definitive failure or refund are explicitly permitted
-- because failed/refunded rows are excluded from this partial index.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_active_txn
  ON payments (transaction_type, transaction_id)
  WHERE status IN ('pending', 'under_review');

COMMIT;
