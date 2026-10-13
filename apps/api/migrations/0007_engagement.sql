-- Phase 8: notifications (templates, channels, delivery, reminders), disputes and complaints,
-- promotions and coupons, reviews (clauses 48, 51-56).

-- ---------------------------------------------------------------------------
-- Notifications (clauses 52-54)
-- ---------------------------------------------------------------------------

CREATE TABLE notification_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_.]{2,100}$'),
  channel     text NOT NULL CHECK (channel IN ('sms', 'email', 'whatsapp', 'push', 'web')),
  language    text NOT NULL REFERENCES languages(code),
  subject     text,
  body        text NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  is_active   boolean NOT NULL DEFAULT true,
  updated_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (key, channel, language)
);
CREATE TRIGGER notification_templates_updated BEFORE UPDATE ON notification_templates FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- How each channel is delivered in a country. Secrets live in environment variables (secret_ref).
CREATE TABLE messaging_channels (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country_id  uuid REFERENCES countries(id),            -- NULL = platform default
  channel     text NOT NULL CHECK (channel IN ('sms', 'email', 'whatsapp', 'push')),
  driver      text NOT NULL CHECK (driver IN ('http_json')),
  endpoint    text NOT NULL CHECK (endpoint ~ '^https?://'),
  secret_ref  text NOT NULL CHECK (secret_ref ~ '^[A-Z][A-Z0-9_]{2,100}$'),
  sender_id   text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (country_id, channel)
);
CREATE TRIGGER messaging_channels_updated BEFORE UPDATE ON messaging_channels FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Delivery log (clause 54): rendered content (with secrets masked), attempts, provider reference.
ALTER TABLE message_outbox ADD COLUMN subject text;
ALTER TABLE message_outbox ADD COLUMN body text;
ALTER TABLE message_outbox ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE message_outbox ADD COLUMN read_at timestamptz;     -- in-app (web) notifications
DROP INDEX message_outbox_pending;
CREATE INDEX message_outbox_due ON message_outbox (next_attempt_at) WHERE status = 'pending';
CREATE INDEX message_outbox_inbox ON message_outbox (recipient_user_id, created_at DESC) WHERE channel = 'web';

-- Automatic reminders (clause 48).
CREATE TABLE reminder_rules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL CHECK (kind IN ('before_balance_due', 'balance_overdue', 'before_event')),
  days_before      integer NOT NULL DEFAULT 0 CHECK (days_before BETWEEN 0 AND 365),
  country_id       uuid REFERENCES countries(id),
  service_type_id  uuid REFERENCES service_types(id),
  template_key     text NOT NULL,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE booking_reminders (
  booking_id  uuid NOT NULL REFERENCES bookings(id),
  rule_id     uuid NOT NULL REFERENCES reminder_rules(id),
  sent_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (booking_id, rule_id)
);

-- ---------------------------------------------------------------------------
-- Disputes and complaints (clause 51)
-- ---------------------------------------------------------------------------

CREATE SEQUENCE dispute_number_seq;

CREATE TABLE disputes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number            text NOT NULL UNIQUE DEFAULT ('DSP-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('dispute_number_seq')::text, 7, '0')),
  kind              text NOT NULL CHECK (kind IN ('dispute', 'complaint')),   -- complaint = to the administration, no other party
  booking_id        uuid REFERENCES bookings(id),
  payment_id        uuid REFERENCES payments(id),
  country_id        uuid NOT NULL REFERENCES countries(id),
  complainant_id    uuid NOT NULL REFERENCES users(id),
  complainant_role  text NOT NULL CHECK (complainant_role IN ('customer', 'provider')),
  respondent_role   text CHECK (respondent_role IN ('customer', 'provider')),
  type              text NOT NULL CHECK (type IN ('service_not_delivered', 'service_quality', 'billing', 'refund', 'damage', 'behaviour', 'other')),
  subject           text NOT NULL CHECK (length(subject) BETWEEN 3 AND 200),
  description       text NOT NULL CHECK (length(description) BETWEEN 10 AND 10000),
  disputed_amount   numeric(20,4) CHECK (disputed_amount > 0),
  currency_code     char(3) REFERENCES currencies(code),
  held_amount       numeric(20,4) NOT NULL DEFAULT 0 CHECK (held_amount >= 0),
  status            text NOT NULL DEFAULT 'new' CHECK (status IN
                      ('new', 'under_review', 'awaiting_info', 'awaiting_response', 'deciding', 'resolution_approved', 'rejected', 'settled', 'closed')),
  assigned_to       uuid REFERENCES users(id),
  decision          jsonb,
  decided_by        uuid REFERENCES users(id),
  decided_at        timestamptz,
  closed_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'dispute') = (booking_id IS NOT NULL AND respondent_role IS NOT NULL)),
  CHECK ((disputed_amount IS NULL) = (currency_code IS NULL))
);
CREATE TRIGGER disputes_updated BEFORE UPDATE ON disputes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX disputes_status ON disputes (country_id, status, created_at);
CREATE INDEX disputes_booking ON disputes (booking_id);
CREATE UNIQUE INDEX disputes_one_open_per_booking ON disputes (booking_id, complainant_role)
  WHERE booking_id IS NOT NULL AND status NOT IN ('settled', 'closed', 'rejected');

