-- Phase 7: cancellation of paid bookings, refunds and provider settlements (clauses 43-44, 49-50).
-- See docs/05-financial-design.md sections 9-11.

-- ---------------------------------------------------------------------------
-- Cancellation requests needing a staff decision (policy requires manual review, or no policy).
-- ---------------------------------------------------------------------------

CREATE TABLE cancellation_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id         uuid NOT NULL REFERENCES bookings(id),
  requested_by       uuid NOT NULL REFERENCES users(id),
  reason             text NOT NULL,
  -- What the policy gives at request time; the decision may differ and is recorded separately.
  computed_refund    numeric(20,4) NOT NULL,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  approved_refund    numeric(20,4),
  decided_by         uuid REFERENCES users(id),
  decided_at         timestamptz,
  decision_reason    text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX cancellation_requests_one_pending ON cancellation_requests (booking_id) WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- Refunds (clause 50): one row per original payment refunded, never deleting the payment.
-- ---------------------------------------------------------------------------

CREATE SEQUENCE refund_number_seq;

CREATE TABLE refunds (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number             text NOT NULL UNIQUE DEFAULT ('RFD-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('refund_number_seq')::text, 8, '0')),
  booking_id         uuid NOT NULL REFERENCES bookings(id),
  payment_id         uuid NOT NULL REFERENCES payments(id),
  amount             numeric(20,4) NOT NULL CHECK (amount > 0),
  currency_code      char(3) NOT NULL REFERENCES currencies(code),
  source             text NOT NULL CHECK (source IN ('cancellation_policy', 'provider_cancellation', 'admin_cancellation', 'no_show_policy',
                                                     'slot_unavailable', 'booking_cancelled', 'manual')),
  reason             text NOT NULL,
  method             text NOT NULL CHECK (method IN ('original_gateway', 'bank_transfer', 'cash', 'wallet')),
  status             text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'processing', 'completed', 'rejected', 'failed')),
  requested_by       uuid REFERENCES users(id),
  requested_by_kind  text NOT NULL,
  reviewed_by        uuid REFERENCES users(id),
  approved_by        uuid REFERENCES users(id),
  approved_at        timestamptz,
  executed_by        uuid REFERENCES users(id),
  executed_at        timestamptz,
  external_ref       text,
  failure_reason     text,
  rejection_reason   text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER refunds_updated BEFORE UPDATE ON refunds FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX refunds_booking ON refunds (booking_id);
CREATE INDEX refunds_status ON refunds (status, created_at);
CREATE UNIQUE INDEX refunds_external_ref ON refunds (payment_id, external_ref) WHERE external_ref IS NOT NULL;

-- Refunds on a payment can never exceed what was verified for that booking on that payment (clauses 50, 72).
CREATE OR REPLACE FUNCTION refunds_cap() RETURNS trigger AS $$
DECLARE cap numeric; used numeric;
BEGIN
  IF NEW.status IN ('rejected', 'failed') THEN RETURN NEW; END IF;
  SELECT a.verified_amount INTO cap FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
   WHERE a.payment_id = NEW.payment_id AND a.booking_id = NEW.booking_id AND p.status = 'succeeded' AND p.model = 'platform'
   FOR UPDATE OF a;
  IF cap IS NULL THEN RAISE EXCEPTION 'payment % has no verified platform amount for booking %', NEW.payment_id, NEW.booking_id USING ERRCODE = 'P0001'; END IF;
  SELECT coalesce(sum(amount), 0) INTO used FROM refunds
   WHERE payment_id = NEW.payment_id AND booking_id = NEW.booking_id AND status NOT IN ('rejected', 'failed') AND id <> NEW.id;
  IF used + NEW.amount > cap THEN
    RAISE EXCEPTION 'refund exceeds refundable amount (% + % > %)', used, NEW.amount, cap USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER refunds_cap_check BEFORE INSERT OR UPDATE OF amount, status ON refunds FOR EACH ROW EXECUTE FUNCTION refunds_cap();
CREATE TRIGGER refunds_no_delete BEFORE DELETE ON refunds FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE refund_status_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_id    uuid NOT NULL REFERENCES refunds(id),
  from_status  text,
  to_status    text NOT NULL,
  actor_id     uuid REFERENCES users(id),
  actor_kind   text NOT NULL,
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER refund_status_events_append_only BEFORE UPDATE OR DELETE ON refund_status_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- Interim settlement eligibility (clause 44): explicit per provider, backed by an agreement.
-- ---------------------------------------------------------------------------

ALTER TABLE providers ADD COLUMN interim_max_percent numeric(5,2) CHECK (interim_max_percent > 0 AND interim_max_percent <= 100);
ALTER TABLE providers ADD COLUMN interim_agreement_ref text;
ALTER TABLE providers ADD CONSTRAINT providers_interim_terms
  CHECK (NOT interim_settlement_eligible OR (interim_max_percent IS NOT NULL AND interim_agreement_ref IS NOT NULL));

-- ---------------------------------------------------------------------------
-- Settlements (clause 43)
-- ---------------------------------------------------------------------------

CREATE SEQUENCE settlement_number_seq;

CREATE TABLE settlements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number           text NOT NULL UNIQUE DEFAULT ('STL-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('settlement_number_seq')::text, 8, '0')),
  provider_id      uuid NOT NULL REFERENCES providers(id),
  country_id       uuid NOT NULL REFERENCES countries(id),
  currency_code    char(3) NOT NULL REFERENCES currencies(code),
  kind             text NOT NULL CHECK (kind IN ('regular', 'interim')),
  amount           numeric(20,4) NOT NULL CHECK (amount > 0),
  method           text NOT NULL CHECK (method IN ('bank_transfer', 'cash', 'wallet')),
  account_id       uuid NOT NULL REFERENCES ledger_accounts(id),   -- fund paying out
  status           text NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval', 'approved', 'paid', 'failed', 'cancelled')),
  created_by       uuid NOT NULL REFERENCES users(id),
  approved_by      uuid REFERENCES users(id),
  approved_at      timestamptz,
  paid_by          uuid REFERENCES users(id),
  paid_at          timestamptz,
  external_ref     text,
  failure_reason   text,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (approved_by IS NULL OR approved_by <> created_by)   -- four-eyes
);
CREATE TRIGGER settlements_updated BEFORE UPDATE ON settlements FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX settlements_provider ON settlements (provider_id, status);

CREATE TABLE settlement_items (
  settlement_id  uuid NOT NULL REFERENCES settlements(id),
  earning_id     uuid NOT NULL REFERENCES provider_earnings(id),
  booking_id     uuid NOT NULL REFERENCES bookings(id),
  -- Negative amounts offset what the provider owes (e.g. commission on direct payments).
  amount         numeric(20,4) NOT NULL CHECK (amount <> 0),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'void')),
  PRIMARY KEY (settlement_id, earning_id)
);
-- An earning can be in at most one settlement that is still open: the same money is never settled twice (clause 72).
CREATE UNIQUE INDEX settlement_items_one_open ON settlement_items (earning_id) WHERE status = 'pending';

CREATE TABLE settlement_status_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id  uuid NOT NULL REFERENCES settlements(id),
  from_status    text,
  to_status      text NOT NULL,
  actor_id       uuid REFERENCES users(id),
  reason         text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER settlement_status_events_append_only BEFORE UPDATE OR DELETE ON settlement_status_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
