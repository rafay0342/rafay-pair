/**
 * The shared periodic-signal core — reference implementation of
 * `engines/signal-quality/SPEC.md`.
 *
 * Both physiological estimators recover a rate from a noisy, irregularly sampled
 * signal. Keeping that machinery here means each platform implements the hard
 * part once, and the honesty rules live in one place.
 *
 * Summation order is part of the contract: every loop accumulates in increasing
 * index order so that the Swift and Kotlin ports reproduce the same rounding.
 */

import {
  CONFIDENCE_HIGH,
  CONFIDENCE_MODERATE,
  QUALITY_FAIR_SCORE,
  QUALITY_GOOD_SCORE,
  RESAMPLE_HZ,
  RESAMPLE_STEP_MS,
  SUBHARMONIC_MARGIN,
  SUBHARMONIC_RATIO,
} from "./constants.js";
import type { ConfidenceBand, QualityBand } from "./types.js";

export interface TimedSample {
  readonly timestampMs: number;
  readonly value: number;
}

export function clamp(value: number, low: number, high: number): number {
  if (value < low) return low;
  if (value > high) return high;
  return value;
}

/** Rounds to one decimal, half away from zero. Values here are never negative. */
export function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Drops samples whose timestamp does not advance, as the specification requires. */
export function monotonic<T extends { readonly timestampMs: number }>(
  samples: readonly T[],
): T[] {
  const ordered: T[] = [];
  for (const sample of samples) {
    const previous = ordered.at(-1);
    if (previous && sample.timestampMs <= previous.timestampMs) continue;
    ordered.push(sample);
  }
  return ordered;
}

/**
 * Linear resampling onto a uniform 30 Hz grid starting at the first timestamp.
 *
 * Camera delivery is irregular and every later stage assumes a fixed step, so
 * the irregularity is resolved once, here, rather than smeared through the
 * filters.
 */
export function resample(samples: readonly TimedSample[]): number[] {
  if (samples.length < 2) return samples.map((sample) => sample.value);

  const first = samples[0] as TimedSample;
  const last = samples[samples.length - 1] as TimedSample;
  const spanMs = last.timestampMs - first.timestampMs;
  const count = Math.floor(spanMs / RESAMPLE_STEP_MS) + 1;

  const values: number[] = [];
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    const target = first.timestampMs + index * RESAMPLE_STEP_MS;
    while (
      cursor < samples.length - 2 &&
      (samples[cursor + 1] as TimedSample).timestampMs < target
    ) {
      cursor += 1;
    }
    const left = samples[cursor] as TimedSample;
    const right = samples[cursor + 1] as TimedSample;
    const width = right.timestampMs - left.timestampMs;
    const ratio = width <= 0 ? 0 : (target - left.timestampMs) / width;
    values.push(left.value + (right.value - left.value) * clamp(ratio, 0, 1));
  }
  return values;
}

/**
 * Centred moving average with edge truncation: at the edges only the samples
 * that exist are averaged. No padding and no reflection, so the operation is
 * fully specified without a boundary convention implementations could differ on.
 */
export function movingAverage(
  values: readonly number[],
  window: number,
): number[] {
  if (window <= 1) return [...values];
  const half = Math.floor(window / 2);
  const averaged: number[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const start = Math.max(0, index - half);
    const end = Math.min(values.length - 1, index + half);
    let total = 0;
    for (let cursor = start; cursor <= end; cursor += 1) {
      total += values[cursor] as number;
    }
    averaged.push(total / (end - start + 1));
  }
  return averaged;
}

/**
 * Which way the signal's harmonics fold, and therefore how an ambiguous
 * correlation peak is resolved. See the constants for the physics.
 */
export type HarmonicFold = "signalPerCycle" | "energyPerHalfCycle";

export interface Periodicity {
  /** Maximum normalized autocorrelation over the band, floored at zero. */
  readonly periodicity: number;
  /** Sub-sample refined lag, or `undefined` when the band does not fit. */
  readonly refinedLag: number | undefined;
}

/**
 * Normalized autocorrelation over a lag band, with parabolic peak refinement.
 *
 * Autocorrelation is used rather than an FFT because it needs no complex
 * arithmetic and no transform library, so three languages can implement it
 * identically — and because its peak height is itself the evidence needed to
 * decide whether to report a rate at all.
 */
