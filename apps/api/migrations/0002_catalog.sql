-- Phase 3: dynamic service engine — categories, service types and their fields,
-- services, packages, rentable items, media, cancellation policies.
-- See docs/03-database-design.md section B.

-- ---------------------------------------------------------------------------
-- Categories (clause 16)
-- ---------------------------------------------------------------------------

CREATE TABLE service_categories (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id    uuid REFERENCES service_categories(id),
  slug         text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,79}$'),
  name         jsonb NOT NULL CHECK (is_i18n_text(name)),
  description  jsonb CHECK (description IS NULL OR is_i18n_text(description)),
  icon         text,
  image_key    text,
  sort_order   integer NOT NULL DEFAULT 0,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE TRIGGER service_categories_updated BEFORE UPDATE ON service_categories FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- No rows for a category = available in no country. Explicit on purpose: a new category is not
-- silently published everywhere.
CREATE TABLE service_category_countries (
  category_id  uuid NOT NULL REFERENCES service_categories(id) ON DELETE CASCADE,
  country_id   uuid NOT NULL REFERENCES countries(id),
  PRIMARY KEY (category_id, country_id)
);

-- ---------------------------------------------------------------------------
-- Service types (clause 17) — defined at runtime by admins, no code change needed
-- ---------------------------------------------------------------------------

CREATE TABLE service_types (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id                uuid NOT NULL REFERENCES service_categories(id),
  code                       text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]{2,49}$'),
  name                       jsonb NOT NULL CHECK (is_i18n_text(name)),
  description                jsonb CHECK (description IS NULL OR is_i18n_text(description)),
  icon                       text,
  -- How time/quantity is reserved (consumed by the calendar, phase 4).
  booking_mode               text NOT NULL CHECK (booking_mode IN ('time_slot', 'full_day', 'date_range', 'quantity_rental')),
  capacity_mode              text NOT NULL DEFAULT 'none' CHECK (capacity_mode IN ('none', 'guests', 'units')),
  default_requires_approval  boolean NOT NULL DEFAULT true,
  default_duration_minutes   integer CHECK (default_duration_minutes > 0),
  buffer_before_minutes      integer NOT NULL DEFAULT 0 CHECK (buffer_before_minutes >= 0),
  buffer_after_minutes       integer NOT NULL DEFAULT 0 CHECK (buffer_after_minutes >= 0),
  pricing_units              text[] NOT NULL CHECK (cardinality(pricing_units) > 0 AND pricing_units <@ ARRAY['fixed','per_hour','per_day','per_person','per_unit']),
  allows_packages            boolean NOT NULL DEFAULT true,
  min_images                 integer NOT NULL DEFAULT 0 CHECK (min_images BETWEEN 0 AND 50),
  max_images                 integer NOT NULL DEFAULT 30 CHECK (max_images BETWEEN 1 AND 100),
  allows_video               boolean NOT NULL DEFAULT true,
  required_documents         text[] NOT NULL DEFAULT '{}',
  -- Deposit constraints services of this type must respect (enforced on packages).
  deposit_required           boolean NOT NULL DEFAULT false,
  min_deposit_percent        numeric(5,2) CHECK (min_deposit_percent BETWEEN 0 AND 100),
  provider_can_create        boolean NOT NULL DEFAULT true,
  is_active                  boolean NOT NULL DEFAULT true,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CHECK (min_images <= max_images)
);
CREATE TRIGGER service_types_updated BEFORE UPDATE ON service_types FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE service_type_fields (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_type_id  uuid NOT NULL REFERENCES service_types(id),
  key              text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,49}$'),
  label            jsonb NOT NULL CHECK (is_i18n_text(label)),
  help_text        jsonb CHECK (help_text IS NULL OR is_i18n_text(help_text)),
  data_type        text NOT NULL CHECK (data_type IN
                     ('text', 'textarea', 'i18n_text', 'number', 'integer', 'boolean', 'select', 'multiselect', 'date', 'url')),
  is_required      boolean NOT NULL DEFAULT false,
  -- {min, max, minLength, maxLength, pattern, maxItems}
  validation       jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- [{value, label: {ar, en}}] for select / multiselect
  options          jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_searchable    boolean NOT NULL DEFAULT false,
  is_reportable    boolean NOT NULL DEFAULT false,
  is_public        boolean NOT NULL DEFAULT true,
  sort_order       integer NOT NULL DEFAULT 0,
  -- Removing a field deactivates it so values on existing services stay interpretable.
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_type_id, key),
  CHECK (data_type NOT IN ('select', 'multiselect') OR jsonb_array_length(options) > 0)
);
CREATE TRIGGER service_type_fields_updated BEFORE UPDATE ON service_type_fields FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Which service types a provider is allowed to offer (granted by staff).
CREATE TABLE provider_service_types (
  provider_id      uuid NOT NULL REFERENCES providers(id),
  service_type_id  uuid NOT NULL REFERENCES service_types(id),
  granted_by       uuid REFERENCES users(id),
  granted_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, service_type_id)
);

