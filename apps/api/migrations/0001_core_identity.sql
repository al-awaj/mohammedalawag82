-- Phase 2: reference data, identity, RBAC, provider onboarding, settings, audit.
-- See docs/03-database-design.md section A.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Rejects UPDATE/DELETE on append-only tables (audit log, rates, history).
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only (% not allowed)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'P0001';
END $$ LANGUAGE plpgsql;

-- A translated text column must be an object holding at least an "ar" or "en" string.
CREATE OR REPLACE FUNCTION is_i18n_text(v jsonb) RETURNS boolean AS $$
  SELECT jsonb_typeof(v) = 'object'
     AND (jsonb_typeof(v->'ar') = 'string' OR jsonb_typeof(v->'en') = 'string')
     AND NOT EXISTS (SELECT 1 FROM jsonb_each(v) e WHERE jsonb_typeof(e.value) <> 'string');
$$ LANGUAGE sql IMMUTABLE;

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------

CREATE TABLE languages (
  code        text PRIMARY KEY CHECK (code ~ '^[a-z]{2}$'),
  name        jsonb NOT NULL CHECK (is_i18n_text(name)),
  direction   text NOT NULL CHECK (direction IN ('rtl', 'ltr')),
  is_active   boolean NOT NULL DEFAULT true
);

CREATE TABLE currencies (
  code         char(3) PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),
  name         jsonb NOT NULL CHECK (is_i18n_text(name)),
  symbol       text NOT NULL,
  minor_units  smallint NOT NULL DEFAULT 2 CHECK (minor_units BETWEEN 0 AND 4),
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER currencies_updated BEFORE UPDATE ON currencies FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE countries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code              char(2) NOT NULL UNIQUE CHECK (code ~ '^[A-Z]{2}$'),
  name              jsonb NOT NULL CHECK (is_i18n_text(name)),
  base_currency     char(3) NOT NULL REFERENCES currencies(code),
  timezone          text NOT NULL,
  default_language  text NOT NULL REFERENCES languages(code),
  date_format       text NOT NULL DEFAULT 'dd/MM/yyyy',
  time_format       text NOT NULL DEFAULT 'HH:mm',
  phone_prefix      text NOT NULL CHECK (phone_prefix ~ '^\+[0-9]{1,4}$'),
  tax_settings      jsonb NOT NULL DEFAULT '{}'::jsonb,
  invoice_settings  jsonb NOT NULL DEFAULT '{}'::jsonb,
  messaging_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active         boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER countries_updated BEFORE UPDATE ON countries FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE country_currencies (
  country_id     uuid NOT NULL REFERENCES countries(id),
  currency_code  char(3) NOT NULL REFERENCES currencies(code),
  is_active      boolean NOT NULL DEFAULT true,
  PRIMARY KEY (country_id, currency_code)
);

-- Append-only: a new rate is a new row; historical transactions keep the rate they used.
CREATE TABLE exchange_rates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  base_currency   char(3) NOT NULL REFERENCES currencies(code),
  quote_currency  char(3) NOT NULL REFERENCES currencies(code),
  rate            numeric(24,10) NOT NULL CHECK (rate > 0),
  effective_at    timestamptz NOT NULL,
  source          text NOT NULL CHECK (length(source) > 0),
  entered_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (base_currency <> quote_currency)
);
CREATE INDEX exchange_rates_lookup ON exchange_rates (base_currency, quote_currency, effective_at DESC);
CREATE TRIGGER exchange_rates_append_only BEFORE UPDATE OR DELETE ON exchange_rates
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- Users & authentication
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                text NOT NULL CHECK (kind IN ('customer', 'provider', 'staff')),
  full_name           text NOT NULL CHECK (length(full_name) BETWEEN 2 AND 200),
  phone               text UNIQUE CHECK (phone ~ '^\+[1-9][0-9]{6,14}$'),
  email               citext UNIQUE,
  country_id          uuid REFERENCES countries(id),
  preferred_language  text NOT NULL REFERENCES languages(code),
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  phone_verified_at   timestamptz,
  email_verified_at   timestamptz,
  failed_login_count  integer NOT NULL DEFAULT 0,
  locked_until        timestamptz,
  last_login_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (phone IS NOT NULL OR email IS NOT NULL)
);
CREATE TRIGGER users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX users_kind_idx ON users (kind, status);