export function periodicityOf(
  filtered: readonly number[],
  minLag: number,
  maxLag: number,
  fold: HarmonicFold = "signalPerCycle",
): Periodicity {
  if (filtered.length <= minLag + 1 || minLag < 1 || maxLag < minLag) {
    return { periodicity: 0, refinedLag: undefined };
  }
  const highestLag = Math.min(maxLag, filtered.length - 2);
  if (highestLag < minLag) return { periodicity: 0, refinedLag: undefined };

  const correlations: number[] = [];
  for (let lag = minLag; lag <= highestLag; lag += 1) {
    correlations.push(correlationAt(filtered, lag));
  }

  let bestIndex = 0;
  for (let index = 1; index < correlations.length; index += 1) {
    if ((correlations[index] as number) > (correlations[bestIndex] as number)) {
      bestIndex = index;
    }
  }

  // Autocorrelation peaks just as strongly at whole multiples of the true
  // period, so an unguarded maximum reports half or a third of the real rate —
  // the classic octave error, and far worse than reporting nothing.
  //
  // Which way to resolve the ambiguity depends on the signal's physics, so the
  // caller declares it. A heartbeat produces one cycle per event and a shorter
  // lag that correlates comparably is the fundamental; breath sound produces two
  // energy bursts per cycle, so its half-lag always correlates well and may only
  // win by explaining the signal at least as well as the peak.
  const peakIndex = bestIndex;
  const peak = correlations[peakIndex] as number;
  for (const divisor of [3, 2]) {
    const candidateLag = Math.round((minLag + peakIndex) / divisor);
    const candidateIndex = candidateLag - minLag;
    if (candidateIndex < 0 || candidateIndex >= correlations.length) continue;
    const candidate = correlations[candidateIndex] as number;
    const wins =
      fold === "signalPerCycle"
        ? candidate >= SUBHARMONIC_RATIO * peak
        : candidate >= peak - SUBHARMONIC_MARGIN;
    if (wins) {
      bestIndex = candidateIndex;
      break;
    }
  }

  const best = correlations[bestIndex] as number;
  const bestLag = minLag + bestIndex;

  let offset = 0;
  if (bestIndex > 0 && bestIndex < correlations.length - 1) {
    const before = correlations[bestIndex - 1] as number;
    const after = correlations[bestIndex + 1] as number;
    const denominator = before - 2 * best + after;
    // Without the clamp a nearly flat correlation curve produces an enormous
    // offset and a fabricated rate.
    offset =
      Math.abs(denominator) < 1e-12
        ? 0
        : clamp((0.5 * (before - after)) / denominator, -0.5, 0.5);
  }

  return {
    periodicity: Math.max(0, best),
    refinedLag: bestLag + offset,
  };
}

function correlationAt(values: readonly number[], lag: number): number {
  let cross = 0;
  let energyA = 0;
  let energyB = 0;
  for (let index = 0; index + lag < values.length; index += 1) {
    const a = values[index] as number;
    const b = values[index + lag] as number;
    cross += a * b;
    energyA += a * a;
    energyB += b * b;
  }
  const denominator = Math.sqrt(energyA * energyB);
  return denominator < 1e-12 ? 0 : cross / denominator;
}

export function ratePerMinuteFromLag(lag: number): number {
  return (60 * RESAMPLE_HZ) / lag;
}

/** Mean absolute first difference of the resampled signal, scaled and clamped. */
export function motionOf(resampled: readonly number[], scale: number): number {
  if (resampled.length < 2) return 1;
  let total = 0;
  for (let index = 1; index < resampled.length; index += 1) {
    total += Math.abs(
      (resampled[index] as number) - (resampled[index - 1] as number),
    );
  }
  return Math.min(1, total / (resampled.length - 1) / scale);
}

/** Nearest-rank percentile, which needs no interpolation convention. */
export function percentile(
  values: readonly number[],
  fraction: number,
): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.floor(fraction * (sorted.length - 1));
  return sorted[index] as number;
}

export function amplitudeOf(
  filtered: readonly number[],
  resampled: readonly number[],
): number {
  if (filtered.length === 0) return 0;
  let total = 0;
  for (const value of resampled) total += value;
  const mean = resampled.length === 0 ? 0 : total / resampled.length;
  const span = percentile(filtered, 0.95) - percentile(filtered, 0.05);
  return span / Math.max(Math.abs(mean), 1e-6);
}

export interface StabilityOptions {
  readonly windowSamples: number;
  readonly stepSamples: number;
  readonly scale: number;
  readonly minLag: number;
  readonly maxLag: number;
  readonly fold?: HarmonicFold;
}

/**
 * Spread of per-window rates, mapped to `0…1`.
 *
 * A rate that jumps between windows is not a rate. When the signal is too short
 * to fit two windows the result is zero: a session that cannot demonstrate
 * stability does not get to claim it.
 */
export function stabilityOf(
  filtered: readonly number[],
  options: StabilityOptions,
): number {
  const rates: number[] = [];
  for (
    let start = 0;
    start + options.windowSamples <= filtered.length;
    start += options.stepSamples
  ) {
    const window = filtered.slice(start, start + options.windowSamples);
    const result = periodicityOf(
      window,
      options.minLag,
      options.maxLag,
      options.fold ?? "signalPerCycle",
    );
    if (result.refinedLag !== undefined) {
      rates.push(ratePerMinuteFromLag(result.refinedLag));
    }
  }
  if (rates.length < 2) return 0;

  let lowest = rates[0] as number;
  let highest = rates[0] as number;
  for (const rate of rates) {
    if (rate < lowest) lowest = rate;
    if (rate > highest) highest = rate;
  }
  return 1 - Math.min(1, (highest - lowest) / options.scale);
}

export function qualityBandOf(score: number): QualityBand {
  if (score >= QUALITY_GOOD_SCORE) return "good";
  if (score >= QUALITY_FAIR_SCORE) return "fair";
  return "poor";
}

export function confidenceOf(
  periodicity: number,
  stability: number,
  durationMs: number,
  fullDurationMs: number,
): number {
  const durationFactor = clamp(durationMs / fullDurationMs, 0, 1);
  return clamp(
    0.5 * periodicity + 0.3 * stability + 0.2 * durationFactor,
    0,
    1,
  );
}

export function confidenceBandOf(confidence: number): ConfidenceBand {
  if (confidence >= CONFIDENCE_HIGH) return "high";
  if (confidence >= CONFIDENCE_MODERATE) return "moderate";
  return "low";
}

export function effectiveSampleRateHz(
  sampleCount: number,
  durationMs: number,
): number {
  if (sampleCount < 2 || durationMs <= 0) return 0;
  return ((sampleCount - 1) * 1000) / durationMs;
}
