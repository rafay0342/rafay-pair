# Finger-camera pulse estimation

Normative for every RafayPair client. Builds on
`engines/signal-quality/SPEC.md`. Golden vectors live in `tests/golden/pulse`.

## 1. What this is, and what it is not

This estimates a pulse rate from photoplethysmography: a fingertip held over the
rear camera with the torch on, where each heartbeat changes how much light the
tissue transmits. It is a real technique and it produces a real number.

It is **not** a medical device, and the specification enforces that in code
rather than in a disclaimer:

- The result is always labelled `source = phone_camera_ppg`,
  `kind = app_estimated`. There is no field that can carry a measured-grade
  reading, so nothing downstream can promote one.
- Measurement is an explicit, user-initiated session with a fixed duration. There
  is no continuous stream, no background sampling, and no camera activation the
  user did not ask for.
- Measurement is refused while a pose workout is running (§7). A fingertip cannot
  be on the rear lens while the front camera is tracking a squat, so a request
  that arrives in that state indicates a bug, not a measurement.
- When quality is insufficient the result is a rejection with a reason. No
  estimate is produced, no previous value is reused, and no value is
  interpolated.

Blood pressure is not derived here or anywhere else. See §8.

## 2. Input

The capture layer reports, per frame, the mean channel values over a centred
region of interest covering roughly the middle third of the frame:

```text
PulseSample = { timestampMs, red, green }
```

Both are `0…255`. Only the red channel carries usable pulsatile information
through fingertip tissue; green is retained solely as the finger-presence check
in §3.

Raw frames are never retained. The capture layer converts each frame to these
two numbers and releases the buffer.

## 3. Finger presence

```text
FINGER_MIN_RED    = 60
FINGER_MAX_GREEN  = 190
FINGER_MIN_RED_EXCESS = 25
```

A sample passes the presence gate when `red >= FINGER_MIN_RED`,
`green <= FINGER_MAX_GREEN`, and `red - green >= FINGER_MIN_RED_EXCESS`.

With the torch lit and a fingertip covering the lens, transmitted light is
strongly red-dominant. An uncovered lens sees a scene whose channels are far more
balanced. `coverage` is the fraction of raw samples that pass.

```text
MIN_COVERAGE = 0.9
```

## 4. Pipeline

```text
frames
→ ROI mean red / green
→ presence gate                         §3
→ uniform resample at 30 Hz             signal-quality §3
→ detrend (moving average, 31 samples)  signal-quality §4
→ smooth (moving average, 5 samples)    signal-quality §4
→ autocorrelation over the pulse band   signal-quality §5
→ quality metrics                       §5
→ accept or reject                      §6
→ BPM, confidence, provenance
```

```text
DETREND_WINDOW_SAMPLES = 31     about 1.03 s at 30 Hz
SMOOTH_WINDOW_SAMPLES  = 5      about 0.17 s at 30 Hz
MIN_BPM = 42
MAX_BPM = 210
```

The lag band follows from the rate band: `minLag = round(60 * 30 / MAX_BPM)`,
`maxLag = round(60 * 30 / MIN_BPM)`, giving lags of 9 to 43 samples.

## 5. Quality

```text
MOTION_SCALE               = 6.0    mean absolute first difference, 0…255 scale
STABILITY_WINDOW_SAMPLES   = 150    5 s
STABILITY_STEP_SAMPLES     = 45     1.5 s
STABILITY_SCALE            = 20.0   BPM spread that drives stability to 0
CONFIDENCE_FULL_DURATION_MS = 20000
```

```text
score = 0.35 * periodicity
      + 0.25 * coverage
      + 0.20 * stability
      + 0.20 * (1 - motion)
```

`amplitude` is reported as the perfusion proxy but is deliberately excluded from
the score: it varies enormously between people and with finger pressure, so
scoring it would penalise physiology rather than signal quality.

## 6. Acceptance

```text
MIN_DURATION_MS = 8000
MAX_DURATION_MS = 45000
MIN_PERIODICITY = 0.45
MAX_MOTION      = 0.35
MIN_STABILITY   = 0.3
```

Evaluated in order; the first failure decides the rejection reason:

1. span shorter than `MIN_DURATION_MS`, or fewer than 2 usable samples →
   `tooShort`
2. `coverage < MIN_COVERAGE` → `fingerNotDetected`
3. `motion > MAX_MOTION` → `excessiveMotion`
4. `periodicity < MIN_PERIODICITY` → `noPeriodicity`
5. `stability < MIN_STABILITY` → `unstable`
6. resulting BPM outside `[MIN_BPM, MAX_BPM]` → `outOfRange`

Ordering is normative because the reason is shown to the user and must name the
first thing they can act on: telling someone their signal is not periodic when
their finger was never on the lens is useless advice.

A span longer than `MAX_DURATION_MS` is not an error; the estimator uses the
most recent `MAX_DURATION_MS` of samples.

## 7. Result

```text
PulseResult =
  { status: "measured"
    bpm                  number, rounded to one decimal
    durationMs
    sampleCount
    effectiveSampleRateHz
    quality { score, band, coverage, motion, periodicity, amplitude, stability }
    confidence, confidenceBand
    source = "phone_camera_ppg"
    kind   = "app_estimated"
    measuredAtMs }
| { status: "rejected"
    reason: tooShort | fingerNotDetected | excessiveMotion | noPeriodicity
           | unstable | outOfRange
    durationMs, sampleCount, quality }
```

A rejection still carries its quality metrics, so the user interface can explain
_which_ part of the attempt failed rather than saying only that it failed.

## 8. Freshness, sharing, and blood pressure

A pulse result is fresh for `FRESHNESS_MS = 300000` (five minutes). After that
the heart visualization must stop animating at that rate and present the value as
historical with its age, per master specification §4. Freshness is a property of
the reading, not of the screen: a stale value is stale everywhere, including for
a partner.

A result may be shared with a partner only when the `pulse_snapshots` consent
grant is active and only as the derived summary — BPM, confidence band, quality
band, measured-at time, and provenance. Sample series are never transmitted.

No blood-pressure value is derived from this signal, or from any other sensor
signal, anywhere in the product. The data model admits only manually entered or
externally imported blood pressure, and there is no code path that computes one.
