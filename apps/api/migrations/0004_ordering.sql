-- Phase 5: events, cart, orders and per-service bookings with price/terms snapshots (clauses 24-25, 29-32).
-- See docs/03-database-design.md section D.

CREATE TABLE events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      uuid NOT NULL REFERENCES users(id),
  name             text NOT NULL CHECK (length(name) BETWEEN 2 AND 200),
  event_type       text NOT NULL CHECK (event_type IN ('wedding', 'engagement', 'birthday', 'graduation', 'success', 'family',
                                                       'conference', 'official', 'religious', 'social', 'other')),
  country_id       uuid NOT NULL REFERENCES countries(id),
  city             text NOT NULL,
  location         text,
  latitude         numeric(9,6) CHECK (latitude BETWEEN -90 AND 90),
  longitude        numeric(9,6) CHECK (longitude BETWEEN -180 AND 180),
  event_date       date NOT NULL,
  starts_at        timestamptz,
  ends_at          timestamptz,
  expected_guests  integer CHECK (expected_guests > 0),
  budget_amount    numeric(20,4) CHECK (budget_amount >= 0),
  budget_currency  char(3) REFERENCES currencies(code),
  notes            text,
  status           text NOT NULL DEFAULT 'planning' CHECK (status IN ('planning', 'confirmed', 'completed', 'cancelled')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((budget_amount IS NULL) = (budget_currency IS NULL)),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);
CREATE TRIGGER events_updated BEFORE UPDATE ON events FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX events_customer ON events (customer_id, event_date);

-- ---------------------------------------------------------------------------
-- Cart: one per customer. Prices shown are recomputed live; quoted_total only detects changes at checkout.
-- ---------------------------------------------------------------------------

CREATE TABLE cart_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     uuid NOT NULL REFERENCES users(id),
  service_id      uuid NOT NULL REFERENCES services(id),
  package_id      uuid REFERENCES packages(id),
  rental_item_id  uuid REFERENCES rental_items(id),
  event_id        uuid REFERENCES events(id),
  start_at        timestamptz NOT NULL,
  end_at          timestamptz NOT NULL,
  units           integer NOT NULL DEFAULT 1 CHECK (units > 0),
  guests          integer CHECK (guests > 0),
  add_ons         text[] NOT NULL DEFAULT '{}',
  notes           text,
  quoted_total    numeric(20,4) NOT NULL,
  currency_code   char(3) NOT NULL REFERENCES currencies(code),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at)
);
CREATE INDEX cart_items_customer ON cart_items (customer_id, created_at);

-- ---------------------------------------------------------------------------
-- Orders and bookings (clause 31)
-- ---------------------------------------------------------------------------

CREATE SEQUENCE order_number_seq;
CREATE SEQUENCE booking_number_seq;

