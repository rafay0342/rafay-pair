CREATE TABLE app_attest_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_id_hash bytea NOT NULL UNIQUE,
  environment text NOT NULL CHECK (environment IN ('development', 'production')),
  public_key_spki bytea NOT NULL,
  receipt bytea NOT NULL,
  sign_count bigint NOT NULL DEFAULT 0,
  validation_category integer,
  bundle_version text,
  attested_at timestamptz NOT NULL DEFAULT now(),
  last_asserted_at timestamptz,
  revoked_at timestamptz,
  CHECK (octet_length(key_id_hash) = 32),
  CHECK (octet_length(public_key_spki) BETWEEN 80 AND 512),
  CHECK (octet_length(receipt) BETWEEN 64 AND 49152),
  CHECK (sign_count BETWEEN 0 AND 4294967295),
  CHECK (validation_category IS NULL OR validation_category BETWEEN 1 AND 6),
  CHECK (
    bundle_version IS NULL OR (
      char_length(bundle_version) BETWEEN 1 AND 64 AND
      bundle_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
    )
  ),
  CHECK (last_asserted_at IS NULL OR last_asserted_at >= attested_at),
  CHECK (revoked_at IS NULL OR revoked_at >= attested_at)
);

CREATE INDEX app_attest_keys_user_active_idx
  ON app_attest_keys(user_id, environment, attested_at DESC)
  WHERE revoked_at IS NULL;

CREATE TABLE app_attest_challenge_bindings (
  challenge_id uuid PRIMARY KEY REFERENCES device_integrity_challenges(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('attestation', 'assertion', 'unsupported')),
  server_challenge bytea NOT NULL,
  key_id_hash bytea,
  environment text NOT NULL CHECK (environment IN ('development', 'production')),
  CHECK (octet_length(server_challenge) = 32),
  CHECK (key_id_hash IS NULL OR octet_length(key_id_hash) = 32),
  CHECK (
    (mode = 'unsupported' AND key_id_hash IS NULL) OR
    (mode IN ('attestation', 'assertion') AND key_id_hash IS NOT NULL)
  )
);

CREATE INDEX app_attest_challenge_bindings_key_idx
  ON app_attest_challenge_bindings(key_id_hash)
  WHERE key_id_hash IS NOT NULL;
