CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  parent_session_id uuid REFERENCES auth_sessions(id),
  replaced_by_session_id uuid REFERENCES auth_sessions(id),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_platform text NOT NULL CHECK (client_platform IN ('web', 'ios', 'android')),
  access_token_hash char(64) NOT NULL UNIQUE,
  refresh_token_hash char(64) NOT NULL UNIQUE,
  csrf_token_hash char(64),
  access_expires_at timestamptz NOT NULL,
  refresh_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoke_reason text,
  CHECK ((client_platform = 'web' AND csrf_token_hash IS NOT NULL) OR client_platform <> 'web')
);
CREATE INDEX auth_sessions_user_active_idx ON auth_sessions (user_id, refresh_expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX auth_sessions_family_idx ON auth_sessions (family_id);

CREATE TABLE pairs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'active', 'disconnected')),
  join_code_hash char(64) UNIQUE,
  join_code_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  disconnected_at timestamptz,
  disconnected_by_user_id uuid REFERENCES users(id),
  CHECK (
    (status = 'waiting' AND join_code_hash IS NOT NULL AND join_code_expires_at IS NOT NULL)
    OR (status = 'active' AND disconnected_at IS NULL)
    OR (status = 'disconnected' AND disconnected_at IS NOT NULL)
  )
);

CREATE TABLE pair_members (
  pair_id uuid NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  PRIMARY KEY (pair_id, user_id)
);
CREATE UNIQUE INDEX pair_members_one_current_pair_per_user_idx ON pair_members (user_id)
  WHERE left_at IS NULL;
CREATE INDEX pair_members_active_pair_idx ON pair_members (pair_id) WHERE left_at IS NULL;

CREATE OR REPLACE FUNCTION enforce_pair_member_limit() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM pairs WHERE id = NEW.pair_id FOR UPDATE;
  IF (SELECT count(*) FROM pair_members WHERE pair_id = NEW.pair_id AND left_at IS NULL) >= 2 THEN
    RAISE EXCEPTION 'a pair may have at most two active members' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pair_member_limit_before_insert
  BEFORE INSERT ON pair_members
  FOR EACH ROW EXECUTE FUNCTION enforce_pair_member_limit();

CREATE TABLE privacy_states (
  pair_id uuid NOT NULL,
  user_id uuid NOT NULL,
  paused boolean NOT NULL DEFAULT false,
  paused_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pair_id, user_id),
  FOREIGN KEY (pair_id, user_id) REFERENCES pair_members(pair_id, user_id) ON DELETE CASCADE,
  CHECK ((paused AND paused_at IS NOT NULL) OR (NOT paused AND paused_at IS NULL))
);

CREATE TABLE consent_grants (
  pair_id uuid NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
  grantor_user_id uuid NOT NULL REFERENCES users(id),
  grantee_user_id uuid NOT NULL REFERENCES users(id),
  capability text NOT NULL CHECK (capability IN (
    'care_requests', 'presence', 'workout_progress', 'pulse_snapshots',
    'breathing_state', 'estimated_calories', 'ai_partner_context'
  )),
  granted boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pair_id, grantor_user_id, grantee_user_id, capability),
  CHECK (grantor_user_id <> grantee_user_id)
);

CREATE TABLE consent_audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pair_id uuid NOT NULL,
  grantor_user_id uuid NOT NULL,
  grantee_user_id uuid NOT NULL,
  capability text NOT NULL,
  previous_granted boolean,
  new_granted boolean NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consent_audit_pair_idx ON consent_audit_log (pair_id, occurred_at DESC);

CREATE TABLE privacy_audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pair_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  previous_paused boolean NOT NULL,
  new_paused boolean NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit rows are append-only' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER consent_audit_immutable
  BEFORE UPDATE OR DELETE ON consent_audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
CREATE TRIGGER privacy_audit_immutable
  BEFORE UPDATE OR DELETE ON privacy_audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

CREATE TABLE care_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_request_id uuid NOT NULL,
  pair_id uuid NOT NULL REFERENCES pairs(id),
  sender_user_id uuid NOT NULL REFERENCES users(id),
  recipient_user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN (
    'check_in', 'encouragement', 'breathe_together', 'move_together', 'help', 'call_me'
  )),
  message text CHECK (message IS NULL OR char_length(message) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  responded_at timestamptz,
  UNIQUE (sender_user_id, client_request_id),
  CHECK (sender_user_id <> recipient_user_id),
  CHECK ((status IN ('accepted', 'declined') AND responded_at IS NOT NULL) OR status IN ('pending', 'expired'))
);
CREATE INDEX care_requests_pair_created_idx ON care_requests (pair_id, created_at DESC, id DESC);
CREATE INDEX care_requests_recipient_pending_idx ON care_requests (recipient_user_id, created_at DESC)
  WHERE status = 'pending';

CREATE TABLE realtime_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_uuid uuid NOT NULL UNIQUE,
  pair_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'care.request.created', 'care.request.responded', 'privacy.paused',
    'privacy.resumed', 'pair.disconnected'
  )),
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  suppressed_at timestamptz,
  suppression_reason text
);
CREATE INDEX realtime_events_pair_replay_idx ON realtime_events (pair_id, id);

CREATE TABLE outbox_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_uuid uuid NOT NULL UNIQUE,
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  pair_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  recipient_user_id uuid,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  locked_at timestamptz,
  locked_by text,
  processed_at timestamptz,
  dead_lettered_at timestamptz,
  last_error text,
  CHECK (attempts >= 0)
);
CREATE INDEX outbox_pending_idx ON outbox_events (available_at, id)
  WHERE processed_at IS NULL AND dead_lettered_at IS NULL;

CREATE TABLE notification_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('ios', 'android')),
  token_hash char(64) NOT NULL UNIQUE,
  token_ciphertext text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);
CREATE INDEX notification_devices_user_idx ON notification_devices (user_id) WHERE disabled_at IS NULL;

CREATE TABLE notification_deliveries (
  event_uuid uuid NOT NULL,
  device_id uuid NOT NULL REFERENCES notification_devices(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('pending', 'succeeded', 'permanent_failure')),
  attempts integer NOT NULL DEFAULT 0,
  provider_message_id text,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_uuid, device_id)
);

CREATE TABLE security_audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id uuid REFERENCES users(id),
  action text NOT NULL,
  target_type text,
  target_id text,
  request_id text,
  ip_hash char(64),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX security_audit_actor_idx ON security_audit_log (actor_user_id, occurred_at DESC);
CREATE TRIGGER security_audit_immutable
  BEFORE UPDATE OR DELETE ON security_audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
