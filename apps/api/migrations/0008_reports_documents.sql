-- Phase 9: issued documents, report export log, reconciliation with provider/bank statements
-- (clauses 39, 61-66).

-- ---------------------------------------------------------------------------
-- Documents (clause 65): numbered per country, kind and year; content frozen at issue.
-- ---------------------------------------------------------------------------

CREATE TABLE document_counters (
  country_id  uuid NOT NULL REFERENCES countries(id),
  kind        text NOT NULL,
  year        integer NOT NULL,
  last_value  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (country_id, kind, year)
);

CREATE TABLE documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number        text NOT NULL UNIQUE,
  kind          text NOT NULL CHECK (kind IN ('invoice', 'payment_receipt', 'deposit_receipt', 'refund_note', 'settlement_note')),
  country_id    uuid NOT NULL REFERENCES countries(id),
  source_type   text NOT NULL CHECK (source_type IN ('booking', 'payment', 'refund', 'settlement')),
  source_id     uuid NOT NULL,
  customer_id   uuid REFERENCES users(id),
  provider_id   uuid REFERENCES providers(id),
  booking_id    uuid REFERENCES bookings(id),
  currency_code char(3) NOT NULL REFERENCES currencies(code),
  total         numeric(20,4) NOT NULL,
  -- Everything printed on the document, captured at issue time.
  data          jsonb NOT NULL,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  -- One document of a kind per business event (no duplicate invoice or receipt).
  UNIQUE NULLS NOT DISTINCT (kind, source_id, booking_id)
);
CREATE INDEX documents_customer ON documents (customer_id, issued_at DESC);
CREATE INDEX documents_provider ON documents (provider_id, issued_at DESC);
CREATE INDEX documents_booking ON documents (booking_id);
CREATE TRIGGER documents_immutable BEFORE UPDATE OR DELETE ON documents FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- Report exports (clauses 63, 70): who exported what, with the FX rates used for conversion.
-- ---------------------------------------------------------------------------

CREATE TABLE report_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report        text NOT NULL,
  params        jsonb NOT NULL,
  fx_rates      jsonb NOT NULL DEFAULT '[]'::jsonb,
  row_count     integer NOT NULL,
  format        text NOT NULL CHECK (format IN ('json', 'csv')),
  generated_by  uuid NOT NULL REFERENCES users(id),
  generated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER report_runs_append_only BEFORE UPDATE OR DELETE ON report_runs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- Reconciliation (clause 39)
-- ---------------------------------------------------------------------------

CREATE TABLE reconciliation_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country_id      uuid NOT NULL REFERENCES countries(id),
  integration_id  uuid REFERENCES payment_integrations(id),
  account_id      uuid REFERENCES ledger_accounts(id),
  period_from     date NOT NULL,
  period_to       date NOT NULL,
  source_name     text NOT NULL,
  summary         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (period_to >= period_from),
  CHECK (integration_id IS NOT NULL OR account_id IS NOT NULL)
);

CREATE TABLE reconciliation_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          uuid NOT NULL REFERENCES reconciliation_runs(id),
  status          text NOT NULL CHECK (status IN ('matched', 'amount_mismatch', 'currency_mismatch', 'missing_in_platform', 'missing_in_statement', 'status_mismatch')),
  kind            text NOT NULL CHECK (kind IN ('payment', 'refund', 'other')),
  external_ref    text,
  payment_id      uuid REFERENCES payments(id),
  refund_id       uuid REFERENCES refunds(id),
  statement_amount numeric(20,4),
  platform_amount  numeric(20,4),
  currency_code   char(3),
  note            text,
  resolved_by     uuid REFERENCES users(id),
  resolved_at     timestamptz,
  resolution      text
);
CREATE INDEX reconciliation_items_run ON reconciliation_items (run_id, status);
CREATE TRIGGER reconciliation_runs_append_only BEFORE UPDATE OR DELETE ON reconciliation_runs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Items are findings: they are never deleted or rewritten; only a one-time resolution may be recorded.
CREATE OR REPLACE FUNCTION reconciliation_item_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'reconciliation items cannot be deleted' USING ERRCODE = 'P0001'; END IF;
  IF OLD.resolved_at IS NOT NULL OR
     (NEW.run_id, NEW.status, NEW.kind, NEW.external_ref, NEW.payment_id, NEW.refund_id, NEW.statement_amount, NEW.platform_amount, NEW.currency_code, NEW.note)
       IS DISTINCT FROM
     (OLD.run_id, OLD.status, OLD.kind, OLD.external_ref, OLD.payment_id, OLD.refund_id, OLD.statement_amount, OLD.platform_amount, OLD.currency_code, OLD.note) THEN
    RAISE EXCEPTION 'reconciliation items are immutable once recorded or resolved' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER reconciliation_items_guard BEFORE UPDATE OR DELETE ON reconciliation_items FOR EACH ROW EXECUTE FUNCTION reconciliation_item_guard();
