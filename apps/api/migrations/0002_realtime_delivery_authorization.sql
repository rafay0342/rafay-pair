ALTER TABLE pairs
  ADD COLUMN authorization_revision bigint NOT NULL DEFAULT 0;

ALTER TABLE realtime_events
  ADD COLUMN authorization_revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN delivery_authorized_at timestamptz,
  ADD COLUMN delivery_authorized_revision bigint;

ALTER TABLE outbox_events
  ADD COLUMN authorization_revision bigint NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION bump_pair_authorization_revision_from_child()
RETURNS trigger AS $$
BEGIN
  UPDATE pairs
  SET authorization_revision = authorization_revision + 1
  WHERE id = NEW.pair_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER consent_grant_authorization_revision
  AFTER UPDATE OF granted ON consent_grants
  FOR EACH ROW
  WHEN (OLD.granted IS DISTINCT FROM NEW.granted)
  EXECUTE FUNCTION bump_pair_authorization_revision_from_child();

CREATE TRIGGER privacy_state_authorization_revision
  AFTER UPDATE OF paused ON privacy_states
  FOR EACH ROW
  WHEN (OLD.paused IS DISTINCT FROM NEW.paused)
  EXECUTE FUNCTION bump_pair_authorization_revision_from_child();

CREATE OR REPLACE FUNCTION bump_pair_authorization_revision_on_status()
RETURNS trigger AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    NEW.authorization_revision = OLD.authorization_revision + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pair_status_authorization_revision
  BEFORE UPDATE OF status ON pairs
  FOR EACH ROW
  EXECUTE FUNCTION bump_pair_authorization_revision_on_status();

CREATE INDEX realtime_events_authorized_replay_idx
  ON realtime_events (pair_id, id)
  WHERE delivery_authorized_at IS NOT NULL
    AND delivery_authorized_revision IS NOT NULL
    AND suppressed_at IS NULL;
