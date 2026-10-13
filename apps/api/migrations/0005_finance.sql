-- Phase 6: payment integrations and methods, funds and the double-entry ledger, payments,
-- commissions and provider earnings (clauses 33-44). See docs/05-financial-design.md.

-- ---------------------------------------------------------------------------
-- Ledger (clauses 37-39, 64)
-- ---------------------------------------------------------------------------

CREATE TABLE ledger_accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country_id     uuid NOT NULL REFERENCES countries(id),
  currency_code  char(3) NOT NULL REFERENCES currencies(code),
  code           text NOT NULL CHECK (code ~ '^[0-9]{4}(-[0-9A-Z]{1,10})?$'),
  kind           text NOT NULL CHECK (kind IN (
                   'cash', 'bank', 'wallet', 'gateway',                                  -- funds (1100-1400)
                   'provider_payable_not_due', 'provider_payable_due', 'provider_payable_on_hold',
                   'customer_advances', 'refunds_payable',                               -- liabilities (2xxx)
                   'commission_revenue', 'gateway_fees', 'platform_discount_cost', 'fx_difference',
                   'direct_payments_memo', 'direct_payments_memo_contra')),
  type           text NOT NULL CHECK (type IN ('asset', 'liability', 'revenue', 'expense', 'memo')),
  name           jsonb NOT NULL CHECK (is_i18n_text(name)),
  is_system      boolean NOT NULL DEFAULT false,
  is_active      boolean NOT NULL DEFAULT true,
  -- Bank/wallet details for fund accounts (no secrets).
  details        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (country_id, currency_code, code)
);
CREATE TRIGGER ledger_accounts_updated BEFORE UPDATE ON ledger_accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- Exactly one system account per kind for each country/currency; funds may have several.
CREATE UNIQUE INDEX ledger_accounts_system_kind ON ledger_accounts (country_id, currency_code, kind) WHERE is_system;

CREATE SEQUENCE journal_number_seq;

