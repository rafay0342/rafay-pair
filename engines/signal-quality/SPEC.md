# Signal quality and the shared periodic-signal core

Normative for every RafayPair client. iOS, Android, and Web each implement this
independently; the golden vectors in `tests/golden/pulse` and
`tests/golden/breathing` are the parity contract.

Both physiological estimators in the product — finger-camera pulse and
camera-derived breathing rate — recover a rate from a noisy, irregularly sampled
one-dimensional signal. They share the machinery defined here so that there is
exactly one implementation of the hard part per platform, and one place where
the honesty rules live.

## 1. Why this shape

The product may only report a physiological number when the signal actually
supports one. That is a stronger requirement than producing a plausible number,
and it drives three choices:

- **Autocorrelation, not FFT.** Autocorrelation needs no complex arithmetic and
  no transform library, so three languages can implement it identically in a few
  dozen lines. It also yields a periodicity score as a by-product, which is
  precisely the evidence needed to decide whether to report anything at all.
- **Uniform resampling first.** Camera frame delivery is irregular. Every later
  stage assumes a fixed step, so the irregularity is resolved once, explicitly,
  rather than being smeared through the filters.
- **Rejection is a first-class outcome.** An estimator that cannot meet its
  quality bar returns a reason, never a number. Nothing downstream may
  substitute a default, carry forward a previous value, or interpolate.

## 2. Input

```text
Sample = { timestampMs, value, reference }
```

`value` is the signal of interest. `reference` is a second channel used only for
sanity checks (for pulse: the green channel, which reveals whether a fingertip
is actually covering the lens). Callers that have no second channel pass the
same number in both fields.

Samples arrive in nondecreasing timestamp order. A sample whose timestamp is not
greater than its predecessor is dropped.

## 3. Uniform resampling

```text
RESAMPLE_HZ = 30
```

The sample series is resampled onto a uniform grid of `1000 / RESAMPLE_HZ`
millisecond steps spanning the first to the last timestamp, by linear
interpolation between the two bracketing samples. The grid starts exactly at the
first sample's timestamp.

`effectiveSampleRateHz` is reported separately as
`(sampleCount - 1) * 1000 / (lastTimestampMs - firstTimestampMs)`: it describes
what the camera actually delivered, which is what a reviewer needs to judge the
measurement, and it is never used to scale any later stage.

If fewer than two samples survive, or the span is shorter than the caller's
minimum duration, the estimator rejects.

## 4. Detrending and smoothing

A moving-average high-pass removes the slow baseline drift caused by tissue
perfusion changes, exposure adjustment, and posture:

```text
detrended[n] = resampled[n] - movingAverage(resampled, DETREND_WINDOW)[n]
```

A second, much shorter moving average removes sensor noise:

```text
filtered[n] = movingAverage(detrended, SMOOTH_WINDOW)[n]
```

Window lengths are given in samples by each estimator. `movingAverage` is
centred, and at the edges it averages only the samples that exist — no padding,
no reflection — so the operation is fully specified without a boundary
convention that implementations could differ on.

The pair of moving averages is a band-pass. The smoothing window must be matched
to the top of the estimator's search band: a window far shorter than the shortest
period being searched leaves out-of-band disturbances intact, and they then
compete for the autocorrelation peak. Beyond that constraint the passband is
deliberately wide, because narrowing it further would let the filter, rather than
the evidence, decide the answer.

## 5. Periodicity by autocorrelation

For each integer lag in `[minLag, maxLag]` derived from the estimator's rate
band:

```text
correlation(lag) = sum(filtered[n] * filtered[n + lag])
                   / sqrt(sum(filtered[n]^2) * sum(filtered[n + lag]^2))
```

summed over `n` in `[0, length - lag)`. Both sums use the same `n` range, so the
result is a normalized correlation in `[-1, 1]`.

### Subharmonic suppression

Autocorrelation peaks just as strongly at whole multiples of the true period, so
an unguarded maximum reports half or a third of the real rate. This is the
classic octave error, and it is far worse than reporting nothing: a fabricated
62 BPM from a genuine 124 BPM signal looks entirely plausible.

A real subharmonic is distinguishable. If the signal truly repeats at `lag / k`,
the correlation there is comparably high; if the true period is `lag`, the
shorter lag lands antiphase and correlates negatively.

Which way to resolve the ambiguity is **a property of the signal's physics**, so
the caller declares it rather than the core assuming one answer:

