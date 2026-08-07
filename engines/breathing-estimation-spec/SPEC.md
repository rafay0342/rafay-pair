# Breathing

Normative for every RafayPair client. The estimator builds on
`engines/signal-quality/SPEC.md`. Golden vectors live in
`tests/golden/breathing`.

Two modes ship. Guided breathing requires no estimation at all and is therefore
always available. The camera estimate is an estimate, is labelled as one, and
refuses to answer when the signal is weak.

## 1. Guided breathing

A guided session is a deterministic schedule. Given a pattern and a cycle count,
the same schedule is produced everywhere, which is what lets two partners breathe
together without either device being authoritative.

```text
BreathingPattern = { inhaleMs, holdMs, exhaleMs, holdAfterMs, cycles }
```

```text
CALM     = { 4000, 0,    6000, 0,    cycles }   longer exhale settles arousal
BOX      = { 4000, 4000, 4000, 4000, cycles }
RELAX    = { 4000, 7000, 8000, 0,    cycles }
```

`phaseAt(pattern, elapsedMs)` returns the phase, the index of the current cycle,
and the progress through that phase in `[0, 1)`:

- Zero-length phases are skipped entirely rather than reported with zero
  progress, so an animation never has to special-case them.
- `elapsedMs` at or beyond `totalDurationMs` returns the `complete` phase.
- `totalDurationMs = cycles * (inhaleMs + holdMs + exhaleMs + holdAfterMs)`.

Guided breathing produces no physiological claim. It has no confidence, no
quality, and nothing to reject.

## 2. Camera chest-motion estimate

The subject is already in frame for a pose session, so the vertical position of
the shoulder centre is available at no extra sensor cost. It rises and falls with
the breath.

```text
signal[n] = shoulderCenterY(n) / torsoScale(n)
```

Dividing by the torso scale makes the signal invariant to the subject's distance
from the camera, exactly as `hipElevation` is in the pose specification. Frames
the pose engine marked invalid are excluded, and their exclusion lowers coverage.

```text
RESAMPLE_HZ            = 30    inherited from signal-quality
DETREND_WINDOW_SAMPLES = 301   about 10 s
SMOOTH_WINDOW_SAMPLES  = 25    about 0.83 s
MIN_BREATHS_PER_MINUTE = 6
MAX_BREATHS_PER_MINUTE = 36
```

The detrend window is an order of magnitude longer than the pulse one because
breathing is an order of magnitude slower; a 1 s window would remove the very
oscillation being measured. The smoothing window is matched to the top of the
search band (36 breaths per minute, 0.6 Hz) rather than chosen for mild
denoising: a shorter window leaves ordinary fidgeting — which is periodic, and
well above the breathing band — intact, and it then competes for the
autocorrelation peak and wins.

```text
MOTION_SCALE                = 0.4
STABILITY_WINDOW_SAMPLES    = 450   15 s
STABILITY_STEP_SAMPLES      = 150   5 s
STABILITY_SCALE             = 6.0   breaths-per-minute spread
CONFIDENCE_FULL_DURATION_MS = 45000
MIN_DURATION_MS             = 20000
MIN_COVERAGE                = 0.8
MIN_PERIODICITY             = 0.4
MAX_MOTION                  = 0.5
MIN_STABILITY               = 0.3
```

```text
score = 0.4 * periodicity + 0.25 * coverage + 0.2 * stability + 0.15 * (1 - motion)
```

Acceptance mirrors the pulse estimator, in the same order and with the same
rejection reasons, except that `fingerNotDetected` is replaced by `notTracked`:
the failure being reported is that the body was not reliably in frame.

```text
BreathingResult =
  { status: "measured"
    breathsPerMinute      rounded to one decimal
    durationMs, sampleCount, effectiveSampleRateHz
    quality { score, band, coverage, motion, periodicity, amplitude, stability }
    confidence, confidenceBand
    source = "phone_camera_motion"
    kind   = "app_estimated"
    measuredAtMs }
| { status: "rejected"
    reason: tooShort | notTracked | excessiveMotion | noPeriodicity
           | unstable | outOfRange
    durationMs, sampleCount, quality }
```

## 3. Microphone mode

Master specification §6C permits a microphone-based rhythm estimate during an
explicit breathing session. It is **not implemented in this gate**. Recording
this here rather than silently omitting it: the feature needs an audio capture
path with its own retention rules, and shipping a half-specified one alongside a
camera estimate that already covers the same product need would add microphone
permission exposure for no user-visible gain.

When it is implemented, the raw audio retention rule from the master
specification is binding: audio is processed in-session and not retained by
default.

## 4. Sharing

A breathing estimate is a derived summary and follows the same consent rule as
pulse: it may reach a partner only under an active consent grant, and only as
the summary. Landmark series and audio never leave the device.