CREATE TABLE journal_entries (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number             text NOT NULL UNIQUE DEFAULT ('JE-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('journal_number_seq')::text, 8, '0')),
  country_id         uuid NOT NULL REFERENCES countries(id),
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  description        text NOT NULL,
  source_type        text NOT NULL,      -- payment, booking_completion, earning_review, ...
  source_id          uuid,
  -- The same business event can never be posted twice.
  idempotency_key    text NOT NULL UNIQUE,
  reverses_entry_id  uuid REFERENCES journal_entries(id),
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX journal_entries_source ON journal_entries (source_type, source_id);

CREATE TABLE journal_lines (
  id             bigserial PRIMARY KEY,
  entry_id       uuid NOT NULL REFERENCES journal_entries(id),
  account_id     uuid NOT NULL REFERENCES ledger_accounts(id),
  debit          numeric(20,4) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit         numeric(20,4) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  currency_code  char(3) NOT NULL REFERENCES currencies(code),
  -- Analytical dimensions so every amount traces back to its provider, booking and payment (clause 42).
  provider_id    uuid REFERENCES providers(id),
  booking_id     uuid REFERENCES bookings(id),
  payment_id     uuid,
  memo           text,
  CHECK ((debit = 0) <> (credit = 0))
);
CREATE INDEX journal_lines_account ON journal_lines (account_id, entry_id);
CREATE INDEX journal_lines_provider ON journal_lines (provider_id) WHERE provider_id IS NOT NULL;
CREATE INDEX journal_lines_booking ON journal_lines (booking_id) WHERE booking_id IS NOT NULL;

-- A line must hit an active account of the entry's country, in the account's currency (clause 38).
CREATE OR REPLACE FUNCTION journal_line_checks() RETURNS trigger AS $$
DECLARE a ledger_accounts; e journal_entries;
BEGIN
  SELECT * INTO a FROM ledger_accounts WHERE id = NEW.account_id;
  SELECT * INTO e FROM journal_entries WHERE id = NEW.entry_id;
  IF NOT a.is_active THEN RAISE EXCEPTION 'ledger account % is inactive', a.code USING ERRCODE = 'P0001'; END IF;
  IF a.currency_code <> NEW.currency_code THEN RAISE EXCEPTION 'currency % does not match account % (%)', NEW.currency_code, a.code, a.currency_code USING ERRCODE = 'P0001'; END IF;
  IF a.country_id <> e.country_id THEN RAISE EXCEPTION 'account % belongs to another country', a.code USING ERRCODE = 'P0001'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER journal_lines_checks BEFORE INSERT ON journal_lines FOR EACH ROW EXECUTE FUNCTION journal_line_checks();

-- Every entry balances per currency, checked at commit so all lines of the entry are present.
CREATE OR REPLACE FUNCTION journal_entry_balanced() RETURNS trigger AS $$
DECLARE eid uuid; n int; bad text;
BEGIN
  -- Separate branches: a record field that does not exist on the other table must not be referenced.
  IF TG_TABLE_NAME = 'journal_entries' THEN eid := NEW.id; ELSE eid := NEW.entry_id; END IF;
  SELECT count(*) INTO n FROM journal_lines WHERE entry_id = eid;
  IF n < 2 THEN RAISE EXCEPTION 'journal entry % has fewer than two lines', eid USING ERRCODE = 'P0001'; END IF;
  SELECT string_agg(currency_code || ':' || (sum_d - sum_c)::text, ', ') INTO bad FROM (
    SELECT currency_code, sum(debit) AS sum_d, sum(credit) AS sum_c FROM journal_lines WHERE entry_id = eid GROUP BY currency_code
  ) s WHERE sum_d <> sum_c;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'journal entry % is unbalanced (%)', eid, bad USING ERRCODE = 'P0001'; END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER journal_entries_balanced AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION journal_entry_balanced();
CREATE CONSTRAINT TRIGGER journal_lines_balanced AFTER INSERT ON journal_lines DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION journal_entry_balanced();

-- Posted accounting is never edited or deleted: corrections are reversing entries (clause 51).
CREATE TRIGGER journal_entries_append_only BEFORE UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER journal_lines_append_only BEFORE UPDATE OR DELETE ON journal_lines FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- Payment integrations and methods (clauses 34-35)
-- ---------------------------------------------------------------------------

CREATE TABLE payment_integrations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_code     text NOT NULL CHECK (provider_code ~ '^[a-z][a-z0-9_]{1,40}$'),
  name              text NOT NULL,
  country_id        uuid NOT NULL REFERENCES countries(id),
  kind              text NOT NULL CHECK (kind IN ('gateway', 'wallet', 'bank', 'transfer_service')),
  environment       text NOT NULL CHECK (environment IN ('test', 'production')),
  -- Name of the environment variable holding the secret. The secret itself is never stored here or returned.
  secret_ref        text NOT NULL CHECK (secret_ref ~ '^[A-Z][A-Z0-9_]{2,100}$'),
  config            jsonb NOT NULL DEFAULT '{}'::jsonb,   -- non-secret settings only
  is_active         boolean NOT NULL DEFAULT false,
  last_test_at      timestamptz,
  last_test_status  text,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER payment_integrations_updated BEFORE UPDATE ON payment_integrations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE payment_method_rules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country_id       uuid NOT NULL REFERENCES countries(id),
  service_type_id  uuid REFERENCES service_types(id),   -- NULL = every type in the country
  model            text NOT NULL CHECK (model IN ('platform', 'direct')),
  method           text NOT NULL CHECK (method IN ('card', 'wallet', 'bank_transfer', 'cash')),
  integration_id   uuid REFERENCES payment_integrations(id),
  account_id       uuid REFERENCES ledger_accounts(id),   -- fund receiving platform payments
  proof_required   boolean NOT NULL DEFAULT false,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (model = 'direct' OR account_id IS NOT NULL),
  CHECK (model = 'platform' OR (integration_id IS NULL AND account_id IS NULL)),
  CHECK (method NOT IN ('card', 'wallet') OR model = 'direct' OR integration_id IS NOT NULL),
  UNIQUE NULLS NOT DISTINCT (country_id, service_type_id, model, method)
);
CREATE TRIGGER payment_method_rules_updated BEFORE UPDATE ON payment_method_rules FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Payments (clauses 33, 36, 46)
-- ---------------------------------------------------------------------------

CREATE SEQUENCE payment_number_seq;

CREATE TABLE payments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number             text NOT NULL UNIQUE DEFAULT ('PAY-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('payment_number_seq')::text, 8, '0')),
  order_id           uuid NOT NULL REFERENCES orders(id),
  customer_id        uuid NOT NULL REFERENCES users(id),
  country_id         uuid NOT NULL REFERENCES countries(id),
  provider_id        uuid REFERENCES providers(id),         -- set for direct payments (paid to this provider)
  rule_id            uuid NOT NULL REFERENCES payment_method_rules(id),
  model              text NOT NULL CHECK (model IN ('platform', 'direct')),
  method             text NOT NULL,
  integration_id     uuid REFERENCES payment_integrations(id),
  account_id         uuid REFERENCES ledger_accounts(id),
  purpose            text NOT NULL CHECK (purpose IN ('upfront', 'balance')),
  amount             numeric(20,4) NOT NULL CHECK (amount > 0),
  currency_code      char(3) NOT NULL REFERENCES currencies(code),
  -- What the customer says they paid vs. what was verified as received (clause 33).
  reported_amount    numeric(20,4),
  verified_amount    numeric(20,4) CHECK (verified_amount >= 0),
  gateway_fee        numeric(20,4) NOT NULL DEFAULT 0 CHECK (gateway_fee >= 0),
  status             text NOT NULL CHECK (status IN ('pending', 'awaiting_verification', 'succeeded', 'failed', 'cancelled')),
  external_ref       text,
  checkout_url       text,
  failure_reason     text,
  needs_attention    text,                                  -- e.g. 'slot_unavailable_after_payment', 'amount_mismatch'
  verified_by        uuid REFERENCES users(id),
  verified_at        timestamptz,
  review_note        text,
  idempotency_key    text NOT NULL,
  succeeded_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, idempotency_key),
  CHECK (verified_amount IS NULL OR verified_amount <= amount)
);
CREATE TRIGGER payments_updated BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE UNIQUE INDEX payments_external_ref ON payments (integration_id, external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX payments_order ON payments (order_id);
CREATE INDEX payments_status ON payments (country_id, status, created_at);

-- Which bookings a payment pays for, and how much of it was actually verified.
CREATE TABLE payment_allocations (
  payment_id       uuid NOT NULL REFERENCES payments(id),
  booking_id       uuid NOT NULL REFERENCES bookings(id),
  amount           numeric(20,4) NOT NULL CHECK (amount > 0),
  verified_amount  numeric(20,4) CHECK (verified_amount >= 0 AND verified_amount <= amount),
  PRIMARY KEY (payment_id, booking_id)
);
CREATE INDEX payment_allocations_booking ON payment_allocations (booking_id);

CREATE TABLE payment_proofs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id     uuid NOT NULL REFERENCES payments(id),
  file_key       text NOT NULL UNIQUE,
  mime_type      text NOT NULL,
  size_bytes     integer NOT NULL,
  sha256         text NOT NULL,
  uploaded_by    uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payment_status_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id   uuid NOT NULL REFERENCES payments(id),
  from_status  text,
  to_status    text NOT NULL,
  actor_id     uuid REFERENCES users(id),
  actor_kind   text NOT NULL,
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER payment_status_events_append_only BEFORE UPDATE OR DELETE ON payment_status_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Provider notifications (webhooks): stored before processing; a redelivered event is recognised and ignored.
CREATE TABLE provider_webhook_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id     uuid NOT NULL REFERENCES payment_integrations(id),
  external_event_id  text NOT NULL,
  event_type         text,
  external_ref       text,
  signature_valid    boolean NOT NULL,
  payload            jsonb NOT NULL,
  result             text NOT NULL CHECK (result IN ('processed', 'duplicate', 'rejected', 'ignored', 'error')),
  error              text,
  received_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (integration_id, external_event_id)
);

