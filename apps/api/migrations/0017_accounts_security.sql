-- Account deletion (anonymisation), staff two-step sign-in, multi-country promotions, worker heartbeat.

-- A deleted account keeps its row so bookings, payments and the ledger stay intact; personal data is replaced.
ALTER TABLE users DROP CONSTRAINT users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (status IN ('active', 'disabled', 'deleted'));
ALTER TABLE users ADD COLUMN deleted_at timestamptz;

-- Time-based one-time codes (RFC 6238). The secret is stored encrypted; last_step blocks reusing a code.
CREATE TABLE user_mfa (
  user_id     uuid PRIMARY KEY REFERENCES users(id),
  secret_enc  text NOT NULL,
  enabled_at  timestamptz,
  last_step   bigint NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Second step of a sign-in: issued after a correct password, consumed by a correct code.
CREATE TABLE mfa_challenges (
  token_hash   text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id),
  purpose      text NOT NULL CHECK (purpose IN ('verify', 'setup')),
  expires_at   timestamptz NOT NULL,
  attempts     integer NOT NULL DEFAULT 0,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- A promotion for several countries (NULL keeps the single country_id behaviour).
ALTER TABLE promotions ADD COLUMN country_ids uuid[];

-- Background worker liveness, shown on the admin system status page.
CREATE TABLE system_heartbeats (
  name     text PRIMARY KEY,
  beat_at  timestamptz NOT NULL DEFAULT now(),
  info     jsonb NOT NULL DEFAULT '{}'::jsonb
);
