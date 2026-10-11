-- CampusHub — Phase 1 (Graduation MVP) database schema
-- Matches SRS Section 13 (Database Requirements), trimmed to what the
-- Graduation MVP acceptance criteria (SRS Section 23) actually needs.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------
-- Core identity
-- ---------------------------------------------------------------------
CREATE TABLE universities (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  domain        TEXT,                       -- e.g. "aastu.edu.et" — used for FR-002 auto-verification
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE user_role AS ENUM ('student', 'merchant', 'organizer', 'admin', 'super_admin');

CREATE TABLE users (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  university_id       UUID REFERENCES universities(id) ON DELETE SET NULL,
  name                TEXT NOT NULL,
  email               TEXT NOT NULL UNIQUE,
  phone               TEXT,
  password_hash       TEXT NOT NULL,
  role                user_role NOT NULL DEFAULT 'student',
  verified            BOOLEAN NOT NULL DEFAULT false,
  verification_method TEXT,                 -- 'domain' | 'manual_document' | null
  student_id_doc_url  TEXT,                 -- FR-002 manual fallback
  suspended           BOOLEAN NOT NULL DEFAULT false,
  avatar_url          TEXT,
  bio                 TEXT,
  notification_prefs  JSONB NOT NULL DEFAULT '{"orders":true,"rentals":true,"events":true,"announcements":true}',
  email_verify_token  TEXT,
  password_reset_token TEXT,
  password_reset_expires TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,
  family_id   UUID NOT NULL,
  revoked     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

-- ---------------------------------------------------------------------
-- Merchants & marketplace
-- ---------------------------------------------------------------------
CREATE TABLE merchant_applications (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_name  TEXT NOT NULL,
  category       TEXT,
  contact_info   TEXT,
  document_urls  TEXT[] DEFAULT '{}',
  status         TEXT NOT NULL DEFAULT 'pending_review', -- pending_review | approved | rejected
  reason         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at     TIMESTAMPTZ
);

CREATE TABLE stores (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  logo_url     TEXT,
  description  TEXT,
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE categories (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT NOT NULL,
  parent_category_id  UUID REFERENCES categories(id)
);

CREATE TABLE products (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id     UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  category_id  UUID REFERENCES categories(id),
  title        TEXT NOT NULL,
  description  TEXT,
  price        NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  stock        INT NOT NULL DEFAULT 0 CHECK (stock >= 0),
  images       TEXT[] DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'active', -- active | out_of_stock | removed | pending_review
  featured_until TIMESTAMPTZ, -- FR-038 promoted/featured placement, set via POST /api/products/:id/promote
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id      UUID NOT NULL REFERENCES users(id),
  store_id      UUID NOT NULL REFERENCES stores(id),
  status        TEXT NOT NULL DEFAULT 'pending_payment',
  -- pending_payment | confirmed | ready | completed | cancellation_requested | cancelled
  total_amount  NUMERIC(12,2) NOT NULL DEFAULT 0,
  cancel_reason TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id  UUID NOT NULL REFERENCES products(id),
  quantity    INT NOT NULL CHECK (quantity > 0),
  unit_price  NUMERIC(12,2) NOT NULL
);

CREATE TABLE favorites (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id  UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, product_id)
);

-- ---------------------------------------------------------------------
-- Peer-to-peer marketplace
-- ---------------------------------------------------------------------
CREATE TABLE p2p_listings (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  description  TEXT,
  price        NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  condition    TEXT,
  category_id  UUID REFERENCES categories(id),
  images       TEXT[] DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'active', -- active | pending_review | sold | removed
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE p2p_requests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id  UUID NOT NULL REFERENCES p2p_listings(id) ON DELETE CASCADE,
  buyer_id    UUID NOT NULL REFERENCES users(id),
  message     TEXT,
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | declined
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Phase 2: optional in-app payment for P2P transactions (Phase 1 only
-- supported buyer/seller contact — payment was arranged off-platform).
-- One order per accepted request; routed through the same Payment Gateway
-- Abstraction Layer as everything else (SRS Section 16).
CREATE TABLE p2p_orders (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id  UUID NOT NULL REFERENCES p2p_listings(id) ON DELETE CASCADE,
  request_id  UUID NOT NULL UNIQUE REFERENCES p2p_requests(id) ON DELETE CASCADE,
  buyer_id    UUID NOT NULL REFERENCES users(id),
  seller_id   UUID NOT NULL REFERENCES users(id),
  amount      NUMERIC(12,2) NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending_payment', -- pending_payment | paid | cancelled
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Borrowing & rentals
-- ---------------------------------------------------------------------
CREATE TABLE rental_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  description     TEXT,
  category_id     UUID REFERENCES categories(id),
  price_per_day   NUMERIC(12,2) NOT NULL CHECK (price_per_day >= 0),
  deposit         NUMERIC(12,2) NOT NULL DEFAULT 0,
  -- Phase 2: tiered late-fee escalation, e.g.
  -- [{"upToDays":2,"ratePerDay":0.5},{"upToDays":null,"ratePerDay":1.0}]
  -- means the first 2 days late are charged at 0.5x the daily rate, and
  -- every day beyond that at the full daily rate. `upToDays: null` marks
  -- the final, uncapped tier. Falls back to the Phase 1 flat default
  -- (0.5x/day) if null so existing listings don't need a migration script.
  late_fee_policy JSONB,
  available_from  DATE NOT NULL,
  available_to    DATE NOT NULL,
  images          TEXT[] DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'active', -- active | removed
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE rental_bookings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rental_item_id  UUID NOT NULL REFERENCES rental_items(id) ON DELETE CASCADE,
  borrower_id     UUID NOT NULL REFERENCES users(id),
  start_date      DATE NOT NULL,
  end_date        DATE NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending_payment',
  -- pending_payment | confirmed_awaiting_pickup | active | overdue | completed | cancelled | disputed
  deposit_status  TEXT NOT NULL DEFAULT 'held', -- held | released | partially_released
  late_fee        NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,
  picked_up_at    TIMESTAMPTZ,
  returned_at     TIMESTAMPTZ,
  return_condition TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE disputes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  UUID NOT NULL REFERENCES rental_bookings(id) ON DELETE CASCADE,
  raised_by   UUID NOT NULL REFERENCES users(id),
  reason      TEXT NOT NULL,
  evidence    TEXT[] DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'open', -- open | resolved
  resolution  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Clubs, events, ticketing
-- ---------------------------------------------------------------------
CREATE TABLE clubs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  university_id  UUID REFERENCES universities(id),
  name           TEXT NOT NULL,
  lead_user_id   UUID REFERENCES users(id),
  status         TEXT NOT NULL DEFAULT 'active', -- active | pending | suspended
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id      UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  description  TEXT,
  date_time    TIMESTAMPTZ NOT NULL,
  location     TEXT,
  capacity     INT NOT NULL CHECK (capacity >= 0),
  status       TEXT NOT NULL DEFAULT 'draft',
  -- draft | pending_review | approved | published | postponed | cancelled | completed
  reject_reason TEXT,
  -- Phase 2: recurring events. recurrence_rule is 'none' | 'weekly' on the
  -- template event; generated occurrences point back to it via
  -- parent_event_id so they can be told apart from one-off events.
  recurrence_rule TEXT NOT NULL DEFAULT 'none',
  parent_event_id UUID REFERENCES events(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ticket_types (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name            TEXT NOT NULL DEFAULT 'General',
  price           NUMERIC(12,2) NOT NULL DEFAULT 0,
  quantity_total  INT NOT NULL,
  quantity_sold   INT NOT NULL DEFAULT 0
);

-- Phase 2: waitlist for sold-out ticket types (SRS Phase 2 spec, item D).
CREATE TABLE waitlist_entries (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  ticket_type_id UUID NOT NULL REFERENCES ticket_types(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES users(id),
  status         TEXT NOT NULL DEFAULT 'waiting', -- waiting | notified | expired
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  notified_at    TIMESTAMPTZ,
  UNIQUE (ticket_type_id, user_id)
);

CREATE TABLE tickets (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  ticket_type_id UUID NOT NULL REFERENCES ticket_types(id),
  holder_id      UUID NOT NULL REFERENCES users(id),
  qr_token_hash  TEXT NOT NULL UNIQUE,   -- HMAC-SHA256 signature of the ticket id (FR-029, FR-032) — see src/utils/qr.js
  status         TEXT NOT NULL DEFAULT 'active', -- reserved | active | used | cancelled | expired
  used_at        TIMESTAMPTZ,
  used_by        UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Trust: reviews & reports
-- ---------------------------------------------------------------------
CREATE TABLE reviews (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id    UUID NOT NULL REFERENCES users(id),
  target_type  TEXT NOT NULL, -- product | store | listing | user
  target_id    UUID NOT NULL,
  rating       INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE reports (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id  UUID NOT NULL REFERENCES users(id),
  target_type  TEXT NOT NULL, -- product | listing | user | store | event
  target_id    UUID NOT NULL,
  reason       TEXT NOT NULL,
  details      TEXT,
  status       TEXT NOT NULL DEFAULT 'open', -- open | resolved | dismissed
  resolution   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------
CREATE TABLE notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Payments (Phase 1 = mock/sandbox provider behind the same abstraction)
-- ---------------------------------------------------------------------
CREATE TABLE payments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_type  TEXT NOT NULL, -- order | booking | ticket
  transaction_id    UUID NOT NULL,
  provider          TEXT NOT NULL DEFAULT 'mock',
  amount            NUMERIC(12,2) NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending', -- pending | confirmed | failed | refunded
  provider_ref      TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at      TIMESTAMPTZ
);

CREATE TABLE transactions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id  UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  type        TEXT NOT NULL, -- charge | refund | commission
  amount      NUMERIC(12,2) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------
CREATE TABLE audit_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    UUID REFERENCES users(id),
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   UUID,
  details     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Indexes for the query patterns the API actually uses
-- ---------------------------------------------------------------------
CREATE INDEX idx_products_store ON products(store_id);
CREATE INDEX idx_products_status ON products(status);
CREATE INDEX idx_orders_buyer ON orders(buyer_id);
CREATE INDEX idx_orders_store ON orders(store_id);
CREATE INDEX idx_listings_status ON p2p_listings(status);
CREATE INDEX idx_p2p_orders_buyer ON p2p_orders(buyer_id);
CREATE INDEX idx_p2p_orders_seller ON p2p_orders(seller_id);
CREATE INDEX idx_rental_items_status ON rental_items(status);
CREATE INDEX idx_bookings_item ON rental_bookings(rental_item_id);
CREATE INDEX idx_bookings_borrower ON rental_bookings(borrower_id);
CREATE INDEX idx_events_club ON events(club_id);
CREATE INDEX idx_events_status ON events(status);
CREATE INDEX idx_waitlist_ticket_type ON waitlist_entries(ticket_type_id, status);
CREATE INDEX idx_tickets_event ON tickets(event_id);
CREATE INDEX idx_tickets_holder ON tickets(holder_id);
CREATE INDEX idx_notifications_user ON notifications(user_id, read_at);
CREATE INDEX idx_reviews_target ON reviews(target_type, target_id);
CREATE INDEX idx_reports_status ON reports(status);
CREATE INDEX idx_payments_txn ON payments(transaction_type, transaction_id);
