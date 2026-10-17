-- 017_event_ticketing_enhancements.sql
-- Gibiyachin Platform (ግቢያችን) — Professional Event Ticketing System Enhancements

-- 1. Events Table: Add poster, end_time, venue details, organizer display name, contact info, and category
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS poster_url TEXT,
  ADD COLUMN IF NOT EXISTS end_time TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS venue_name TEXT,
  ADD COLUMN IF NOT EXISTS venue_address TEXT,
  ADD COLUMN IF NOT EXISTS organizer_name TEXT,
  ADD COLUMN IF NOT EXISTS contact_info TEXT,
  ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'general';

-- Backfill venue_name from existing location if available
UPDATE events SET venue_name = location WHERE venue_name IS NULL AND location IS NOT NULL;

-- 2. Ticket Types Table: Add description, active status, purchase limits, and sales windows
ALTER TABLE ticket_types
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS purchase_limit INT DEFAULT 5,
  ADD COLUMN IF NOT EXISTS sales_start_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sales_end_at TIMESTAMPTZ;

-- 3. Tickets Table: Add unique human-readable ticket number (GIB-XXXXXXXX)
ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS ticket_number TEXT;

-- Backfill ticket_number for existing tickets using safe hex prefix
UPDATE tickets
  SET ticket_number = 'GIB-' || UPPER(SUBSTRING(REPLACE(id::text, '-', ''), 1, 8))
  WHERE ticket_number IS NULL;

-- Ensure ticket_number is unique
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_tickets_ticket_number'
  ) THEN
    ALTER TABLE tickets ADD CONSTRAINT uq_tickets_ticket_number UNIQUE (ticket_number);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tickets_ticket_number ON tickets(ticket_number);

-- 4. Ticket Check-Ins Table: Append-only audit trail of admissions and authorized reversals
CREATE TABLE IF NOT EXISTS ticket_checkins (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id      UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  event_id       UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  staff_id       UUID NOT NULL REFERENCES users(id),
  checked_in_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  device_info    TEXT,
  is_reversal    BOOLEAN NOT NULL DEFAULT false,
  reversed_by    UUID REFERENCES users(id),
  reversed_at    TIMESTAMPTZ,
  notes          TEXT
);

CREATE INDEX IF NOT EXISTS idx_ticket_checkins_ticket ON ticket_checkins(ticket_id);
CREATE INDEX IF NOT EXISTS idx_ticket_checkins_event  ON ticket_checkins(event_id);
CREATE INDEX IF NOT EXISTS idx_ticket_checkins_time   ON ticket_checkins(checked_in_at);
