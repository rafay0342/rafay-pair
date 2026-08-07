# Microphone breathing rhythm

Normative for every RafayPair client. Implements master specification §6C. Builds
on `engines/signal-quality/SPEC.md` for the rate recovery. Golden vectors live in
`tests/golden/breathing-audio`.

## 1. Why this exists alongside the camera estimate

Breath sounds carry rhythm the camera cannot see: the subject may be lying under
a blanket, in the dark, or out of frame. The microphone estimate is available in
those situations and is otherwise the same claim — an estimate, labelled as one,
refused when the signal does not support it.

It runs **only during an explicit breathing session the user started**. There is
no background listening, and the session ends when the user ends it or the
pattern completes.

## 2. Raw audio is never retained

This is the binding rule from the master specification, and it is enforced by the
shape of the pipeline rather than by policy:

- Audio buffers are consumed inside the capture callback and converted to the
  three numbers in §4. The buffer is released immediately afterwards.
- Nothing writes audio to disk, no encoder is instantiated, and no audio buffer
  crosses a network boundary.
- The engine's input type carries no audio. It cannot: it holds only per-hop
  features, from which speech is not reconstructible.
- What leaves the capture layer per hop is a band energy, a zero-crossing rate,
  and a peak level — three scalars at 30 Hz. That is roughly 0.4% of the data
  rate of the audio itself and contains no intelligible content.

## 3. Signal chain

```text
microphone
→ band-pass 200–2000 Hz            §4
→ per-hop features                 §4
→ voice-activity and noise gate    §5
→ breath envelope
→ uniform resample, detrend, autocorrelation   signal-quality §3–5
→ accept or reject                 §6
→ breaths per minute, confidence
```

## 4. Feature extraction

The band-pass is a cascade of two one-pole filters, chosen because a one-pole
recurrence is exactly reproducible in three languages with no filter-design
library and no coefficient tables:

```text
AUDIO_SAMPLE_RATE_HZ = 16000
HIGH_PASS_HZ = 200
LOW_PASS_HZ  = 2000

highPassAlpha = 1 / (1 + 2π * HIGH_PASS_HZ / AUDIO_SAMPLE_RATE_HZ)
lowPassAlpha  = (2π * LOW_PASS_HZ / AUDIO_SAMPLE_RATE_HZ)
                / (1 + 2π * LOW_PASS_HZ / AUDIO_SAMPLE_RATE_HZ)

highPassed[n] = highPassAlpha * (highPassed[n-1] + raw[n] - raw[n-1])
banded[n]     = banded[n-1] + lowPassAlpha * (highPassed[n] - banded[n-1])
```

with `highPassed[-1] = banded[-1] = raw[-1] = 0`. Samples are floating point in
`[-1, 1]`.

Features are computed over consecutive non-overlapping hops:

```text
HOP_SAMPLES = 533        one hop per 33.3 ms, giving the 30 Hz the core expects
```

For each complete hop:

```text
rms              = sqrt(mean(banded[n]^2))            over the hop
zeroCrossingRate = crossings(banded) / (HOP_SAMPLES - 1)
peak             = max(|raw[n]|)                      over the hop, before filtering
```

A crossing is counted when consecutive samples have strictly opposite signs.
`peak` is measured on the unfiltered signal because clipping is a property of the
recording, not of the band.

A trailing partial hop is discarded rather than padded: padding would invent a
quieter hop and drag the envelope down at exactly the moment a session ends.

## 5. Voice activity and noise rejection

```text
RMS_FLOOR              = 0.0015    below this the room is effectively silent
PEAK_CLIP              = 0.98      at or above this the input clipped
ZCR_MIN                = 0.02
ZCR_MAX                = 0.45
```

A hop is _usable_ when `rms >= RMS_FLOOR`, `peak < PEAK_CLIP`, and
`ZCR_MIN <= zeroCrossingRate <= ZCR_MAX`.

The zero-crossing band is what separates breath from the two things that most
often contaminate it. Breath is broadband turbulence and sits in the middle of
the range. Sustained voiced speech is far more periodic and lands below
`ZCR_MIN`; hiss, rustling fabric, and electrical noise land above `ZCR_MAX`.

`coverage` is the fraction of hops that are usable. Unusable hops still
contribute their `rms` to the envelope — removing them would punch holes in a
signal the autocorrelation then reads as rhythm — but they lower `coverage`, and
a low enough coverage rejects the measurement outright.

## 6. Rate recovery and acceptance

The `rms` series is the breath envelope and is handed to the shared core exactly
as the camera signal is, at the same 30 Hz.

```text
DETREND_WINDOW_SAMPLES = 301   about 10 s
SMOOTH_WINDOW_SAMPLES  = 25    about 0.83 s, matched to the top of the band
MIN_BREATHS_PER_MINUTE = 6
MAX_BREATHS_PER_MINUTE = 36

MOTION_SCALE                = 0.05   envelope units; audio is far smaller-scale
STABILITY_WINDOW_SAMPLES    = 450    15 s
STABILITY_STEP_SAMPLES      = 150    5 s
STABILITY_SCALE             = 6.0
CONFIDENCE_FULL_DURATION_MS = 45000

MIN_DURATION_MS = 20000
MIN_COVERAGE    = 0.6
MIN_PERIODICITY = 0.4
MAX_MOTION      = 0.6
MIN_STABILITY   = 0.3
```

`MIN_COVERAGE` is lower than the camera estimate's because a real breathing
session legitimately contains quiet gaps between breaths, and those hops fall
below the RMS floor. Requiring 80% would reject slow, calm breathing — precisely
the case the feature is most useful for.

```text
score = 0.4 * periodicity + 0.25 * coverage + 0.2 * stability + 0.15 * (1 - motion)
```

Acceptance is evaluated in order, and the first failure names the reason:

1. span shorter than `MIN_DURATION_MS`, or fewer than 2 hops → `tooShort`
2. `coverage < MIN_COVERAGE` → `notAudible`
3. `motion > MAX_MOTION` → `tooNoisy`
4. `periodicity < MIN_PERIODICITY` → `noPeriodicity`
5. `stability < MIN_STABILITY` → `unstable`
6. rate outside the band → `outOfRange`

```text
AudioBreathingResult =
  { status: "measured"
    breathsPerMinute      rounded to one decimal
    durationMs, hopCount, quality, confidence, confidenceBand
    source = "phone_microphone"
    kind   = "app_estimated"
    measuredAtMs }
| { status: "rejected"
    reason: tooShort | notAudible | tooNoisy | noPeriodicity | unstable | outOfRange
    durationMs, hopCount, quality }
```

## 7. Parity

Two contracts are tested, not one:

- **Feature extraction.** `tests/golden/breathing-audio/frames/*.json` carry raw
  PCM and the expected per-hop features, so a port cannot drift in the filter or
  the hop boundaries without failing.
- **Rate recovery.** `tests/golden/breathing-audio/*.json` carry feature series
  and expected results.

Splitting them means a failure says which half broke. Discrete fields are
asserted exactly and continuous ones within `1e-6`, as elsewhere.
