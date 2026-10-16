-- Package images (clause 17) and provider business-profile changes after approval (clause 7).

-- An image may illustrate one package of the same service; NULL means the service as a whole.
ALTER TABLE service_media ADD COLUMN package_id uuid REFERENCES packages(id);
CREATE INDEX service_media_package ON service_media (package_id) WHERE package_id IS NOT NULL;

-- Identity and payout changes of an approved provider go through the administration.
-- Requests are never deleted; the decision and who made it stay on the row.
CREATE TABLE provider_profile_changes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id   uuid NOT NULL REFERENCES providers(id),
  changes       jsonb NOT NULL CHECK (jsonb_typeof(changes) = 'object' AND changes <> '{}'::jsonb),
  note          text,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  requested_by  uuid NOT NULL REFERENCES users(id),
  decided_by    uuid REFERENCES users(id),
  decision_reason text,
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'pending') = (decided_at IS NULL))
);
-- One open request per provider keeps the review unambiguous.
CREATE UNIQUE INDEX provider_profile_changes_open ON provider_profile_changes (provider_id) WHERE status = 'pending';
CREATE INDEX provider_profile_changes_status ON provider_profile_changes (status, created_at);