-- ---------------------------------------------------------------------------
-- Commissions (clause 40). Rules are dated; each booking keeps the rule it used.
-- ---------------------------------------------------------------------------

CREATE TABLE commission_rules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope            text NOT NULL CHECK (scope IN ('global', 'country', 'service_type', 'provider', 'service')),
  country_id       uuid REFERENCES countries(id),
  service_type_id  uuid REFERENCES service_types(id),
  provider_id      uuid REFERENCES providers(id),
  service_id       uuid REFERENCES services(id),
  rate_type        text NOT NULL CHECK (rate_type IN ('percent', 'fixed')),
  rate_value       numeric(20,4) NOT NULL CHECK (rate_value >= 0),
  currency_code    char(3) REFERENCES currencies(code),   -- required for fixed amounts
  priority         integer NOT NULL DEFAULT 0,
  valid_from       timestamptz NOT NULL DEFAULT now(),
  valid_to         timestamptz,
  agreement_ref    text,
  is_active        boolean NOT NULL DEFAULT true,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (rate_type <> 'percent' OR rate_value <= 100),
  CHECK ((rate_type = 'fixed') = (currency_code IS NOT NULL)),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CHECK ((scope = 'global') = (country_id IS NULL AND service_type_id IS NULL AND provider_id IS NULL AND service_id IS NULL)),
  CHECK (scope <> 'country' OR (country_id IS NOT NULL AND service_type_id IS NULL AND provider_id IS NULL AND service_id IS NULL)),
  CHECK (scope <> 'service_type' OR (service_type_id IS NOT NULL AND provider_id IS NULL AND service_id IS NULL)),
  CHECK (scope <> 'provider' OR (provider_id IS NOT NULL AND service_id IS NULL)),
  CHECK (scope <> 'service' OR service_id IS NOT NULL)
);