-- ---------------------------------------------------------------------------
-- Cancellation policies (clause 49). Structure is stored now; refunds apply it in phase 7.
-- ---------------------------------------------------------------------------

CREATE TABLE cancellation_policies (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id             uuid REFERENCES providers(id),  -- NULL = platform policy usable by everyone
  name                    jsonb NOT NULL CHECK (is_i18n_text(name)),
  description             jsonb NOT NULL CHECK (is_i18n_text(description)),
  -- [{hoursBefore, refundPercentOfPaid}] sorted by hoursBefore desc; deposit handled by deposit_refundable.
  tiers                   jsonb NOT NULL DEFAULT '[]'::jsonb,
  deposit_refundable      boolean NOT NULL DEFAULT false,
  self_cancel_allowed     boolean NOT NULL DEFAULT true,
  requires_manual_review  boolean NOT NULL DEFAULT false,
  is_active               boolean NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER cancellation_policies_updated BEFORE UPDATE ON cancellation_policies FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Services (clause 19)
-- ---------------------------------------------------------------------------

CREATE TABLE services (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id                 uuid NOT NULL REFERENCES providers(id),
  service_type_id             uuid NOT NULL REFERENCES service_types(id),
  country_id                  uuid NOT NULL REFERENCES countries(id),
  city                        text NOT NULL,
  address                     text,
  latitude                    numeric(9,6) CHECK (latitude BETWEEN -90 AND 90),
  longitude                   numeric(9,6) CHECK (longitude BETWEEN -180 AND 180),
  title                       jsonb NOT NULL CHECK (is_i18n_text(title)),
  description                 jsonb NOT NULL CHECK (is_i18n_text(description)),
  terms                       jsonb CHECK (terms IS NULL OR is_i18n_text(terms)),
  base_price                  numeric(20,4) NOT NULL CHECK (base_price >= 0),
  currency_code               char(3) NOT NULL REFERENCES currencies(code),
  pricing_unit                text NOT NULL CHECK (pricing_unit IN ('fixed','per_hour','per_day','per_person','per_unit')),
  duration_minutes            integer CHECK (duration_minutes > 0),
  capacity                    integer CHECK (capacity > 0),
  -- D5: approval requirement is set per service (default copied from the type).
  requires_provider_approval  boolean NOT NULL,
  cancellation_policy_id      uuid REFERENCES cancellation_policies(id),
  -- Deposit for booking the service itself (packages carry their own). Snapshot into bookings in phase 5.
  deposit_type                text NOT NULL DEFAULT 'none' CHECK (deposit_type IN ('none', 'fixed', 'percent')),
  deposit_value               numeric(20,4) NOT NULL DEFAULT 0 CHECK (deposit_value >= 0),
  balance_due_days_before     integer NOT NULL DEFAULT 0 CHECK (balance_due_days_before BETWEEN 0 AND 365),
  attributes                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  status                      text NOT NULL DEFAULT 'draft' CHECK (status IN
                                ('draft', 'pending_review', 'published', 'unpublished', 'suspended')),
  status_reason               text,
  published_at                timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CHECK ((latitude IS NULL) = (longitude IS NULL)),
  CHECK (deposit_type <> 'percent' OR deposit_value <= 100),
  CHECK (deposit_type <> 'fixed' OR deposit_value <= base_price),
  CHECK (deposit_type <> 'none' OR deposit_value = 0)
);
CREATE TRIGGER services_updated BEFORE UPDATE ON services FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX services_search ON services (country_id, status, service_type_id);
CREATE INDEX services_provider ON services (provider_id, status);
CREATE INDEX services_attributes ON services USING gin (attributes jsonb_path_ops);

CREATE TABLE service_status_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id   uuid NOT NULL REFERENCES services(id),
  from_status  text,
  to_status    text NOT NULL,
  actor_id     uuid REFERENCES users(id),
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER service_status_events_append_only BEFORE UPDATE OR DELETE ON service_status_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE service_media (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id    uuid NOT NULL REFERENCES services(id),
  kind          text NOT NULL CHECK (kind IN ('image', 'video')),
  file_key      text NOT NULL UNIQUE,
  mime_type     text NOT NULL,
  size_bytes    bigint NOT NULL CHECK (size_bytes > 0),
  sha256        text NOT NULL,
  caption       jsonb CHECK (caption IS NULL OR is_i18n_text(caption)),
  is_past_work  boolean NOT NULL DEFAULT false,
  sort_order    integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX service_media_service ON service_media (service_id, sort_order);

-- ---------------------------------------------------------------------------
-- Packages (clause 20). Bookings snapshot the price in phase 5, so edits never touch past bookings.
-- ---------------------------------------------------------------------------

CREATE TABLE packages (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id               uuid NOT NULL REFERENCES services(id),
  name                     jsonb NOT NULL CHECK (is_i18n_text(name)),
  description              jsonb CHECK (description IS NULL OR is_i18n_text(description)),
  price                    numeric(20,4) NOT NULL CHECK (price >= 0),
  currency_code            char(3) NOT NULL REFERENCES currencies(code),
  pricing_unit             text NOT NULL CHECK (pricing_unit IN ('fixed','per_hour','per_day','per_person','per_unit')),
  duration_minutes         integer CHECK (duration_minutes > 0),
  inclusions               jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{ar, en}]
  add_ons                  jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{code, name, price}]
  terms                    jsonb CHECK (terms IS NULL OR is_i18n_text(terms)),
  available_weekdays       smallint[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}'
                             CHECK (available_weekdays <@ '{0,1,2,3,4,5,6}'::smallint[] AND cardinality(available_weekdays) > 0),
  max_bookings_per_slot    integer NOT NULL DEFAULT 1 CHECK (max_bookings_per_slot > 0),
  deposit_type             text NOT NULL DEFAULT 'none' CHECK (deposit_type IN ('none', 'fixed', 'percent')),
  deposit_value            numeric(20,4) NOT NULL DEFAULT 0 CHECK (deposit_value >= 0),
  -- Remaining balance due this many days before the event (0 = on the event day).
  balance_due_days_before  integer NOT NULL DEFAULT 0 CHECK (balance_due_days_before BETWEEN 0 AND 365),
  valid_from               date,
  valid_to                 date,
  sort_order               integer NOT NULL DEFAULT 0,
  status                   text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (deposit_type <> 'percent' OR deposit_value <= 100),
  CHECK (deposit_type <> 'fixed' OR deposit_value <= price),
  CHECK (deposit_type <> 'none' OR deposit_value = 0),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);