-- Case file: statements, actions, decisions. Append-only (clause 51: full audit, nothing hidden).
CREATE TABLE dispute_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id   uuid NOT NULL REFERENCES disputes(id),
  actor_id     uuid REFERENCES users(id),
  actor_role   text NOT NULL CHECK (actor_role IN ('customer', 'provider', 'staff', 'system')),
  action       text NOT NULL,
  from_status  text,
  to_status    text,
  note         text,
  -- 'internal' = staff only; 'parties' = both parties may read it.
  visibility   text NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal', 'parties', 'author')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dispute_events_dispute ON dispute_events (dispute_id, created_at);
CREATE TRIGGER dispute_events_append_only BEFORE UPDATE OR DELETE ON dispute_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE dispute_evidence (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id    uuid NOT NULL REFERENCES disputes(id),
  uploaded_by   uuid NOT NULL REFERENCES users(id),
  party_role    text NOT NULL CHECK (party_role IN ('customer', 'provider', 'staff')),
  file_key      text NOT NULL UNIQUE,
  mime_type     text NOT NULL,
  size_bytes    integer NOT NULL,
  sha256        text NOT NULL,
  description   text,
  shared        boolean NOT NULL DEFAULT false,   -- staff may share with the other party
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- Evidence is never deleted; only the sharing flag may change (clause 51: protected from deletion).
CREATE OR REPLACE FUNCTION dispute_evidence_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'dispute evidence cannot be deleted' USING ERRCODE = 'P0001'; END IF;
  IF (NEW.dispute_id, NEW.uploaded_by, NEW.file_key, NEW.sha256, NEW.mime_type, NEW.size_bytes) IS DISTINCT FROM
     (OLD.dispute_id, OLD.uploaded_by, OLD.file_key, OLD.sha256, OLD.mime_type, OLD.size_bytes) THEN
    RAISE EXCEPTION 'dispute evidence is immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER dispute_evidence_protected BEFORE UPDATE OR DELETE ON dispute_evidence FOR EACH ROW EXECUTE FUNCTION dispute_evidence_guard();

-- Refunds decided in a dispute after the service was delivered are charged to the provider or to the
-- platform's commission instead of customer advances.
ALTER TABLE refunds ADD COLUMN dispute_id uuid REFERENCES disputes(id);
ALTER TABLE refunds ADD COLUMN charge_to text NOT NULL DEFAULT 'customer_advances' CHECK (charge_to IN ('customer_advances', 'provider', 'platform'));
ALTER TABLE refunds DROP CONSTRAINT refunds_source_check;
ALTER TABLE refunds ADD CONSTRAINT refunds_source_check CHECK (source IN ('cancellation_policy', 'provider_cancellation', 'admin_cancellation',
  'no_show_policy', 'slot_unavailable', 'booking_cancelled', 'manual', 'dispute'));

-- ---------------------------------------------------------------------------
-- Promotions and coupons (clause 55)
-- ---------------------------------------------------------------------------

CREATE TABLE promotions (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                       text UNIQUE CHECK (code ~ '^[A-Z0-9_-]{3,30}$'),
  name                       jsonb NOT NULL CHECK (is_i18n_text(name)),
  terms                      jsonb CHECK (terms IS NULL OR is_i18n_text(terms)),
  discount_type              text NOT NULL CHECK (discount_type IN ('percent', 'fixed')),
  discount_value             numeric(20,4) NOT NULL CHECK (discount_value > 0),
  currency_code              char(3) REFERENCES currencies(code),
  max_discount               numeric(20,4) CHECK (max_discount > 0),
  min_booking_total          numeric(20,4) CHECK (min_booking_total >= 0),
  starts_at                  timestamptz NOT NULL,
  ends_at                    timestamptz NOT NULL,
  usage_limit_total          integer CHECK (usage_limit_total > 0),
  usage_limit_per_customer   integer CHECK (usage_limit_per_customer > 0),
  country_id                 uuid REFERENCES countries(id),
  service_type_ids           uuid[],
  service_ids                uuid[],
  provider_id                uuid REFERENCES providers(id),   -- set when a provider created it (provider-borne, own services only)
  -- Who pays for the discount must be explicit (clause 55); shared splits by provider_share_percent.
  cost_bearer                text NOT NULL CHECK (cost_bearer IN ('platform', 'provider', 'shared')),
  provider_share_percent     numeric(5,2) CHECK (provider_share_percent BETWEEN 0 AND 100),
  is_active                  boolean NOT NULL DEFAULT true,
  created_by                 uuid NOT NULL REFERENCES users(id),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (discount_type <> 'percent' OR discount_value <= 100),
  CHECK ((discount_type = 'fixed') = (currency_code IS NOT NULL)),
  CHECK ((cost_bearer = 'shared') = (provider_share_percent IS NOT NULL)),
  CHECK (provider_id IS NULL OR cost_bearer = 'provider')
);
CREATE TRIGGER promotions_updated BEFORE UPDATE ON promotions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Discount snapshot on the booking: amount and who bears it (clause 55: clearly recorded).
ALTER TABLE bookings ADD COLUMN promotion_id uuid REFERENCES promotions(id);
ALTER TABLE bookings ADD COLUMN discount_amount numeric(20,4) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0);
ALTER TABLE bookings ADD COLUMN discount_platform_borne numeric(20,4) NOT NULL DEFAULT 0 CHECK (discount_platform_borne >= 0);
ALTER TABLE bookings ADD COLUMN discount_provider_borne numeric(20,4) NOT NULL DEFAULT 0 CHECK (discount_provider_borne >= 0);
ALTER TABLE bookings ADD CONSTRAINT bookings_discount_split CHECK (discount_amount = discount_platform_borne + discount_provider_borne);
ALTER TABLE orders ADD COLUMN discount_total numeric(20,4) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN promotion_id uuid REFERENCES promotions(id);