```text
HarmonicFold = signalPerCycle | energyPerHalfCycle

SUBHARMONIC_RATIO  = 0.85   used by signalPerCycle
SUBHARMONIC_MARGIN = 0.02   used by energyPerHalfCycle

peakLag = argmax correlation
for k in [3, 2]:
  candidate = round(peakLag / k)
  if candidate is outside the band: continue
  wins = signalPerCycle
         ? correlation(candidate) >= SUBHARMONIC_RATIO * correlation(peakLag)
         : correlation(candidate) >= correlation(peakLag) - SUBHARMONIC_MARGIN
  if wins: bestLag = candidate; stop
otherwise bestLag = peakLag
```

The divisors are tried largest first so the shortest qualifying lag wins, which
is the fundamental rather than another multiple of it.

`signalPerCycle` is for signals where one physical event produces one signal
cycle — a heartbeat, a chest rise. A peak at twice the true lag is then a
mathematical artifact of periodicity, so a shorter lag that merely correlates
comparably should win.

`energyPerHalfCycle` is for signals where one physical cycle produces two energy
bursts. Breath sound is the case in hand: it is loud on the inhale and again on
the exhale, so its half-lag _always_ correlates well and a ratio test would halve
every rate. There the shorter lag may only win by explaining the signal at least
as well as the peak.

Using one rule for both was tried and is wrong in one direction or the other:
the ratio test halved measured breathing rates, and the margin test caused the
pulse estimator to lose the fundamental and reject as `unstable`.

### Refinement

The reported `periodicity` is the correlation at the chosen lag — the evidence
for the rate actually being reported, not for a lag that was discarded. A chosen
lag at an interior position is refined by parabolic interpolation over its two
neighbours:

```text
denominator = correlation(bestLag - 1) - 2 * correlation(bestLag) + correlation(bestLag + 1)
offset      = 0 when |denominator| < 1e-12
              otherwise 0.5 * (correlation(bestLag - 1) - correlation(bestLag + 1)) / denominator
refinedLag  = bestLag + clamp(offset, -0.5, 0.5)
```

The clamp matters: without it a nearly flat correlation curve produces an
enormous offset and a fabricated rate.

```text
ratePerMinute = 60 * RESAMPLE_HZ / refinedLag
```

## 6. Quality metrics

All are in `[0, 1]` unless stated.

```text
coverage     fraction of raw samples that pass the estimator's plausibility gate
motion       min(1, sum(|resampled[n] - resampled[n-1]|) / (length - 1) / MOTION_SCALE)
periodicity  the maximum normalized autocorrelation from §5, floored at 0
amplitude    (p95(filtered) - p5(filtered)) / max(|mean(resampled)|, 1e-6)
stability    1 - min(1, spread of per-window rates / STABILITY_SCALE)
```

`motion` is the mean absolute first difference of the _resampled_ signal, before
detrending, so a finger sliding across the lens registers even though the
band-pass would have suppressed it. Percentiles use the nearest-rank method on
the sorted array with index `floor(p * (n - 1))`, which needs no interpolation
convention.

`stability` is computed by splitting the filtered signal into windows and running
§5 on each, then measuring the spread of the resulting rates. A rate that jumps
between windows is not a rate. When the signal is too short to fit two windows
the result is zero: a session that cannot demonstrate stability does not get to
claim it.

Each estimator additionally declares a `MIN_STABILITY`, below which it rejects
with the reason `unstable`. Without that gate, a periodic disturbance that
happens to land inside the search band — someone fidgeting, a fingertip sliding
rhythmically — yields a high peak correlation and a confident-looking number.
Disagreement between windows is how that is caught.

The overall score is a fixed weighted mean of the metrics each estimator
declares, and it is mapped to a band:

```text
score >= 0.75  good
score >= 0.5   fair
otherwise      poor
```

## 7. Confidence

`confidence` is a separate number from `score`, and the distinction is
deliberate: quality describes the signal, confidence describes the estimate.

```text
confidence = clamp(0, 1, 0.5 * periodicity + 0.3 * stability + 0.2 * durationFactor)
durationFactor = clamp(0, 1, durationMs / CONFIDENCE_FULL_DURATION_MS)
```

```text
confidence >= 0.7   high
confidence >= 0.45  moderate
otherwise           low
```

A `low` confidence estimate is still returned, because the user asked for a
measurement and is entitled to see that it was weak. It must be presented as
such and must never be shared with a partner or written to a summary as if it
were a firm reading.

## 8. Numeric parity

As in the pose specification: discrete fields are asserted exactly, continuous
fields within `1e-6`. `sqrt` is exactly reproducible; the estimators avoid
transcendental functions entirely on the decision path, so the discrete outcomes
— `status`, `rejectedReason`, quality band, confidence band — are exact across
platforms.
