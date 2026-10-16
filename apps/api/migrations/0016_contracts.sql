-- Booking contract (clause 65): an admin-edited template, versioned. Saving creates a new version; old versions are kept
-- and each booking records the version in force when it was made, so later edits never change an existing contract.
CREATE TABLE contract_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country_id  uuid REFERENCES countries(id),            -- NULL = all countries without their own template
  version     integer NOT NULL CHECK (version > 0),
  title       jsonb NOT NULL CHECK (is_i18n_text(title)),
  body        jsonb NOT NULL CHECK (is_i18n_text(body)),
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX contract_templates_version ON contract_templates (coalesce(country_id, '00000000-0000-0000-0000-000000000000'::uuid), version);

CREATE TABLE booking_contracts (
  booking_id   uuid PRIMARY KEY REFERENCES bookings(id),
  template_id  uuid NOT NULL REFERENCES contract_templates(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION contracts_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows cannot be changed or deleted', TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER contract_templates_append_only BEFORE UPDATE OR DELETE ON contract_templates FOR EACH ROW EXECUTE FUNCTION contracts_append_only();
CREATE TRIGGER booking_contracts_append_only BEFORE UPDATE OR DELETE ON booking_contracts FOR EACH ROW EXECUTE FUNCTION contracts_append_only();
