-- Consent-gated sharing of the latest phone-camera pulse estimate.
--
-- Only the derived summary is ever stored: a rate, its confidence and quality
-- bands, and its provenance. The sample series that produced it never leaves the
-- device, so there is no column here that could hold one.
--
-- `source` and `kind` are constrained rather than free text so that no code path
-- can write a value that implies a measured-grade or medical reading. There is
-- deliberately no blood-pressure table anywhere in this schema.

CREATE TABLE pulse_snapshots (
  pair_id uuid NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  bpm numeric(5, 1) NOT NULL CHECK (bpm >= 42 AND bpm <= 210),
  confidence_band text NOT NULL CHECK (
    confidence_band IN ('low', 'moderate', 'high')
  ),
  quality_band text NOT NULL CHECK (quality_band IN ('poor', 'fair', 'good')),
  source text NOT NULL CHECK (source IN ('phone_camera_ppg')),
  kind text NOT NULL CHECK (kind IN ('app_estimated')),
  measured_at timestamptz NOT NULL,
  shared_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pair_id, owner_user_id)
);

-- A partner reads the other member's row; the owner's own row is read by pair
-- and owner together, so the primary key already covers both access patterns.

CREATE INDEX pulse_snapshots_measured_at_idx
  ON pulse_snapshots (pair_id, measured_at DESC);

-- `realtime_events.event_type` is a closed set so that an unknown event can
-- never reach a partner's socket. Adding a deliverable event therefore requires
-- widening it here, deliberately, rather than the constraint silently drifting.
ALTER TABLE realtime_events DROP CONSTRAINT realtime_events_event_type_check;
ALTER TABLE realtime_events ADD CONSTRAINT realtime_events_event_type_check
  CHECK (event_type IN (
    'care.request.created', 'care.request.responded', 'privacy.paused',
    'privacy.resumed', 'pair.disconnected', 'pulse.snapshot.shared'
  ));
