# Speaker profile

Normative for every RafayPair client that streams audio to the assistant.
Golden vectors live in `tests/golden/speaker-profile`.

## What this is, in one sentence

It tells the enrolled person's voice apart from a clearly different one, so a
partner or a stranger speaking into the same phone does not take a turn.

## What this is not

**It is not authentication.** A voice similar to the enrolled one will pass it,
a recording of the enrolled voice will pass it, and a cold or a shout may fail
it. Nothing in the product may use it as a security control, and no interface
may describe it as recognising _who_ someone is. It decides whether to send a
frame to the assistant; it decides nothing about identity, access, or trust.

This is written first because the temptation to reach for it later, in a place
where a real guarantee is needed, is the actual risk this file exists to
prevent.

## Why it can work at all

Two voices in one household usually differ in ways a small number of scalars
capture: how high the voice sits, and how energy is spread across frequency.
Those are enough to separate two ordinary speakers. They are not enough to
separate a person from an impersonation, and this specification does not claim
they are.

## Features, per 20 ms frame at 16 kHz

Extraction uses one-pole filters and autocorrelation, with no transform library,
because the same recurrence has to be exactly reproducible in TypeScript, Swift,
and Kotlin.

```text
rms            root-mean-square amplitude, 0…1
f0Hz           fundamental, by autocorrelation over 70…350 Hz
tiltMidLow     log2(midEnergy / lowEnergy)     spectral tilt, low → mid
tiltHighMid    log2(highEnergy / midEnergy)    spectral tilt, mid → high
zcr            zero crossings per sample, 0…1
```

Band energies come from one-pole filters at 500 Hz and 2000 Hz:

```text
low   = lowpass(500)
mid   = lowpass(2000) - low
high  = signal - lowpass(2000)
```

A frame is **voiced**, and therefore usable, only when:

```text
rms >= VOICED_MIN_RMS        (0.012)
peakCorrelation >= 0.30      the autocorrelation peak is a peak, not noise
f0Hz within 70…350
```

Unvoiced frames are discarded rather than given a neutral value. A neutral value
would drag every profile towards the same place and make two speakers look
alike, which is the one failure this must not have.

```text
VOICED_MIN_RMS = 0.012
F0_MIN_HZ = 70
F0_MAX_HZ = 350
MIN_PEAK_CORRELATION = 0.30
```

## Enrolment

An enrolment needs `MIN_ENROLMENT_FRAMES` voiced frames — about three seconds of
speech, not three seconds of holding the phone. Fewer produces no profile at
all rather than a weak one:

```text
MIN_ENROLMENT_FRAMES = 150
```

```text
SpeakerProfile = {
  f0Hz          median of voiced f0
  f0Spread      median absolute deviation of f0, floored at F0_SPREAD_FLOOR
  tiltMidLow    mean
  tiltHighMid   mean
  zcr           mean
  frames        how many voiced frames it was built from
}
```

```text
F0_SPREAD_FLOOR = 8.0
```

The median and the median absolute deviation are used rather than the mean and
standard deviation because one shouted word or one creaky syllable should not
move a profile. The floor on spread stops an unusually steady enrolment from
producing a profile so tight that the same person fails it the next day.

## Matching

Distance is measured in units of the enrolled speaker's own variation:

```text
d0    = |f0Hz - profile.f0Hz| / profile.f0Spread
d1    = |tiltMidLow - profile.tiltMidLow| / TILT_SCALE
d2    = |tiltHighMid - profile.tiltHighMid| / TILT_SCALE
d3    = |zcr - profile.zcr| / ZCR_SCALE

distance = sqrt(W0*d0² + W1*d1² + W2*d2² + W3*d3²)
```

```text
TILT_SCALE = 1.2
ZCR_SCALE  = 0.08
W0 = 2.0    pitch carries the most, and is the most stable across a session
W1 = 1.0
W2 = 1.0
W3 = 0.5    zero-crossing rate moves with what is being said, not only who says it
```

A frame **matches** when `distance <= MATCH_THRESHOLD`.

```text
MATCH_THRESHOLD = 2.6
```

## The decision, across frames

A single frame never decides anything. The matcher keeps a short history and
answers on the balance of it:

```text
DECISION_WINDOW = 25          half a second of voiced speech
MIN_DECIDING_FRAMES = 8       below this, no judgement is made
REJECT_RATIO = 0.65           this share of the window must mismatch to reject
```

```text
SpeakerDecision = { verdict: "enrolled" | "other" | "unknown", matchRatio, frames }
```

- `unknown` before there are enough voiced frames, or when no profile exists.
- `other` when the mismatching share reaches `REJECT_RATIO`.
- `enrolled` otherwise.

## What callers must do

**Reject only on `other`.** `unknown` must transmit.

This is the asymmetry that matters. Refusing to send audio while uncertain
means the person is not heard, and a companion that intermittently ignores its
owner is worse than one that occasionally answers someone else. The near-field
gate has already excluded the room; this only has to catch a second person
speaking into the same phone, and it should be sure before it does.

Callers must also:

- Feed every frame, voiced or not. Only voiced ones count, and the module
  decides which those are.
- Never present the verdict as identification. "Answering the enrolled voice"
  is honest; "recognising you" is not.
- Keep the microphone indicator true. What the matcher does with frames has
  nothing to do with whether the microphone is on.

## The test signal

Golden vectors describe frames rather than carrying audio, so every port
synthesises the same waveform from the same parameters. A frame of `n` samples
at `f0` and amplitude `a`, sampled at 16 kHz:

```text
s[i] = a * ( sin(2π·f0·t) + 0.5·sin(2π·2f0·t) + 0.25·sin(2π·3f0·t) ),  t = i/16000
```

A fundamental with two harmonics, because a bare sine has no spectral tilt to
measure and would make the tilt features meaningless — the vectors would then
pass while testing nothing about timbre.