CREATE TABLE user_credentials (
  user_id              uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash        text NOT NULL,
  password_changed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE refresh_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id    uuid NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  replaced_by  uuid REFERENCES refresh_tokens(id),
  user_agent   text,
  ip           inet,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_family ON refresh_tokens (family_id);

CREATE TABLE verification_codes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose      text NOT NULL CHECK (purpose IN ('verify_phone', 'verify_email', 'reset_password')),
  channel      text NOT NULL CHECK (channel IN ('sms', 'email', 'whatsapp')),
  target       text NOT NULL,
  code_hash    text NOT NULL,
  attempts     integer NOT NULL DEFAULT 0,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_codes_active ON verification_codes (user_id, purpose) WHERE consumed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Terms (clause 66: keep the exact version a user accepted)
-- ---------------------------------------------------------------------------

CREATE TABLE terms_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('customer_terms', 'privacy_policy', 'provider_terms')),
  country_id    uuid REFERENCES countries(id),
  version       text NOT NULL,
  content       jsonb NOT NULL CHECK (is_i18n_text(content)),
  published_at  timestamptz NOT NULL DEFAULT now(),
  published_by  uuid REFERENCES users(id),
  UNIQUE NULLS NOT DISTINCT (kind, country_id, version)
);
CREATE TRIGGER terms_versions_immutable BEFORE UPDATE OR DELETE ON terms_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE terms_acceptances (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id),
  terms_version_id  uuid NOT NULL REFERENCES terms_versions(id),
  context           text NOT NULL,
  ip                inet,
  accepted_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER terms_acceptances_append_only BEFORE UPDATE OR DELETE ON terms_acceptances
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- RBAC
-- ---------------------------------------------------------------------------

CREATE TABLE permissions (
  code         text PRIMARY KEY,
  module       text NOT NULL,
  description  jsonb NOT NULL CHECK (is_i18n_text(description))
);

CREATE TABLE roles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]{2,49}$'),
  name         jsonb NOT NULL CHECK (is_i18n_text(name)),
  description  jsonb,
  is_system    boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER roles_updated BEFORE UPDATE ON roles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE role_permissions (
  role_id          uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code  text NOT NULL REFERENCES permissions(code),
  PRIMARY KEY (role_id, permission_code)
);

-- country_id NULL = global scope; otherwise the grant applies to that country only.
CREATE TABLE user_roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id     uuid NOT NULL REFERENCES roles(id),
  country_id  uuid REFERENCES countries(id),
  granted_by  uuid REFERENCES users(id),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (user_id, role_id, country_id)
);

CREATE TABLE staff_profiles (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  job_title   text,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE customer_profiles (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Provider onboarding (clauses 14-15)
-- ---------------------------------------------------------------------------

CREATE TABLE provider_applications (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id),
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN
                      ('draft', 'submitted', 'under_review', 'needs_info',
                       'approved', 'rejected', 'suspended', 'cancelled')),
  business_name     text NOT NULL CHECK (length(business_name) BETWEEN 2 AND 200),
  activity_type     text NOT NULL,
  country_id        uuid NOT NULL REFERENCES countries(id),
  city              text NOT NULL,
  phone             text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{6,14}$'),
  email             citext,
  address           text,
  latitude          numeric(9,6) CHECK (latitude BETWEEN -90 AND 90),
  longitude         numeric(9,6) CHECK (longitude BETWEEN -180 AND 180),
  description       text,
  payout_details    jsonb,
  terms_version_id  uuid REFERENCES terms_versions(id),
  submitted_at      timestamptz,
  decided_at        timestamptz,
  decided_by        uuid REFERENCES users(id),
  decision_reason   text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('rejected', 'suspended', 'needs_info') OR length(coalesce(decision_reason, '')) > 0)
);
CREATE TRIGGER provider_applications_updated BEFORE UPDATE ON provider_applications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX provider_applications_status ON provider_applications (country_id, status);
-- One open application per user at a time.
CREATE UNIQUE INDEX provider_applications_one_open ON provider_applications (user_id)
  WHERE status IN ('draft', 'submitted', 'under_review', 'needs_info', 'approved', 'suspended');

