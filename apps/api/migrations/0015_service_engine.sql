-- Service engine completion (clauses 16-19).
-- Two more field types: a time of day ("18:30") and a map location ({"lat": .., "lng": ..}).
ALTER TABLE service_type_fields DROP CONSTRAINT service_type_fields_data_type_check;
ALTER TABLE service_type_fields ADD CONSTRAINT service_type_fields_data_type_check CHECK (data_type IN
  ('text', 'textarea', 'i18n_text', 'number', 'integer', 'boolean', 'select', 'multiselect', 'date', 'url', 'time', 'location'));

-- A type may name a platform cancellation policy used when a provider does not choose one.
ALTER TABLE service_types ADD COLUMN default_cancellation_policy_id uuid REFERENCES cancellation_policies(id);

-- Documents a type requires for each service (licence, permit...), uploaded by the provider and checked by staff
-- before publishing. Private: never served publicly. Replaced documents are kept for the record.
CREATE TABLE service_documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id   uuid NOT NULL REFERENCES services(id),
  doc_type     text NOT NULL CHECK (doc_type ~ '^[a-z_]{2,50}$'),
  file_key     text NOT NULL,
  mime_type    text NOT NULL,
  size_bytes   integer NOT NULL,
  uploaded_by  uuid NOT NULL REFERENCES users(id),
  replaced_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX service_documents_service ON service_documents (service_id) WHERE replaced_at IS NULL;
