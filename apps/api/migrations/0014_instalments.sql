-- Instalment plans and partial payments (clauses 45-48).
-- A plan splits the balance (total minus the deposit) into dated instalments: [{"percent": "40", "daysBefore": 60}, ...].
-- It is defined on the service or the package and copied into each booking as a dated schedule that never changes afterwards.
ALTER TABLE services ADD COLUMN instalment_plan jsonb CHECK (instalment_plan IS NULL OR jsonb_typeof(instalment_plan) = 'array');
ALTER TABLE packages ADD COLUMN instalment_plan jsonb CHECK (instalment_plan IS NULL OR jsonb_typeof(instalment_plan) = 'array');
-- Booking schedule: [{"seq": 1, "percent": "40", "amount": "4000.0000", "dueAt": "..."}]
ALTER TABLE bookings ADD COLUMN instalment_plan jsonb CHECK (instalment_plan IS NULL OR jsonb_typeof(instalment_plan) = 'array');

CREATE OR REPLACE FUNCTION bookings_freeze_snapshot() RETURNS trigger AS $$
BEGIN
  IF (NEW.unit_price, NEW.quantity_factor, NEW.subtotal, NEW.total, NEW.currency_code, NEW.deposit_type, NEW.deposit_value,
      NEW.upfront_amount, NEW.add_ons, NEW.cancellation_policy, NEW.terms_snapshot, NEW.service_title, NEW.package_name,
      NEW.pricing_unit, NEW.requires_provider_approval, NEW.order_id, NEW.customer_id, NEW.provider_id, NEW.service_id, NEW.instalment_plan IS NULL)
     IS DISTINCT FROM
     (OLD.unit_price, OLD.quantity_factor, OLD.subtotal, OLD.total, OLD.currency_code, OLD.deposit_type, OLD.deposit_value,
      OLD.upfront_amount, OLD.add_ons, OLD.cancellation_policy, OLD.terms_snapshot, OLD.service_title, OLD.package_name,
      OLD.pricing_unit, OLD.requires_provider_approval, OLD.order_id, OLD.customer_id, OLD.provider_id, OLD.service_id, OLD.instalment_plan IS NULL) THEN
    RAISE EXCEPTION 'booking % snapshot fields are immutable', OLD.number USING ERRCODE = 'P0001';
  END IF;
  -- Instalment amounts are fixed; only their due dates move when the booking date changes (approved reschedule).
  IF NEW.instalment_plan IS NOT NULL AND OLD.instalment_plan IS NOT NULL AND
     (SELECT array_agg(x->>'amount' ORDER BY (x->>'seq')::int) FROM jsonb_array_elements(NEW.instalment_plan) x) IS DISTINCT FROM
     (SELECT array_agg(x->>'amount' ORDER BY (x->>'seq')::int) FROM jsonb_array_elements(OLD.instalment_plan) x) THEN
    RAISE EXCEPTION 'booking % instalment amounts are immutable', OLD.number USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- One reminder per instalment and rule.
ALTER TABLE reminder_rules DROP CONSTRAINT IF EXISTS reminder_rules_kind_check;
ALTER TABLE reminder_rules ADD CONSTRAINT reminder_rules_kind_check CHECK (kind IN ('before_balance_due', 'balance_overdue', 'before_event', 'before_instalment_due'));
CREATE TABLE booking_instalment_reminders (
  booking_id  uuid NOT NULL REFERENCES bookings(id),
  rule_id     uuid NOT NULL REFERENCES reminder_rules(id),
  seq         integer NOT NULL,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (booking_id, rule_id, seq)
);