CREATE TABLE provider_application_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  uuid NOT NULL REFERENCES provider_applications(id),
  from_status     text,
  to_status       text NOT NULL,
  actor_id        uuid REFERENCES users(id),
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER provider_application_events_append_only BEFORE UPDATE OR DELETE ON provider_application_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE provider_application_documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  uuid NOT NULL REFERENCES provider_applications(id),
  doc_type        text NOT NULL,
  file_key        text NOT NULL UNIQUE,
  original_name   text NOT NULL,
  mime_type       text NOT NULL,
  size_bytes      integer NOT NULL CHECK (size_bytes > 0),
  sha256          text NOT NULL,
  uploaded_by     uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE providers (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                      uuid NOT NULL UNIQUE REFERENCES users(id),
  application_id               uuid NOT NULL REFERENCES provider_applications(id),
  business_name                text NOT NULL,
  activity_type                text NOT NULL,
  country_id                   uuid NOT NULL REFERENCES countries(id),
  city                         text NOT NULL,
  address                      text,
  latitude                     numeric(9,6),
  longitude                    numeric(9,6),
  description                  text,
  payout_details               jsonb,
  status                       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  status_reason                text,
  show_identity                boolean NOT NULL DEFAULT true,
  interim_settlement_eligible  boolean NOT NULL DEFAULT false,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER providers_updated BEFORE UPDATE ON providers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX providers_country ON providers (country_id, status);

-- ---------------------------------------------------------------------------
-- Settings with history (clause 67)
-- ---------------------------------------------------------------------------

CREATE TABLE settings (
  key         text NOT NULL,
  scope_type  text NOT NULL CHECK (scope_type IN ('global', 'country')),
  scope_id    uuid REFERENCES countries(id),
  value       jsonb NOT NULL,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope_type = 'global') = (scope_id IS NULL)),
  UNIQUE NULLS NOT DISTINCT (key, scope_type, scope_id)
);

CREATE TABLE setting_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL,
  scope_type  text NOT NULL,
  scope_id    uuid,
  old_value   jsonb,
  new_value   jsonb NOT NULL,
  reason      text,
  changed_by  uuid REFERENCES users(id),
  changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER setting_history_append_only BEFORE UPDATE OR DELETE ON setting_history
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- Audit log (clause 70) — append-only, enforced in the database
-- ---------------------------------------------------------------------------

CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  actor_id     uuid,
  actor_kind   text NOT NULL CHECK (actor_kind IN ('customer', 'provider', 'staff', 'system', 'anonymous')),
  action       text NOT NULL,
  entity_type  text NOT NULL,
  entity_id    text,
  before       jsonb,
  after        jsonb,
  reason       text,
  ip           inet,
  request_id   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_entity ON audit_log (entity_type, entity_id, created_at DESC);
CREATE INDEX audit_log_actor ON audit_log (actor_id, created_at DESC);
CREATE INDEX audit_log_action ON audit_log (action, created_at DESC);
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- Outbound messages (delivery drivers arrive in phase 8)
-- ---------------------------------------------------------------------------

CREATE TABLE message_outbox (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel            text NOT NULL CHECK (channel IN ('sms', 'email', 'whatsapp', 'push', 'web')),
  recipient_user_id  uuid REFERENCES users(id),
  target             text NOT NULL,
  template_key       text NOT NULL,
  language           text NOT NULL REFERENCES languages(code),
  payload            jsonb NOT NULL DEFAULT '{}'::jsonb,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts           integer NOT NULL DEFAULT 0,
  last_error         text,
  provider_ref       text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  sent_at            timestamptz
);
CREATE INDEX message_outbox_pending ON message_outbox (created_at) WHERE status = 'pending';
