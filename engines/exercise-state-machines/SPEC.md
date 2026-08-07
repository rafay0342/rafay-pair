# Exercise state machine specification

Normative for every RafayPair client. Consumes the per-frame output of
`engines/pose-spec/SPEC.md` and produces sustained postures, squat repetitions,
and workout session summaries. The golden vectors in `tests/golden/exercise` are
the parity contract.

## 1. Why a state machine is required

A single frame cannot distinguish sitting from the bottom of a squat: the
skeleton is nearly identical. The difference is temporal. Sitting is a hip
elevation that stays low and still; a squat is a hip elevation that descends
from standing and returns to standing. Lying flat is likewise only credible once
it persists — a torso passing through horizontal during a burpee is not lying
down.

The state machine therefore owns every claim that depends on time, and the
static classifier owns only what a single frame can honestly support.

## 2. Constants

```text
SIT_HOLD_MS               2500    crouched must persist this long to become sitting
SIT_STABILITY_BAND        0.12    max hip-elevation spread over the hold window
LIE_HOLD_MS               1200    lying must persist this long to be committed
STAND_HOLD_MS              400    standing must persist this long to be committed

SQUAT_TOP_ELEVATION       1.30    at or above this the subject is at the top
SQUAT_BOTTOM_ELEVATION    1.05    at or below this the subject has reached depth
SQUAT_MIN_CYCLE_MS         500    faster than this is noise, not a repetition
SQUAT_MAX_CYCLE_MS        8000    slower than this is a rest, not a repetition

STALE_FRAME_MS            1500    no valid frame for this long resets to unknown
```

`SQUAT_TOP_ELEVATION` deliberately equals `STANDING_HIP_ELEVATION` and
`SQUAT_BOTTOM_ELEVATION` sits below `CROUCHED_HIP_ELEVATION`, so a counted
repetition always spans a genuine standing-to-crouched-to-standing excursion.

## 3. Sustained posture

The machine tracks a _candidate_ posture (the latest per-frame classification)
and a _committed_ posture (what the product reports).

- When the frame posture differs from the candidate, the candidate is replaced
  and its `since` timestamp set to the frame timestamp.
- The candidate is promoted to committed once it has held for its dwell time:
  `lying` needs `LIE_HOLD_MS`, `standing` needs `STAND_HOLD_MS`, `crouched`
  needs `SIT_HOLD_MS` **and** hip-elevation stability, `transitional` and
  `unknown` are never committed on their own.
- A committed posture persists until another candidate is promoted. This is the
  hysteresis that keeps the reported posture from flickering.

Crouched stability is judged over a **trailing window** of the most recent
`SIT_HOLD_MS` of crouched frames, not over the whole candidate run: the run
necessarily begins part-way through the descent, so including the descent would
hold the spread permanently outside the band and a genuinely seated subject
would never settle. Within that window, `max(hipElevation) - min(hipElevation)`
must be at most `SIT_STABILITY_BAND`.

A subject pausing at the bottom of a squat before rising does not satisfy the
hold duration; a subject genuinely seated does. When the committed posture
becomes `crouched`, it is reported to the product as `sitting`.

If no valid frame arrives for `STALE_FRAME_MS`, the committed posture resets to
`unknown` and any in-flight squat repetition is abandoned.

## 4. Reported posture

```text
engine posture     reported posture
unknown         →  unknown
transitional    →  (committed posture is retained)
standing        →  standing
lying           →  lyingDown
crouched        →  sitting
```

`sitting` and `squatting` are never reported simultaneously. While a squat
repetition is in flight, the reported posture is `squatting` regardless of the
committed posture.

## 5. Squat repetition counting

States: `idle`, `descending`, `bottom`, `ascending`.

Driven solely by `hipElevation` on valid frames.

```text
idle
  hipElevation <= SQUAT_BOTTOM_ELEVATION and the subject was previously at or
  above SQUAT_TOP_ELEVATION
    → bottom, recording cycleStartMs as the timestamp at which the descent
      from the top began, and minElevation as the current elevation

descending is entered when hipElevation first drops below SQUAT_TOP_ELEVATION
from a top position; it records cycleStartMs and tracks minElevation

descending
  hipElevation <= SQUAT_BOTTOM_ELEVATION            → bottom
  hipElevation >= SQUAT_TOP_ELEVATION               → idle   (aborted, no depth)
  now - cycleStartMs > SQUAT_MAX_CYCLE_MS           → idle   (abandoned)

bottom
  tracks minElevation
  hipElevation >= SQUAT_TOP_ELEVATION               → complete the repetition
  now - cycleStartMs > SQUAT_MAX_CYCLE_MS           → idle   (abandoned)
```

A repetition completes when the subject returns to `SQUAT_TOP_ELEVATION` having
reached `SQUAT_BOTTOM_ELEVATION`, and the elapsed cycle is within
`[SQUAT_MIN_CYCLE_MS, SQUAT_MAX_CYCLE_MS]`. A cycle shorter than the minimum is
discarded without incrementing the count: it is camera noise or a dropped
tracking frame, not a squat.

Each completed repetition records:

```text
index            1-based
startMs, endMs
durationMs
minElevation     deepest point reached
depth            (SQUAT_TOP_ELEVATION - minElevation) / SQUAT_TOP_ELEVATION
formEvents       see §6
```

Settling into a resting posture — the frame on which `sitting` or `lyingDown` is
first committed — clears any in-flight repetition and clears the "was at the
top" flag. Standing up from a chair therefore never counts as a squat, and a
subject who lowers themselves to the floor is reported as lying down rather than
being left stuck mid-repetition.

## 6. Form events

Evaluated once per completed repetition, from the frame at `minElevation`:

```text
shallowDepth      minElevation > SQUAT_BOTTOM_ELEVATION - 0.05
forwardLean       torsoAngleDeg at the deepest frame >= 45
uneven            |kneeAngle(left) - kneeAngle(right)| at the deepest frame >= 25
```

Form events are coaching hints. They are never presented as clinical
assessment, and they are never transmitted without an explicit consent grant.

## 7. Session summary

A workout session accumulates:

```text
startedAtMs, endedAtMs
repetitions          the full list from §5
repetitionCount
bestDepth            maximum depth across repetitions
averageDurationMs
postureTimelineMs    milliseconds committed to each reported posture
formEventCounts      per event type
```

Sessions are computed and stored on-device. Nothing in a session is shared with
a partner unless the `workout_progress` consent grant is active, and only the
derived summary is ever eligible for sharing — never landmarks and never frames.

## 8. Numeric parity

As in the pose specification: discrete outputs (`repetitionCount`, reported
posture, form event sets, state names) are asserted exactly; continuous values
are asserted within `1e-6`. Golden vectors avoid authoring frames within `0.01`
of any elevation threshold, so repetition counts cannot depend on last-bit
differences between platform math libraries.
