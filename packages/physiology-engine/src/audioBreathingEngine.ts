/**
 * Microphone breathing rhythm — reference implementation of
 * `engines/breathing-estimation-spec/MICROPHONE.md` (master specification §6C).
 *
 * Raw audio never reaches this module. Its input type carries only per-hop
 * features — a band energy, a zero-crossing rate, and a peak level — from which
 * speech is not reconstructible. That is the retention rule made structural
 * rather than promised.
 */

import {
  AUDIO_HIGH_PASS_HZ,
  AUDIO_HOP_SAMPLES,
  AUDIO_LOW_PASS_HZ,
  AUDIO_PEAK_CLIP,
  AUDIO_RMS_FLOOR,
  AUDIO_SAMPLE_RATE_HZ,
  AUDIO_ZCR_MAX,
  AUDIO_ZCR_MIN,
  BREATHING_DETREND_WINDOW_SAMPLES,
  BREATHING_MAX_PER_MINUTE,
  BREATHING_MIN_PER_MINUTE,
  BREATHING_SMOOTH_WINDOW_SAMPLES,
  BREATHING_STABILITY_SCALE,
  BREATHING_STABILITY_STEP_SAMPLES,
  BREATHING_STABILITY_WINDOW_SAMPLES,
  MIC_CONFIDENCE_FULL_DURATION_MS,
  MIC_MAX_MOTION,
  MIC_MIN_COVERAGE,
  MIC_MIN_DURATION_MS,
  MIC_MIN_PERIODICITY,
  MIC_MIN_STABILITY,
  MIC_MOTION_SCALE,
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
  AudioBreathingResult,
  AudioHopFeature,
  SignalQuality,
} from "./types.js";

const MIN_LAG = Math.round((60 * RESAMPLE_HZ) / BREATHING_MAX_PER_MINUTE);
const MAX_LAG = Math.round((60 * RESAMPLE_HZ) / BREATHING_MIN_PER_MINUTE);

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
 * Converts a block of microphone samples into per-hop features.
 *
 * This is the only function that ever sees audio, and it returns numbers rather
 * than a signal. The band-pass is a cascade of two one-pole filters, chosen
 * because a one-pole recurrence is exactly reproducible in three languages with
 * no filter-design library and no coefficient tables.
 *
 * @param samples floating point in `[-1, 1]`
 * @param startTimestampMs timestamp of `samples[0]`
 */
export function extractAudioHops(
  samples: readonly number[],
  startTimestampMs: number,
): AudioHopFeature[] {
  const highPassAlpha =
    1 / (1 + (2 * Math.PI * AUDIO_HIGH_PASS_HZ) / AUDIO_SAMPLE_RATE_HZ);
  const lowPassOmega = (2 * Math.PI * AUDIO_LOW_PASS_HZ) / AUDIO_SAMPLE_RATE_HZ;
  const lowPassAlpha = lowPassOmega / (1 + lowPassOmega);

  const hops: AudioHopFeature[] = [];
  let previousRaw = 0;
  let previousHighPassed = 0;
  let banded = 0;

  // A trailing partial hop is discarded rather than padded: padding would invent
  // a quieter hop and drag the envelope down exactly when a session ends.
  const hopCount = Math.floor(samples.length / AUDIO_HOP_SAMPLES);
  let cursor = 0;

  for (let hop = 0; hop < hopCount; hop += 1) {
    let energy = 0;
    let crossings = 0;
    let peak = 0;
    let previousBanded = banded;

    for (let index = 0; index < AUDIO_HOP_SAMPLES; index += 1) {
      const raw = samples[cursor] as number;
      cursor += 1;

      const highPassed =
        highPassAlpha * (previousHighPassed + raw - previousRaw);
      banded = banded + lowPassAlpha * (highPassed - banded);
      previousRaw = raw;
      previousHighPassed = highPassed;

      energy += banded * banded;
      const magnitude = Math.abs(raw);
      if (magnitude > peak) peak = magnitude;
      if (index > 0 && signOf(previousBanded) * signOf(banded) < 0) {
        crossings += 1;
      }
      previousBanded = banded;
    }

    hops.push({
      timestampMs:
        startTimestampMs +
        (hop * AUDIO_HOP_SAMPLES * 1000) / AUDIO_SAMPLE_RATE_HZ,
      rms: Math.sqrt(energy / AUDIO_HOP_SAMPLES),
      zeroCrossingRate: crossings / (AUDIO_HOP_SAMPLES - 1),
      peak,
    });
  }
  return hops;
}

