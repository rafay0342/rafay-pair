ALTER TABLE notification_devices
  DROP CONSTRAINT IF EXISTS notification_devices_token_hash_key;

ALTER TABLE notification_devices
  ADD COLUMN installation_id uuid,
  ADD COLUMN session_family_id uuid,
  ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN expires_at timestamptz NOT NULL DEFAULT (now() + interval '90 days');

-- Pre-lifecycle registrations cannot be tied to an authenticated installation
-- with confidence. Retain them for delivery audit history but fail closed.
UPDATE notification_devices
SET installation_id = gen_random_uuid(),
    session_family_id = gen_random_uuid(),
    disabled_at = COALESCE(disabled_at, now()),
    expires_at = now()
WHERE installation_id IS NULL OR session_family_id IS NULL;

ALTER TABLE notification_devices
  ALTER COLUMN installation_id SET NOT NULL,
  ALTER COLUMN session_family_id SET NOT NULL;

CREATE UNIQUE INDEX notification_devices_active_token_idx
  ON notification_devices (token_hash)
  WHERE disabled_at IS NULL;

CREATE UNIQUE INDEX notification_devices_active_installation_idx
  ON notification_devices (installation_id)
  WHERE disabled_at IS NULL;

CREATE INDEX notification_devices_family_active_idx
  ON notification_devices (session_family_id, expires_at)
  WHERE disabled_at IS NULL;