CREATE TABLE orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number           text NOT NULL UNIQUE DEFAULT ('ORD-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('order_number_seq')::text, 7, '0')),
  customer_id      uuid NOT NULL REFERENCES users(id),
  event_id         uuid REFERENCES events(id),
  country_id       uuid NOT NULL REFERENCES countries(id),
  currency_code    char(3) NOT NULL REFERENCES currencies(code),
  subtotal         numeric(20,4) NOT NULL CHECK (subtotal >= 0),
  total            numeric(20,4) NOT NULL CHECK (total >= 0),
  upfront_total    numeric(20,4) NOT NULL CHECK (upfront_total >= 0),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'closed')),
  idempotency_key  text NOT NULL,
  terms_version_id uuid NOT NULL REFERENCES terms_versions(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- Retrying a checkout with the same key returns the same order instead of creating another one.
  UNIQUE (customer_id, idempotency_key)
);
CREATE TRIGGER orders_updated BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE bookings (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number                    text NOT NULL UNIQUE DEFAULT ('BKG-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('booking_number_seq')::text, 7, '0')),
  order_id                  uuid NOT NULL REFERENCES orders(id),
  customer_id               uuid NOT NULL REFERENCES users(id),
  provider_id               uuid NOT NULL REFERENCES providers(id),
  service_id                uuid NOT NULL REFERENCES services(id),
  package_id                uuid REFERENCES packages(id),
  rental_item_id            uuid REFERENCES rental_items(id),
  event_id                  uuid REFERENCES events(id),
  country_id                uuid NOT NULL REFERENCES countries(id),
  start_at                  timestamptz NOT NULL,
  end_at                    timestamptz NOT NULL,
  units                     integer NOT NULL DEFAULT 1,
  guests                    integer,
  calendar_block_id         uuid REFERENCES calendar_blocks(id),
  -- Snapshots: later edits to the service, package, policy or terms never change an existing booking (clauses 20, 45, 66).
  service_title             jsonb NOT NULL,
  package_name              jsonb,
  pricing_unit              text NOT NULL,
  unit_price                numeric(20,4) NOT NULL,
  quantity_factor           numeric(20,6) NOT NULL,
  add_ons                   jsonb NOT NULL DEFAULT '[]'::jsonb,
  subtotal                  numeric(20,4) NOT NULL CHECK (subtotal >= 0),
  total                     numeric(20,4) NOT NULL CHECK (total >= 0),
  currency_code             char(3) NOT NULL REFERENCES currencies(code),
  deposit_type              text NOT NULL CHECK (deposit_type IN ('none', 'fixed', 'percent')),
  deposit_value             numeric(20,4) NOT NULL,
  -- What must be paid to secure the booking: the deposit, or the full total when there is no deposit.
  upfront_amount            numeric(20,4) NOT NULL CHECK (upfront_amount >= 0 AND upfront_amount <= total),
  balance_due_at            timestamptz,
  security_deposit_amount   numeric(20,4) NOT NULL DEFAULT 0,
  cancellation_policy       jsonb,
  terms_snapshot            jsonb NOT NULL DEFAULT '{}'::jsonb,
  requires_provider_approval boolean NOT NULL,
  status                    text NOT NULL CHECK (status IN ('pending_provider_approval', 'awaiting_payment', 'confirmed', 'in_progress',
                                                            'completed', 'no_show', 'rejected', 'expired',
                                                            'cancelled_by_customer', 'cancelled_by_provider', 'cancelled_by_admin')),
  hold_expires_at           timestamptz,
  approval_deadline         timestamptz,
  expiry_warning_sent_at    timestamptz,
  decided_at                timestamptz,
  decided_by                uuid REFERENCES users(id),
  decision_reason           text,
  customer_notes            text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at)
);
CREATE TRIGGER bookings_updated BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX bookings_order ON bookings (order_id);
CREATE INDEX bookings_customer ON bookings (customer_id, start_at);
CREATE INDEX bookings_provider ON bookings (provider_id, status, start_at);
CREATE INDEX bookings_country ON bookings (country_id, status, start_at);
CREATE INDEX bookings_pending ON bookings (status, hold_expires_at) WHERE status IN ('pending_provider_approval', 'awaiting_payment');
CREATE INDEX bookings_package ON bookings (package_id, start_at) WHERE package_id IS NOT NULL;

-- Snapshot columns are frozen once written: only state/decision fields may change afterwards.
CREATE OR REPLACE FUNCTION bookings_freeze_snapshot() RETURNS trigger AS $$
BEGIN
  IF (NEW.unit_price, NEW.quantity_factor, NEW.subtotal, NEW.total, NEW.currency_code, NEW.deposit_type, NEW.deposit_value,
      NEW.upfront_amount, NEW.add_ons, NEW.cancellation_policy, NEW.terms_snapshot, NEW.service_title, NEW.package_name,
      NEW.pricing_unit, NEW.requires_provider_approval, NEW.order_id, NEW.customer_id, NEW.provider_id, NEW.service_id)
     IS DISTINCT FROM
     (OLD.unit_price, OLD.quantity_factor, OLD.subtotal, OLD.total, OLD.currency_code, OLD.deposit_type, OLD.deposit_value,
      OLD.upfront_amount, OLD.add_ons, OLD.cancellation_policy, OLD.terms_snapshot, OLD.service_title, OLD.package_name,
      OLD.pricing_unit, OLD.requires_provider_approval, OLD.order_id, OLD.customer_id, OLD.provider_id, OLD.service_id) THEN
    RAISE EXCEPTION 'booking % snapshot fields are immutable', OLD.number USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER bookings_snapshot_immutable BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION bookings_freeze_snapshot();

CREATE TABLE booking_status_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   uuid NOT NULL REFERENCES bookings(id),
  from_status  text,
  to_status    text NOT NULL,
  actor_id     uuid REFERENCES users(id),
  actor_kind   text NOT NULL,
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX booking_status_events_booking ON booking_status_events (booking_id, created_at);
CREATE TRIGGER booking_status_events_append_only BEFORE UPDATE OR DELETE ON booking_status_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE calendar_blocks ADD CONSTRAINT calendar_blocks_booking_fk FOREIGN KEY (booking_ref) REFERENCES bookings(id) DEFERRABLE INITIALLY DEFERRED;
