-- Onsale core schema.
-- Postgres is the system of record for what has been SOLD.
-- Redis holds the fast, expiring state (queue, admissions, seat holds).
-- The UNIQUE(event_id, seat_id) constraint on order_seats is the last line of
-- defence against overselling: even if every Redis guard failed, the database
-- would reject a second sale of the same seat.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text NOT NULL UNIQUE,
  name         text NOT NULL,
  venue        text NOT NULL,
  starts_at    timestamptz NOT NULL,
  onsale_at    timestamptz NOT NULL,
  -- Presentation-only seat-map geometry (section positions). Not used for any business rule.
  layout       jsonb NOT NULL DEFAULT '[]',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE seats (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  section      text NOT NULL,
  row_label    text NOT NULL,
  seat_number  int  NOT NULL,
  price_cents  int  NOT NULL CHECK (price_cents >= 0),
  UNIQUE (event_id, section, row_label, seat_number)
);
CREATE INDEX seats_event_idx ON seats(event_id);

CREATE TYPE order_status AS ENUM ('pending', 'paid', 'failed');

CREATE TABLE orders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  session_id     text NOT NULL,
  status         order_status NOT NULL DEFAULT 'pending',
  subtotal_cents int  NOT NULL,
  fees_cents     int  NOT NULL,
  total_cents    int  NOT NULL,
  payment_ref    text,
  failure_reason text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_event_status_idx ON orders(event_id, status);
CREATE INDEX orders_pending_idx ON orders(created_at) WHERE status = 'pending';

CREATE TABLE order_seats (
  order_id  uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  event_id  uuid NOT NULL,
  seat_id   uuid NOT NULL REFERENCES seats(id),
  PRIMARY KEY (order_id, seat_id),
  -- The hard guarantee: one seat, one live order.
  CONSTRAINT one_order_per_seat UNIQUE (event_id, seat_id)
);

-- Stripe-style idempotency: a retried POST with the same key returns the
-- original response instead of charging twice.
CREATE TABLE idempotency_keys (
  key            text NOT NULL,
  session_id     text NOT NULL,
  request_hash   text NOT NULL,
  status         text NOT NULL CHECK (status IN ('in_progress', 'completed')),
  response_code  int,
  response_body  jsonb,
  -- Set once an order exists, so an interrupted request can be settled by the reconciler.
  order_id       uuid REFERENCES orders(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, key)
);
CREATE INDEX idempotency_created_idx ON idempotency_keys(created_at);