function signOf(value: number): number {
  if (value > 0) return 1;
  if (value < 0) return -1;
  return 0;
}

/**
 * A hop is usable when it is audible, unclipped, and its zero-crossing rate
 * looks like broadband turbulence rather than voiced speech (too periodic) or
 * hiss (too dense).
 */
export function isHopUsable(hop: AudioHopFeature): boolean {
  return (
    hop.rms >= AUDIO_RMS_FLOOR &&
    hop.peak < AUDIO_PEAK_CLIP &&
    hop.zeroCrossingRate >= AUDIO_ZCR_MIN &&
    hop.zeroCrossingRate <= AUDIO_ZCR_MAX
  );
}

export function estimateAudioBreathing(
  hops: readonly AudioHopFeature[],
  measuredAtMs: number,
): AudioBreathingResult {
  const ordered = monotonic(hops);
  const hopCount = ordered.length;
  const durationMs =
    hopCount < 2
      ? 0
      : (ordered[hopCount - 1] as AudioHopFeature).timestampMs -
        (ordered[0] as AudioHopFeature).timestampMs;

  if (hopCount < 2 || durationMs < MIC_MIN_DURATION_MS) {
    return {
      status: "rejected",
      reason: "tooShort",
      durationMs,
      hopCount,
      quality: EMPTY_QUALITY,
    };
  }

  let usable = 0;
  for (const hop of ordered) if (isHopUsable(hop)) usable += 1;
  const coverage = usable / hopCount;

  // Unusable hops still contribute their energy: removing them would punch holes
  // in the envelope that the autocorrelation would then read as rhythm.
  const resampled = resample(
    ordered.map((hop) => ({ timestampMs: hop.timestampMs, value: hop.rms })),
  );
  const baseline = movingAverage(resampled, BREATHING_DETREND_WINDOW_SAMPLES);
  const detrended = resampled.map(
    (value, index) => value - (baseline[index] as number),
  );
  const filtered = movingAverage(detrended, BREATHING_SMOOTH_WINDOW_SAMPLES);

  const { periodicity, refinedLag } = periodicityOf(
    filtered,
    MIN_LAG,
    MAX_LAG,
    "energyPerHalfCycle",
  );
  const motion = motionOf(resampled, MIC_MOTION_SCALE);
  const stability = stabilityOf(filtered, {
    windowSamples: BREATHING_STABILITY_WINDOW_SAMPLES,
    stepSamples: BREATHING_STABILITY_STEP_SAMPLES,
    scale: BREATHING_STABILITY_SCALE,
    minLag: MIN_LAG,
    maxLag: MAX_LAG,
    fold: "energyPerHalfCycle",
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

  if (coverage < MIC_MIN_COVERAGE) {
    return reject("notAudible", durationMs, hopCount, quality);
  }
  if (motion > MIC_MAX_MOTION) {
    return reject("tooNoisy", durationMs, hopCount, quality);
  }
  if (periodicity < MIC_MIN_PERIODICITY || refinedLag === undefined) {
    return reject("noPeriodicity", durationMs, hopCount, quality);
  }
  if (stability < MIC_MIN_STABILITY) {
    return reject("unstable", durationMs, hopCount, quality);
  }

  const breathsPerMinute = roundToTenth(ratePerMinuteFromLag(refinedLag));
  if (
    breathsPerMinute < BREATHING_MIN_PER_MINUTE ||
    breathsPerMinute > BREATHING_MAX_PER_MINUTE
  ) {
    return reject("outOfRange", durationMs, hopCount, quality);
  }

  const confidence = confidenceOf(
    periodicity,
    stability,
    durationMs,
    MIC_CONFIDENCE_FULL_DURATION_MS,
  );

  return {
    status: "measured",
    breathsPerMinute,
    durationMs,
    hopCount,
    effectiveSampleRateHz: effectiveSampleRateHz(hopCount, durationMs),
    quality,
    confidence,
    confidenceBand: confidenceBandOf(confidence),
    source: "phone_microphone",
    kind: "app_estimated",
    measuredAtMs,
  };
}

function reject(
  reason: Extract<AudioBreathingResult, { status: "rejected" }>["reason"],
  durationMs: number,
  hopCount: number,
  quality: SignalQuality,
): AudioBreathingResult {
  return { status: "rejected", reason, durationMs, hopCount, quality };
}
