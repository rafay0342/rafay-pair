CREATE TABLE device_integrity_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_family_id uuid NOT NULL,
  platform text NOT NULL CHECK (platform IN ('ios', 'android')),
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE INDEX device_integrity_challenges_family_recent_idx
  ON device_integrity_challenges(session_family_id, created_at DESC);
CREATE INDEX device_integrity_challenges_expiry_idx
  ON device_integrity_challenges(expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE device_integrity_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id uuid NOT NULL UNIQUE REFERENCES device_integrity_challenges(id),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_family_id uuid NOT NULL,
  platform text NOT NULL CHECK (platform IN ('ios', 'android')),
  provider text NOT NULL CHECK (provider IN ('play_integrity', 'app_attest')),
  signal text NOT NULL CHECK (signal IN ('low_risk', 'elevated_risk', 'invalid_binding')),
  binding_valid boolean NOT NULL,
  provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(provider_metadata) = 'object')
);

CREATE INDEX device_integrity_assessments_user_recent_idx
  ON device_integrity_assessments(user_id, evaluated_at DESC);

CREATE TRIGGER device_integrity_assessments_immutable
  BEFORE UPDATE OR DELETE ON device_integrity_assessments
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