CREATE OR REPLACE FUNCTION bookings_freeze_snapshot() RETURNS trigger AS $$
BEGIN
  IF (NEW.unit_price, NEW.quantity_factor, NEW.subtotal, NEW.total, NEW.currency_code, NEW.deposit_type, NEW.deposit_value,
      NEW.upfront_amount, NEW.add_ons, NEW.cancellation_policy, NEW.terms_snapshot, NEW.service_title, NEW.package_name,
      NEW.pricing_unit, NEW.requires_provider_approval, NEW.order_id, NEW.customer_id, NEW.provider_id, NEW.service_id,
      NEW.promotion_id, NEW.discount_amount, NEW.discount_platform_borne, NEW.discount_provider_borne)
     IS DISTINCT FROM
     (OLD.unit_price, OLD.quantity_factor, OLD.subtotal, OLD.total, OLD.currency_code, OLD.deposit_type, OLD.deposit_value,
      OLD.upfront_amount, OLD.add_ons, OLD.cancellation_policy, OLD.terms_snapshot, OLD.service_title, OLD.package_name,
      OLD.pricing_unit, OLD.requires_provider_approval, OLD.order_id, OLD.customer_id, OLD.provider_id, OLD.service_id,
      OLD.promotion_id, OLD.discount_amount, OLD.discount_platform_borne, OLD.discount_provider_borne) THEN
    RAISE EXCEPTION 'booking % snapshot fields are immutable', OLD.number USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TABLE promotion_redemptions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id     uuid NOT NULL REFERENCES promotions(id),
  order_id         uuid NOT NULL REFERENCES orders(id),
  booking_id       uuid NOT NULL UNIQUE REFERENCES bookings(id),
  customer_id      uuid NOT NULL REFERENCES users(id),
  discount_amount  numeric(20,4) NOT NULL,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'void')),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX promotion_redemptions_promo ON promotion_redemptions (promotion_id, customer_id) WHERE status = 'active';

-- Earnings: the platform-borne part of a discount is paid to the provider by the platform.
ALTER TABLE provider_earnings ADD COLUMN platform_discount numeric(20,4) NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- Reviews (clause 56): one per completed booking, by the customer who booked.
-- ---------------------------------------------------------------------------

CREATE TABLE reviews (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id         uuid NOT NULL UNIQUE REFERENCES bookings(id),
  service_id         uuid NOT NULL REFERENCES services(id),
  provider_id        uuid NOT NULL REFERENCES providers(id),
  customer_id        uuid NOT NULL REFERENCES users(id),
  rating             smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment            text CHECK (length(comment) <= 3000),
  status             text NOT NULL CHECK (status IN ('published', 'pending_moderation', 'hidden')),
  reported_count     integer NOT NULL DEFAULT 0,
  moderated_by       uuid REFERENCES users(id),
  moderation_reason  text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER reviews_updated BEFORE UPDATE ON reviews FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX reviews_service ON reviews (service_id, status, created_at DESC);
