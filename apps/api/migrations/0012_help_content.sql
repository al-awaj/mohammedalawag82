-- Help centre / FAQ managed by the administration (clause 60). Articles are unpublished, never deleted.
CREATE TABLE help_articles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country_id    uuid REFERENCES countries(id),            -- NULL: every country
  audience      text NOT NULL CHECK (audience IN ('customer', 'provider', 'all')),
  topic         text NOT NULL CHECK (topic ~ '^[a-z][a-z0-9_]{0,39}$'),
  question      jsonb NOT NULL CHECK (is_i18n_text(question)),
  answer        jsonb NOT NULL CHECK (is_i18n_text(answer)),
  sort_order    integer NOT NULL DEFAULT 0,
  is_published  boolean NOT NULL DEFAULT false,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER help_articles_updated BEFORE UPDATE ON help_articles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX help_articles_public ON help_articles (audience, sort_order) WHERE is_published;
