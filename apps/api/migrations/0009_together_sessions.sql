-- Together mode: a shared workout both partners are present for.
--
-- Master specification §10 is explicit that each phone detects its own user and
-- sends only *derived* session events. There is therefore no column here for a
-- frame, a landmark, or an audio sample, and none can be added without changing
-- this schema deliberately.
--
-- A session belongs to a pair, not to a user, and both members read the same
-- row. It is invited by one member and must be accepted by the other, which is
-- what makes the partner request control real rather than a courtesy.

CREATE TABLE together_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pair_id uuid NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
  invited_by_user_id uuid NOT NULL REFERENCES users(id),
  invited_user_id uuid NOT NULL REFERENCES users(id),
  activity text NOT NULL CHECK (activity IN ('squat', 'bodyweightMixed', 'guidedBreathing')),
  status text NOT NULL CHECK (
    status IN ('invited', 'active', 'declined', 'ended', 'expired')
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  ended_at timestamptz,
  ended_by_user_id uuid REFERENCES users(id),
  -- An invitation that is never answered must not sit open forever offering a
  -- live channel; it expires the same way a care request does.
  expires_at timestamptz NOT NULL,
  CHECK (invited_by_user_id <> invited_user_id)
);

-- At most one session per pair may be open at a time. A partial unique index is
-- the enforcement, so two simultaneous invitations cannot race into existence.
CREATE UNIQUE INDEX together_sessions_one_open_per_pair_idx
  ON together_sessions (pair_id)
  WHERE status IN ('invited', 'active');

CREATE INDEX together_sessions_pair_recent_idx
  ON together_sessions (pair_id, created_at DESC);

-- The latest derived state each member has published within a session.
--
-- Only the newest state per member is kept. A history of a partner's rep count
-- is not something the product needs, and not keeping it is the cheapest way to
-- guarantee it cannot leak later.
CREATE TABLE together_participant_states (
  session_id uuid NOT NULL REFERENCES together_sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  repetitions integer NOT NULL DEFAULT 0 CHECK (repetitions >= 0 AND repetitions <= 10000),
  exercise_phase text NOT NULL CHECK (
    exercise_phase IN ('idle', 'descending', 'bottom', 'resting', 'complete')
  ),
  set_index integer NOT NULL DEFAULT 0 CHECK (set_index >= 0 AND set_index <= 100),
  elapsed_ms integer NOT NULL DEFAULT 0 CHECK (elapsed_ms >= 0),
  estimated_kcal numeric(6, 1) CHECK (estimated_kcal IS NULL OR estimated_kcal >= 0),
  breathing_state text CHECK (
    breathing_state IS NULL
    OR breathing_state IN ('idle', 'inhale', 'hold', 'exhale', 'holdAfter', 'complete')
  ),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, user_id)
);

-- Together events are partner-visible and therefore deliverable, so the closed
-- set of realtime event types is widened deliberately, as in 0008.
ALTER TABLE realtime_events DROP CONSTRAINT realtime_events_event_type_check;
ALTER TABLE realtime_events ADD CONSTRAINT realtime_events_event_type_check
  CHECK (event_type IN (
    'care.request.created', 'care.request.responded', 'privacy.paused',
    'privacy.resumed', 'pair.disconnected', 'pulse.snapshot.shared',
    'together.session.invited', 'together.session.accepted',
    'together.session.declined', 'together.session.ended',
    'together.state.updated'
  ));
