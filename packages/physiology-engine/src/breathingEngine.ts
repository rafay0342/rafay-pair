/**
 * Breathing — reference implementation of
 * `engines/breathing-estimation-spec/SPEC.md`.
 *
 * Guided breathing is a deterministic schedule and makes no physiological
 * claim. The camera estimate reuses the shared periodic-signal core and, like
 * the pulse estimator, refuses to answer when the signal is weak.
 */

import {
  BREATHING_CONFIDENCE_FULL_DURATION_MS,
  BREATHING_DETREND_WINDOW_SAMPLES,
  BREATHING_MAX_MOTION,
  BREATHING_MAX_PER_MINUTE,
  BREATHING_MIN_COVERAGE,
  BREATHING_MIN_DURATION_MS,
  BREATHING_MIN_PERIODICITY,
  BREATHING_MIN_STABILITY,
  BREATHING_MIN_PER_MINUTE,
  BREATHING_MOTION_SCALE,
  BREATHING_SMOOTH_WINDOW_SAMPLES,
  BREATHING_STABILITY_SCALE,
  BREATHING_STABILITY_STEP_SAMPLES,
  BREATHING_STABILITY_WINDOW_SAMPLES,
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
import type {
  BreathingPattern,
  BreathingPhase,
  BreathingPhaseState,
  BreathingResult,
  BreathingSample,
  SignalQuality,
} from "./types.js";

const MIN_LAG = Math.round((60 * RESAMPLE_HZ) / BREATHING_MAX_PER_MINUTE);
const MAX_LAG = Math.round((60 * RESAMPLE_HZ) / BREATHING_MIN_PER_MINUTE);

/** Longer exhale than inhale; the pattern that settles arousal. */
export const CALM_PATTERN = (cycles: number): BreathingPattern => ({
  inhaleMs: 4000,
  holdMs: 0,
  exhaleMs: 6000,
  holdAfterMs: 0,
  cycles,
});

export const BOX_PATTERN = (cycles: number): BreathingPattern => ({
  inhaleMs: 4000,
  holdMs: 4000,
  exhaleMs: 4000,
  holdAfterMs: 4000,
  cycles,
});

export const RELAX_PATTERN = (cycles: number): BreathingPattern => ({
  inhaleMs: 4000,
  holdMs: 7000,
  exhaleMs: 8000,
  holdAfterMs: 0,
  cycles,
});

export function cycleDurationMs(pattern: BreathingPattern): number {
  return (
    pattern.inhaleMs + pattern.holdMs + pattern.exhaleMs + pattern.holdAfterMs
  );
}

export function totalDurationMs(pattern: BreathingPattern): number {
  return cycleDurationMs(pattern) * pattern.cycles;
}

/**
 * The phase at a point in a guided session.
 *
 * The same schedule is produced everywhere, which is what lets two partners
 * breathe together without either device being authoritative. Zero-length
 * phases are skipped rather than reported with zero progress, so an animation
 * never has to special-case them.
 */
export function phaseAt(
  pattern: BreathingPattern,
  elapsedMs: number,
): BreathingPhaseState {
  const cycleMs = cycleDurationMs(pattern);
  const totalMs = totalDurationMs(pattern);
  if (cycleMs <= 0 || pattern.cycles <= 0 || elapsedMs >= totalMs) {
    return {
      phase: "complete",
      cycleIndex: Math.max(0, pattern.cycles - 1),
      progress: 1,
      remainingMs: 0,
    };
  }

  const clampedElapsed = Math.max(0, elapsedMs);
  const cycleIndex = Math.floor(clampedElapsed / cycleMs);
  let offset = clampedElapsed - cycleIndex * cycleMs;

  const segments: readonly { phase: BreathingPhase; durationMs: number }[] = [
    { phase: "inhale", durationMs: pattern.inhaleMs },
    { phase: "hold", durationMs: pattern.holdMs },
    { phase: "exhale", durationMs: pattern.exhaleMs },
    { phase: "holdAfter", durationMs: pattern.holdAfterMs },
  ];

  for (const segment of segments) {
    if (segment.durationMs <= 0) continue;
    if (offset < segment.durationMs) {
      return {
        phase: segment.phase,
        cycleIndex,
        progress: offset / segment.durationMs,
        remainingMs: segment.durationMs - offset,
      };
    }
    offset -= segment.durationMs;
  }

  // Unreachable while the segments sum to the cycle length; returning the last
  // real phase rather than throwing keeps a rounding edge from stopping a
  // session mid-breath.
  return {
    phase: "holdAfter",
    cycleIndex,
    progress: 1,
    remainingMs: 0,
  };
}

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
 * Minimum torso scale and joint visibility for a frame to become a sample.
 *
 * Matched to the pose engine's own thresholds, so a frame the pose engine would
 * reject cannot enter the breathing estimator through a side door.
 */
export const BREATHING_MIN_TORSO_SCALE = 0.08;
export const BREATHING_MIN_VISIBILITY = 0.5;

export interface ChestPoint {
  readonly x: number;
  readonly y: number;
  readonly visibility: number;
}

/**
 * Builds one breathing sample from pose landmarks.
 *
 * `engines/breathing-estimation-spec/SPEC.md` §4 is normative. Dividing by torso
 * scale makes the value invariant to distance from the camera: without it,
 * walking towards the lens would read as an inhale.
 */
export function chestSampleFromLandmarks(input: {
  readonly timestampMs: number;
  readonly leftShoulder: ChestPoint;
  readonly rightShoulder: ChestPoint;
  readonly leftHip: ChestPoint;
  readonly rightHip: ChestPoint;
}): BreathingSample {
  const shoulderX = (input.leftShoulder.x + input.rightShoulder.x) / 2;
  const shoulderY = (input.leftShoulder.y + input.rightShoulder.y) / 2;
  const hipX = (input.leftHip.x + input.rightHip.x) / 2;
  const hipY = (input.leftHip.y + input.rightHip.y) / 2;
  const torsoScale = Math.hypot(shoulderX - hipX, shoulderY - hipY);

  const visibility = Math.min(
    input.leftShoulder.visibility,
    input.rightShoulder.visibility,
    input.leftHip.visibility,
    input.rightHip.visibility,
  );
  const tracked =
    torsoScale >= BREATHING_MIN_TORSO_SCALE &&
    visibility >= BREATHING_MIN_VISIBILITY;

  return {
    timestampMs: input.timestampMs,
    // A frame with no usable torso has no meaningful offset; zero is carried
    // alongside `tracked: false` so the estimator drops it rather than
    // interpolating across a gap it cannot see.
    chestOffset: tracked ? shoulderY / torsoScale : 0,
    tracked,
  };
}

/**
 * Camera chest-motion estimate.
 *
 * The subject is already in frame for a pose session, so the shoulder-centre
 * height costs no extra sensor. Dividing by torso scale upstream makes it
 * invariant to distance from the camera.
 */
export function estimateBreathing(
  samples: readonly BreathingSample[],
  measuredAtMs: number,
): BreathingResult {
  const ordered = monotonic(samples);
  const sampleCount = ordered.length;
  const durationMs =
    sampleCount < 2
      ? 0
      : (ordered[sampleCount - 1] as BreathingSample).timestampMs -
        (ordered[0] as BreathingSample).timestampMs;

  if (sampleCount < 2 || durationMs < BREATHING_MIN_DURATION_MS) {
    return {
      status: "rejected",
      reason: "tooShort",
      durationMs,
      sampleCount,
      quality: EMPTY_QUALITY,
    };
  }

  let tracked = 0;
  for (const sample of ordered) if (sample.tracked) tracked += 1;
  const coverage = tracked / sampleCount;

  const resampled = resample(
    ordered.map((sample) => ({
      timestampMs: sample.timestampMs,
      value: sample.chestOffset,
    })),
  );
  const baseline = movingAverage(resampled, BREATHING_DETREND_WINDOW_SAMPLES);
  const detrended = resampled.map(
    (value, index) => value - (baseline[index] as number),
  );
  const filtered = movingAverage(detrended, BREATHING_SMOOTH_WINDOW_SAMPLES);

  const { periodicity, refinedLag } = periodicityOf(filtered, MIN_LAG, MAX_LAG);
  const motion = motionOf(resampled, BREATHING_MOTION_SCALE);
  const stability = stabilityOf(filtered, {
    windowSamples: BREATHING_STABILITY_WINDOW_SAMPLES,
    stepSamples: BREATHING_STABILITY_STEP_SAMPLES,
    scale: BREATHING_STABILITY_SCALE,
    minLag: MIN_LAG,
    maxLag: MAX_LAG,
  });
  const amplitude = amplitudeOf(filtered, resampled);

  const score =
    0.4 * periodicity + 0.25 * coverage + 0.2 * stability + 0.15 * (1 - motion);
  const quality: SignalQuality = {
    score,
    band: qualityBandOf(score),
    coverage,
    motion,
    periodicity,
    amplitude,
    stability,
  };

  if (coverage < BREATHING_MIN_COVERAGE) {
    return reject("notTracked", durationMs, sampleCount, quality);
  }
  if (motion > BREATHING_MAX_MOTION) {
    return reject("excessiveMotion", durationMs, sampleCount, quality);
  }
  if (periodicity < BREATHING_MIN_PERIODICITY || refinedLag === undefined) {
    return reject("noPeriodicity", durationMs, sampleCount, quality);
  }
  // A strong but drifting peak is not a breathing rate. Fidgeting produces a
  // periodic disturbance that can land in the band; disagreeing windows are how
  // that is caught.
  if (stability < BREATHING_MIN_STABILITY) {
    return reject("unstable", durationMs, sampleCount, quality);
  }

  const breathsPerMinute = roundToTenth(ratePerMinuteFromLag(refinedLag));
  if (
    breathsPerMinute < BREATHING_MIN_PER_MINUTE ||
    breathsPerMinute > BREATHING_MAX_PER_MINUTE
  ) {
    return reject("outOfRange", durationMs, sampleCount, quality);
  }

  const confidence = confidenceOf(
    periodicity,
    stability,
    durationMs,
    BREATHING_CONFIDENCE_FULL_DURATION_MS,
  );

  return {
    status: "measured",
    breathsPerMinute,
    durationMs,
    sampleCount,
    effectiveSampleRateHz: effectiveSampleRateHz(sampleCount, durationMs),
    quality,
    confidence,
    confidenceBand: confidenceBandOf(confidence),
    source: "phone_camera_motion",
    kind: "app_estimated",
    measuredAtMs,
  };
}

function reject(
  reason: Extract<BreathingResult, { status: "rejected" }>["reason"],
  durationMs: number,
  sampleCount: number,
  quality: SignalQuality,
): BreathingResult {
  return { status: "rejected", reason, durationMs, sampleCount, quality };
}
