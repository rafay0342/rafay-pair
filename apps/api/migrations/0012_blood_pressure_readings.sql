-- Blood pressure the user brings, never blood pressure this product derives.
--
-- Master specification §5: a smartphone must not be represented as an accurate
-- blood-pressure instrument, so the supported sources are exactly two — a
-- reading the user typed from a real cuff, and a record imported from the
-- phone's health repository with its origin preserved. There is no camera path,
-- no face path, no voice path, and no model. The `source` and
-- `measurement_kind` checks below are what make that structural rather than a
-- convention: a row that claims to be an app estimate cannot be written,
-- because no such value exists in the constraint.
--
-- Migration 0008 stated that there is deliberately no blood-pressure table
-- anywhere in this schema. That was true of estimated blood pressure and stays
-- true. This table holds only readings whose origin is a real instrument.

CREATE TABLE blood_pressure_readings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Ranges a real cuff can produce. A value outside them is a typo or a
  -- different unit, and storing it would put an impossible number in front of
  -- someone who may act on it.
  systolic smallint NOT NULL CHECK (systolic BETWEEN 60 AND 260),
  diastolic smallint NOT NULL CHECK (diastolic BETWEEN 30 AND 200),
  -- Pulse is optional because not every cuff reports one, and a cuff's pulse is
  -- a different measurement from the app's camera estimate. They are never
  -- merged: this column is only ever what the cuff displayed.
  pulse_bpm smallint CHECK (pulse_bpm BETWEEN 30 AND 240),
  CONSTRAINT blood_pressure_systolic_above_diastolic
    CHECK (systolic > diastolic),

  source text NOT NULL CHECK (
    source IN ('manual_entry', 'imported_health_record')
  ),
  measurement_kind text NOT NULL CHECK (
    measurement_kind IN ('manually_entered', 'externally_sourced')
  ),
  -- An imported record keeps the name of where it came from, because
  -- "externally sourced" without the source is not provenance. Manual entries
  -- have none, and the constraint enforces the pairing in both directions.
  external_origin text CHECK (
    external_origin IS NULL OR length(btrim(external_origin)) BETWEEN 1 AND 120
  ),
  CONSTRAINT blood_pressure_origin_matches_source CHECK (
    (source = 'manual_entry'
      AND measurement_kind = 'manually_entered'
      AND external_origin IS NULL)
    OR
    (source = 'imported_health_record'
      AND measurement_kind = 'externally_sourced'
      AND external_origin IS NOT NULL)
  ),

  -- When the cuff took it, which is not when the phone recorded it.
  measured_at timestamptz NOT NULL,
  note text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 280),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX blood_pressure_readings_user_idx
  ON blood_pressure_readings (user_id, measured_at DESC);

-- Importing the same health record twice must not create a second reading. The
-- health repository's own identifier is the only thing that can say "same
-- record", so it is stored and made unique per user when present.
ALTER TABLE blood_pressure_readings
  ADD COLUMN external_record_id text CHECK (
    external_record_id IS NULL
    OR length(btrim(external_record_id)) BETWEEN 1 AND 200
  );

CREATE UNIQUE INDEX blood_pressure_readings_external_record_idx
  ON blood_pressure_readings (user_id, external_record_id)
  WHERE external_record_id IS NOT NULL;

COMMENT ON TABLE blood_pressure_readings IS
  'Blood pressure from a real instrument only: typed by the user, or imported with its origin. Never derived.';
