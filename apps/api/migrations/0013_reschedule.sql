-- Booking date changes (clause 26): the customer asks, the provider (or staff) decides within the approval window.
-- The new slot is held while the request is open so nobody else can take it; prices do not change because
-- the duration is kept and prices on this platform do not depend on the date.
CREATE TABLE booking_reschedule_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id      uuid NOT NULL REFERENCES bookings(id),
  requested_by    uuid NOT NULL REFERENCES users(id),
  old_start_at    timestamptz NOT NULL,
  old_end_at      timestamptz NOT NULL,
  new_start_at    timestamptz NOT NULL,
  new_end_at      timestamptz NOT NULL CHECK (new_end_at > new_start_at),
  hold_block_id   uuid REFERENCES calendar_blocks(id),
  reason          text,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn', 'expired')),
  deadline        timestamptz NOT NULL,
  decided_by      uuid REFERENCES users(id),
  decided_at      timestamptz,
  decision_reason text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'pending') = (decided_at IS NULL))
);
CREATE UNIQUE INDEX booking_reschedule_open ON booking_reschedule_requests (booking_id) WHERE status = 'pending';
CREATE INDEX booking_reschedule_deadline ON booking_reschedule_requests (deadline) WHERE status = 'pending';