-- Rate fields of a rule never change once created; a new rate is a new rule (history stays exact).
CREATE OR REPLACE FUNCTION commission_rules_freeze() RETURNS trigger AS $$
BEGIN
  IF (NEW.scope, NEW.country_id, NEW.service_type_id, NEW.provider_id, NEW.service_id, NEW.rate_type, NEW.rate_value, NEW.currency_code, NEW.valid_from)
     IS DISTINCT FROM (OLD.scope, OLD.country_id, OLD.service_type_id, OLD.provider_id, OLD.service_id, OLD.rate_type, OLD.rate_value, OLD.currency_code, OLD.valid_from) THEN
    RAISE EXCEPTION 'commission rule terms are immutable; create a new rule' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER commission_rules_immutable BEFORE UPDATE ON commission_rules FOR EACH ROW EXECUTE FUNCTION commission_rules_freeze();
CREATE TRIGGER commission_rules_no_delete BEFORE DELETE ON commission_rules FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE booking_commissions (
  booking_id         uuid PRIMARY KEY REFERENCES bookings(id),
  rule_id            uuid REFERENCES commission_rules(id),   -- NULL: no rule applied, commission 0
  rate_type          text,
  rate_value         numeric(20,4),
  base_amount        numeric(20,4) NOT NULL,
  commission_amount  numeric(20,4) NOT NULL CHECK (commission_amount >= 0),
  currency_code      char(3) NOT NULL REFERENCES currencies(code),
  computed_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER booking_commissions_immutable BEFORE UPDATE OR DELETE ON booking_commissions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- Provider earnings (clauses 42-43). Settlement execution arrives in phase 7.
-- ---------------------------------------------------------------------------

CREATE TABLE provider_earnings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id            uuid NOT NULL UNIQUE REFERENCES bookings(id),
  provider_id           uuid NOT NULL REFERENCES providers(id),
  country_id            uuid NOT NULL REFERENCES countries(id),
  currency_code         char(3) NOT NULL REFERENCES currencies(code),
  booking_total         numeric(20,4) NOT NULL,
  collected_by_platform numeric(20,4) NOT NULL DEFAULT 0,
  collected_directly    numeric(20,4) NOT NULL DEFAULT 0,
  commission_amount     numeric(20,4) NOT NULL DEFAULT 0,
  -- collected_by_platform - commission; negative means the provider owes the platform commission.
  net_amount            numeric(20,4) NOT NULL DEFAULT 0,
  status                text NOT NULL DEFAULT 'not_due' CHECK (status IN
                          ('not_due', 'under_review', 'due', 'on_hold_dispute', 'ready_for_settlement', 'settled', 'settlement_failed', 're_reviewed')),
  due_at                timestamptz,
  status_reason         text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER provider_earnings_updated BEFORE UPDATE ON provider_earnings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX provider_earnings_provider ON provider_earnings (provider_id, status);

CREATE TABLE provider_earning_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  earning_id   uuid NOT NULL REFERENCES provider_earnings(id),
  from_status  text,
  to_status    text NOT NULL,
  actor_id     uuid REFERENCES users(id),
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER provider_earning_events_append_only BEFORE UPDATE OR DELETE ON provider_earning_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
