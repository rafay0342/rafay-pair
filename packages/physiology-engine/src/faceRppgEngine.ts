/**
 * Face-camera pulse, research mode — reference implementation of
 * `engines/pulse-estimation-spec/FACE_RPPG.md` (master specification §3.3).
 *
 * Experimental by construction. The result type carries `experimental: true` as
 * a literal, and §6 of the specification forbids this result from feeding the
 * heart visualization, the consent-gated share, or the stored latest pulse.
 * Nothing outside this module and its own surface imports it, which is what
 * makes the mode removable without breaking the application.
 */

import {
  FACE_CONFIDENCE_FULL_DURATION_MS,
  FACE_DETREND_WINDOW_SAMPLES,
  FACE_MAX_BPM,
  FACE_MAX_CENTER_SHIFT,
  FACE_MAX_DURATION_MS,
  FACE_MAX_LUMA,
  FACE_MAX_LUMA_SWING,
  FACE_MAX_MOTION,
  FACE_MIN_AREA,
  FACE_MIN_BPM,
  FACE_MIN_COVERAGE,
  FACE_MIN_DURATION_MS,
  FACE_MIN_LUMA,
  FACE_MIN_PERIODICITY,
  FACE_MIN_STABILITY,
  FACE_MOTION_SCALE,
  FACE_SMOOTH_WINDOW_SAMPLES,
  FACE_STABILITY_SCALE,
  FACE_STABILITY_STEP_SAMPLES,
  FACE_STABILITY_WINDOW_SAMPLES,
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
import type { FaceRppgResult, FaceRppgSample, SignalQuality } from "./types.js";

const MIN_LAG = Math.round((60 * RESAMPLE_HZ) / FACE_MAX_BPM);
const MAX_LAG = Math.round((60 * RESAMPLE_HZ) / FACE_MIN_BPM);

const EMPTY_QUALITY: SignalQuality = {
  score: 0,
  band: "poor",
  coverage: 0,
  motion: 1,
  periodicity: 0,
  amplitude: 0,
  stability: 0,
};

export function estimateFaceRppg(
  samples: readonly FaceRppgSample[],
  measuredAtMs: number,
): FaceRppgResult {
  const ordered = trimToWindow(monotonic(samples));
  const sampleCount = ordered.length;
  const durationMs =
    sampleCount < 2
      ? 0
      : (ordered[sampleCount - 1] as FaceRppgSample).timestampMs -
        (ordered[0] as FaceRppgSample).timestampMs;

  if (sampleCount < 2 || durationMs < FACE_MIN_DURATION_MS) {
    return {
      status: "rejected",
      reason: "tooShort",
      durationMs,
      sampleCount,
      quality: EMPTY_QUALITY,
      lumaSwing: 0,
    };
  }

  const coverage = coverageOf(ordered);
  const lumaSwing = lumaSwingOf(ordered);

  // Haemoglobin absorbs green most strongly, which is why the green channel
  // rather than the red one carries the pulsatile component through skin.
  const resampled = resample(
    ordered.map((sample) => ({
      timestampMs: sample.timestampMs,
      value: sample.green,
    })),
  );
  const baseline = movingAverage(resampled, FACE_DETREND_WINDOW_SAMPLES);
  const detrended = resampled.map(
    (value, index) => value - (baseline[index] as number),
  );
  const filtered = movingAverage(detrended, FACE_SMOOTH_WINDOW_SAMPLES);

  const { periodicity, refinedLag } = periodicityOf(filtered, MIN_LAG, MAX_LAG);
  const motion = motionOf(resampled, FACE_MOTION_SCALE);
  const stability = stabilityOf(filtered, {
    windowSamples: FACE_STABILITY_WINDOW_SAMPLES,
    stepSamples: FACE_STABILITY_STEP_SAMPLES,
    scale: FACE_STABILITY_SCALE,
    minLag: MIN_LAG,
    maxLag: MAX_LAG,
  });
  const amplitude = amplitudeOf(filtered, resampled);

  const score =
    0.4 * periodicity + 0.2 * coverage + 0.2 * stability + 0.2 * (1 - motion);
  const quality: SignalQuality = {
    score,
    band: qualityBandOf(score),
    coverage,
    motion,
    periodicity,
    amplitude,
    stability,
  };

  if (coverage < FACE_MIN_COVERAGE) {
    return reject("faceNotStable", durationMs, sampleCount, quality, lumaSwing);
  }
  // Changing light produces exactly the slow brightness oscillation an rPPG
  // estimator mistakes for a pulse. The torch removes this problem on the
  // fingertip path; here it has to be caught.
  if (lumaSwing > FACE_MAX_LUMA_SWING) {
    return reject(
      "unstableLighting",
      durationMs,
      sampleCount,
      quality,
      lumaSwing,
    );
  }
  if (motion > FACE_MAX_MOTION) {
    return reject(
      "excessiveMotion",
      durationMs,
      sampleCount,
      quality,
      lumaSwing,
    );
  }
  if (periodicity < FACE_MIN_PERIODICITY || refinedLag === undefined) {
    return reject("noPeriodicity", durationMs, sampleCount, quality, lumaSwing);
  }
  if (stability < FACE_MIN_STABILITY) {
    return reject("unstable", durationMs, sampleCount, quality, lumaSwing);
  }

  const bpm = roundToTenth(ratePerMinuteFromLag(refinedLag));
  if (bpm < FACE_MIN_BPM || bpm > FACE_MAX_BPM) {
    return reject("outOfRange", durationMs, sampleCount, quality, lumaSwing);
  }

  const confidence = confidenceOf(
    periodicity,
    stability,
    durationMs,
    FACE_CONFIDENCE_FULL_DURATION_MS,
  );

  return {
    status: "measured",
    bpm,
    durationMs,
    sampleCount,
    effectiveSampleRateHz: effectiveSampleRateHz(sampleCount, durationMs),
    quality,
    lumaSwing,
    confidence,
    confidenceBand: confidenceBandOf(confidence),
    source: "face_camera_rppg",
    kind: "app_estimated",
    experimental: true,
    measuredAtMs,
  };
}

function trimToWindow(samples: readonly FaceRppgSample[]): FaceRppgSample[] {
  if (samples.length < 2) return [...samples];
  const last = samples[samples.length - 1] as FaceRppgSample;
  const cutoff = last.timestampMs - FACE_MAX_DURATION_MS;
  return samples.filter((sample) => sample.timestampMs >= cutoff);
}

/**
 * A frame is usable when the face is present, lit within the sensor's usable
 * range, and has not jumped since the previous usable frame.
 */
function coverageOf(samples: readonly FaceRppgSample[]): number {
  if (samples.length === 0) return 0;
  let usable = 0;
  let previous: FaceRppgSample | undefined;
  for (const sample of samples) {
    const lit = sample.luma >= FACE_MIN_LUMA && sample.luma <= FACE_MAX_LUMA;
    const present = sample.faceArea >= FACE_MIN_AREA;
    const still =
      previous === undefined ||
      (Math.abs(sample.faceCenterX - previous.faceCenterX) <
        FACE_MAX_CENTER_SHIFT &&
        Math.abs(sample.faceCenterY - previous.faceCenterY) <
          FACE_MAX_CENTER_SHIFT);
    if (lit && present && still) {
      usable += 1;
      previous = sample;
    }
  }
  return usable / samples.length;
}

function lumaSwingOf(samples: readonly FaceRppgSample[]): number {
  let lowest = Number.POSITIVE_INFINITY;
  let highest = Number.NEGATIVE_INFINITY;
  let total = 0;
  for (const sample of samples) {
    if (sample.luma < lowest) lowest = sample.luma;
    if (sample.luma > highest) highest = sample.luma;
    total += sample.luma;
  }
  const mean = total / samples.length;
  return (highest - lowest) / Math.max(mean, 1);
}

function reject(
  reason: Extract<FaceRppgResult, { status: "rejected" }>["reason"],
  durationMs: number,
  sampleCount: number,
  quality: SignalQuality,
  lumaSwing: number,
): FaceRppgResult {
  return {
    status: "rejected",
    reason,
    durationMs,
    sampleCount,
    quality,
    lumaSwing,
  };
}
