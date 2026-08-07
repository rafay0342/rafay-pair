/**
 * Finger-camera pulse estimation — reference implementation of
 * `engines/pulse-estimation-spec/SPEC.md`.
 *
 * This produces a real number from a real signal, and refuses to produce one
 * otherwise. There is no variant of the result type that can carry a
 * measured-grade reading, so nothing downstream can promote an estimate, and
 * no blood-pressure value is derived here or anywhere else.
 */

import {
  FINGER_MAX_GREEN,
  FINGER_MIN_RED,
  FINGER_MIN_RED_EXCESS,
  PULSE_CONFIDENCE_FULL_DURATION_MS,
  PULSE_DETREND_WINDOW_SAMPLES,
  PULSE_MAX_BPM,
  PULSE_MAX_DURATION_MS,
  PULSE_MAX_MOTION,
  PULSE_MIN_BPM,
  PULSE_MIN_COVERAGE,
  PULSE_MIN_DURATION_MS,
  PULSE_MIN_PERIODICITY,
  PULSE_MIN_STABILITY,
  PULSE_MOTION_SCALE,
  PULSE_SMOOTH_WINDOW_SAMPLES,
  PULSE_STABILITY_SCALE,
  PULSE_STABILITY_STEP_SAMPLES,
  PULSE_STABILITY_WINDOW_SAMPLES,
  RESAMPLE_HZ,
} from "./constants.js";
import {
  amplitudeOf,
  confidenceBandOf,
  confidenceOf,
  effectiveSampleRateHz,
  monotonic,
  motionOf,
  movingAverage,
  periodicityOf,
  qualityBandOf,
  ratePerMinuteFromLag,
  resample,
  roundToTenth,
  stabilityOf,
} from "./signal.js";
import type { PulseResult, PulseSample, SignalQuality } from "./types.js";

const MIN_LAG = Math.round((60 * RESAMPLE_HZ) / PULSE_MAX_BPM);
const MAX_LAG = Math.round((60 * RESAMPLE_HZ) / PULSE_MIN_BPM);

const EMPTY_QUALITY: SignalQuality = {
  score: 0,
  band: "poor",
  coverage: 0,
  motion: 1,
  periodicity: 0,
  amplitude: 0,
  stability: 0,
};

/**
 * @param samples per-frame region-of-interest channel means
 * @param measuredAtMs wall-clock time the measurement finished, used only for
 *   freshness; the estimate itself depends on nothing outside `samples`
 */
export function estimatePulse(
  samples: readonly PulseSample[],
  measuredAtMs: number,
): PulseResult {
  const ordered = trimToWindow(monotonic(samples));
  const sampleCount = ordered.length;
  const durationMs =
    sampleCount < 2
      ? 0
      : (ordered[sampleCount - 1] as PulseSample).timestampMs -
        (ordered[0] as PulseSample).timestampMs;

  if (sampleCount < 2 || durationMs < PULSE_MIN_DURATION_MS) {
    return {
      status: "rejected",
      reason: "tooShort",
      durationMs,
      sampleCount,
      quality: EMPTY_QUALITY,
    };
  }

  const coverage = coverageOf(ordered);
  const resampled = resample(
    ordered.map((sample) => ({
      timestampMs: sample.timestampMs,
      value: sample.red,
    })),
  );
  const detrended = subtract(
    resampled,
    movingAverage(resampled, PULSE_DETREND_WINDOW_SAMPLES),
  );
  const filtered = movingAverage(detrended, PULSE_SMOOTH_WINDOW_SAMPLES);

  const { periodicity, refinedLag } = periodicityOf(filtered, MIN_LAG, MAX_LAG);
  const motion = motionOf(resampled, PULSE_MOTION_SCALE);
  const stability = stabilityOf(filtered, {
    windowSamples: PULSE_STABILITY_WINDOW_SAMPLES,
    stepSamples: PULSE_STABILITY_STEP_SAMPLES,
    scale: PULSE_STABILITY_SCALE,
    minLag: MIN_LAG,
    maxLag: MAX_LAG,
  });
  const amplitude = amplitudeOf(filtered, resampled);

  const score =
    0.35 * periodicity + 0.25 * coverage + 0.2 * stability + 0.2 * (1 - motion);
  const quality: SignalQuality = {
    score,
    band: qualityBandOf(score),
    coverage,
    motion,
    periodicity,
    amplitude,
    stability,
  };

  // Ordering is normative: the reason is shown to the user and must name the
  // first thing they can act on.
  if (coverage < PULSE_MIN_COVERAGE) {
    return reject("fingerNotDetected", durationMs, sampleCount, quality);
  }
  if (motion > PULSE_MAX_MOTION) {
    return reject("excessiveMotion", durationMs, sampleCount, quality);
  }
  if (periodicity < PULSE_MIN_PERIODICITY || refinedLag === undefined) {
    return reject("noPeriodicity", durationMs, sampleCount, quality);
  }
  // A strong but drifting peak is not a pulse. Without this gate a periodic
  // disturbance that happens to sit in the band produces a confident number.
  if (stability < PULSE_MIN_STABILITY) {
    return reject("unstable", durationMs, sampleCount, quality);
  }

  const bpm = roundToTenth(ratePerMinuteFromLag(refinedLag));
  if (bpm < PULSE_MIN_BPM || bpm > PULSE_MAX_BPM) {
    return reject("outOfRange", durationMs, sampleCount, quality);
  }

  const confidence = confidenceOf(
    periodicity,
    stability,
    durationMs,
    PULSE_CONFIDENCE_FULL_DURATION_MS,
  );

  return {
    status: "measured",
    bpm,
    durationMs,
    sampleCount,
    effectiveSampleRateHz: effectiveSampleRateHz(sampleCount, durationMs),
    quality,
    confidence,
    confidenceBand: confidenceBandOf(confidence),
    source: "phone_camera_ppg",
    kind: "app_estimated",
    measuredAtMs,
  };
}

/** A longer session is not an error; the most recent window is used. */
function trimToWindow(samples: readonly PulseSample[]): PulseSample[] {
  if (samples.length < 2) return [...samples];
  const last = samples[samples.length - 1] as PulseSample;
  const cutoff = last.timestampMs - PULSE_MAX_DURATION_MS;
  return samples.filter((sample) => sample.timestampMs >= cutoff);
}

/**
 * With the torch lit and a fingertip covering the lens, transmitted light is
 * strongly red-dominant; an uncovered lens sees far more balanced channels.
 */
function coverageOf(samples: readonly PulseSample[]): number {
  let passing = 0;
  for (const sample of samples) {
    if (
      sample.red >= FINGER_MIN_RED &&
      sample.green <= FINGER_MAX_GREEN &&
      sample.red - sample.green >= FINGER_MIN_RED_EXCESS
    ) {
      passing += 1;
    }
  }
  return samples.length === 0 ? 0 : passing / samples.length;
}

function subtract(
  values: readonly number[],
  baseline: readonly number[],
): number[] {
  return values.map((value, index) => value - (baseline[index] as number));
}

function reject(
  reason: Extract<PulseResult, { status: "rejected" }>["reason"],
  durationMs: number,
  sampleCount: number,
  quality: SignalQuality,
): PulseResult {
  return { status: "rejected", reason, durationMs, sampleCount, quality };
}
