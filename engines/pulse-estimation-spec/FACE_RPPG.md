# Face-camera pulse, research mode

Normative for every RafayPair client. Implements master specification §3.3.
Builds on `engines/signal-quality/SPEC.md`. Golden vectors live in
`tests/golden/face-rppg`.

## 1. Standing, and the rules that follow from it

Remote photoplethysmography recovers a pulse from the tiny colour change a
heartbeat produces in facial skin. The signal is real but roughly an order of
magnitude weaker than the fingertip signal, and it is far more easily destroyed
by light, movement, and skin tone variation.

The master specification therefore admits it only as **experimental research
mode**, and every rule it attaches is enforced here structurally:

| Rule                               | How it is enforced                                                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Experimental only                  | Behind `FACE_RPPG_ENABLED`; off by default, and §7 requires the application to build and run with it off                     |
| Must disclose it is an estimate    | `source = "face_camera_rppg"`, `kind = "app_estimated"`, `experimental = true` are literals on the result type               |
| Never used for diagnosis           | No result field can carry a measured-grade value, and nothing consumes it as one                                             |
| Never silently activate the camera | Capture starts only from an explicit user action inside this mode; the same permission and session lifecycle as finger pulse |
| Device and lighting quality gate   | §4, evaluated before any rate is reported                                                                                    |
| Must expose confidence             | Confidence and its band are on every measured result, as elsewhere                                                           |
| Removable without breaking the app | §7                                                                                                                           |

Thresholds throughout are stricter than the fingertip estimator's. A weaker
signal earns _less_ benefit of the doubt, not more.

## 2. Input

The capture layer detects a face, takes a region on the forehead and upper
cheeks — the best-perfused skin that is least occluded by hair and glasses — and
reports per frame:

```text
FaceRppgSample = { timestampMs, green, luma, faceArea, faceCenterX, faceCenterY }
```

`green` is the mean green channel over the region, `0…255`; haemoglobin absorbs
green most strongly, which is why it carries the pulsatile component. `luma` is
the mean brightness of the same region and drives the lighting gate. `faceArea`
is the detected face box area as a fraction of the frame, and the two centre
coordinates are frame-normalized; together they detect head movement.

No image is retained. The capture layer produces these six numbers per frame and
releases the buffer, exactly as the fingertip path does.

## 3. Pipeline

```text
front camera
→ face detection
→ forehead and upper-cheek region
→ mean green and luma                        §2
→ lighting and stability gate                §4
→ uniform resample at 30 Hz                  signal-quality §3
→ detrend (moving average, 61 samples)       signal-quality §4
→ smooth (moving average, 7 samples)         signal-quality §4
→ autocorrelation over the pulse band        signal-quality §5, signalPerCycle
→ accept or reject                           §5
→ BPM, confidence, provenance
```

```text
FACE_DETREND_WINDOW_SAMPLES = 61    about 2 s
FACE_SMOOTH_WINDOW_SAMPLES  = 7
FACE_MIN_BPM = 42
FACE_MAX_BPM = 180
```

The detrend window is twice the fingertip one because the facial signal rides on
a slower and larger illumination drift, and the upper rate bound is lower because
a resting face in front of a phone is not a post-sprint fingertip.

## 4. Lighting and stability gate

```text
FACE_MIN_LUMA          = 60      too dark: shot noise swamps the signal
FACE_MAX_LUMA          = 235     too bright: the sensor is clipping
FACE_MIN_AREA          = 0.04    face too small or absent
FACE_MAX_CENTER_SHIFT  = 0.03    per-frame head movement, frame-normalized
FACE_MAX_LUMA_SWING    = 0.18    fractional luma range across the session
```

A frame is _usable_ when `FACE_MIN_LUMA <= luma <= FACE_MAX_LUMA`,
`faceArea >= FACE_MIN_AREA`, and its centre moved less than
`FACE_MAX_CENTER_SHIFT` from the previous usable frame. `coverage` is the
fraction of usable frames.

`lumaSwing` is `(max(luma) - min(luma)) / max(mean(luma), 1)` across the session.
Changing light — a cloud, a screen, someone walking past a lamp — produces
exactly the slow brightness oscillation an rPPG estimator mistakes for a pulse,
so a session that exceeds `FACE_MAX_LUMA_SWING` is rejected as `unstableLighting`
rather than measured. This gate has no counterpart in the fingertip path, where
the torch fixes illumination.

## 5. Acceptance

```text
FACE_MIN_DURATION_MS = 15000
FACE_MAX_DURATION_MS = 60000
FACE_MIN_COVERAGE    = 0.85
FACE_MIN_PERIODICITY = 0.6     stricter than the fingertip's 0.45
FACE_MAX_MOTION      = 0.3
FACE_MIN_STABILITY   = 0.45    stricter than the fingertip's 0.3
FACE_MOTION_SCALE               = 4.0
FACE_STABILITY_WINDOW_SAMPLES   = 240   8 s
FACE_STABILITY_STEP_SAMPLES     = 60    2 s
FACE_STABILITY_SCALE            = 15.0
FACE_CONFIDENCE_FULL_DURATION_MS = 40000
```

Evaluated in order; the first failure decides the reason:

1. span shorter than `FACE_MIN_DURATION_MS`, or fewer than 2 samples → `tooShort`
2. `coverage < FACE_MIN_COVERAGE` → `faceNotStable`
3. `lumaSwing > FACE_MAX_LUMA_SWING` → `unstableLighting`
4. `motion > FACE_MAX_MOTION` → `excessiveMotion`
5. `periodicity < FACE_MIN_PERIODICITY` → `noPeriodicity`
6. `stability < FACE_MIN_STABILITY` → `unstable`
7. resulting BPM outside the band → `outOfRange`

```text
score = 0.4 * periodicity + 0.2 * coverage + 0.2 * stability + 0.2 * (1 - motion)
```

```text
FaceRppgResult =
  { status: "measured"
    bpm, durationMs, sampleCount, effectiveSampleRateHz
    quality { score, band, coverage, motion, periodicity, amplitude, stability }
    lumaSwing
    confidence, confidenceBand
    source       = "face_camera_rppg"
    kind         = "app_estimated"
    experimental = true
    measuredAtMs }
| { status: "rejected"
    reason: tooShort | faceNotStable | unstableLighting | excessiveMotion
          | noPeriodicity | unstable | outOfRange
    durationMs, sampleCount, quality, lumaSwing }
```

## 6. What it may and may not feed

A face-camera result **may not**:

- become the heart visualization's animated rate,
- be shared with a partner under `pulse_snapshots`, or
- be stored as the latest pulse.

Those surfaces are reserved for the fingertip measurement, whose provenance the
product is willing to stand behind. The research result is displayed in its own
place, labelled experimental, and goes no further. This is a deliberate
containment boundary: it is what lets the mode exist at all without diluting a
claim the rest of the product makes carefully.

## 7. Removability

The master specification requires that this mode be removable without breaking
the application. That is a testable property, not a comment:

- `FACE_RPPG_ENABLED` is a single flag. With it off, the capture layer is never
  constructed, the surface is absent, and no other feature references the
  engine.
- Deleting `faceRppgEngine` and its surface must leave the application building
  and every other suite passing. The dependency direction is one-way: the engine
  imports the shared core, and nothing in the product imports the engine except
  its own surface.

## 8. Parity

As elsewhere: discrete fields exactly, continuous within `1e-6`, three
independent implementations against the same committed vectors.
