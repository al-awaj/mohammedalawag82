-- Phase 4: calendar, availability, external bookings and conflict prevention (clauses 26-28, 32).
-- See docs/03-database-design.md section C.

-- How many bookings of the same service may overlap in time (1 = exclusive, e.g. a hall).
ALTER TABLE services ADD COLUMN max_concurrent_bookings integer NOT NULL DEFAULT 1 CHECK (max_concurrent_bookings BETWEEN 1 AND 1000);
-- Start-time granularity for time-slot services; NULL = the service duration.
ALTER TABLE services ADD COLUMN slot_step_minutes integer CHECK (slot_step_minutes BETWEEN 5 AND 1440);

-- Weekly opening hours in the service country's local time. No rows = open all day, every day.
CREATE TABLE availability_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id  uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),   -- 0 = Sunday
  start_time  time NOT NULL,
  end_time    time NOT NULL,                                       -- '24:00' allowed
  CHECK (end_time > start_time)
);
CREATE INDEX availability_rules_service ON availability_rules (service_id, weekday);

-- One row per occupied interval. Holds, confirmed bookings, external bookings and closures all live
-- here so a single set of rules decides availability for every channel (app, web, provider panel).
CREATE TABLE calendar_blocks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id      uuid NOT NULL REFERENCES services(id),
  rental_item_id  uuid REFERENCES rental_items(id),
  kind            text NOT NULL CHECK (kind IN ('hold', 'booking', 'external', 'closed')),
  period          tstzrange NOT NULL CHECK (NOT isempty(period) AND lower_inc(period) AND NOT upper_inc(period)
                                            AND NOT lower_inf(period) AND NOT upper_inf(period)),
  -- period widened by the type's preparation/cleanup buffers; conflicts are checked on this range.
  blocked_period  tstzrange NOT NULL,
  units           integer NOT NULL DEFAULT 1 CHECK (units > 0),
  -- true when the block alone fills the service (capacity 1, not a rental item): enforced by the
  -- exclusion constraint below as a database-level backstop to the locked capacity check.
  exclusive       boolean NOT NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  expires_at      timestamptz,
  booking_ref     uuid,            -- set by the booking module (phase 5)
  reason          text,
  internal_notes  text,            -- never exposed publicly (clause 27)
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  released_at     timestamptz,
  released_by     uuid REFERENCES users(id),
  release_reason  text,
  CHECK ((kind = 'hold') = (expires_at IS NOT NULL)),
  CHECK (blocked_period @> period),
  CHECK ((status = 'released') = (released_at IS NOT NULL)),
  CONSTRAINT calendar_blocks_no_overlap EXCLUDE USING gist (service_id WITH =, blocked_period WITH &&)
    WHERE (status = 'active' AND exclusive)
);
CREATE INDEX calendar_blocks_lookup ON calendar_blocks USING gist (service_id, blocked_period) WHERE status = 'active';
CREATE INDEX calendar_blocks_expiring ON calendar_blocks (expires_at) WHERE status = 'active' AND kind = 'hold';
CREATE INDEX calendar_blocks_booking ON calendar_blocks (booking_ref) WHERE booking_ref IS NOT NULL;