CREATE TRIGGER packages_updated BEFORE UPDATE ON packages FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX packages_service ON packages (service_id, status);

-- ---------------------------------------------------------------------------
-- Rentable items: dresses, suits, furniture, equipment (clause 23)
-- ---------------------------------------------------------------------------

CREATE TABLE rental_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id         uuid NOT NULL REFERENCES services(id),
  sku                text NOT NULL,
  name               jsonb NOT NULL CHECK (is_i18n_text(name)),
  attributes         jsonb NOT NULL DEFAULT '{}'::jsonb,  -- size, colour, ...
  quantity_total     integer NOT NULL CHECK (quantity_total >= 0),
  condition          text NOT NULL DEFAULT 'good' CHECK (condition IN ('new', 'excellent', 'good', 'fair')),
  price_per_day      numeric(20,4) NOT NULL CHECK (price_per_day >= 0),
  price_per_period   numeric(20,4) CHECK (price_per_period >= 0),
  period_days        integer CHECK (period_days > 0),
  currency_code      char(3) NOT NULL REFERENCES currencies(code),
  security_deposit   numeric(20,4) NOT NULL DEFAULT 0 CHECK (security_deposit >= 0),
  late_fee_per_day   numeric(20,4) NOT NULL DEFAULT 0 CHECK (late_fee_per_day >= 0),
  damage_terms       jsonb CHECK (damage_terms IS NULL OR is_i18n_text(damage_terms)),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_id, sku),
  CHECK ((price_per_period IS NULL) = (period_days IS NULL))
);
CREATE TRIGGER rental_items_updated BEFORE UPDATE ON rental_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();
