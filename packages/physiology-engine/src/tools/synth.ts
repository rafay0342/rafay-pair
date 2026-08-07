/**
 * Signal synthesisers used only to author golden vectors.
 *
 * Real capture is not reproducible, so the cross-platform parity contract is
 * built from synthetic signals whose ground truth we control exactly. The
 * waveforms are modelled on what the sensors actually deliver — a
 * red-dominant, weakly pulsatile fingertip signal riding on a large DC level,
 * and a slow chest oscillation riding on posture drift.
 */

import type { BreathingSample, PulseSample } from "../types.js";

/**
 * A small linear congruential generator so the vectors are reproducible.
 * It lives only in the authoring tool; the committed JSON is the contract, so
 * no port needs this.
 */
export class Rng {
  private state: number;

  public constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in `[0, 1)`. */
  public next(): number {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state / 4294967296;
  }

  /** Approximately standard normal, via the mean of twelve uniforms. */
  public normal(): number {
    let total = 0;
    for (let index = 0; index < 12; index += 1) total += this.next();
    return total - 6;
  }
}

export interface PulseSynthOptions {
  readonly bpm: number;
  readonly durationMs: number;
  /** Nominal frame rate; real capture jitters around it. */
  readonly frameRateHz?: number;
  readonly dcRed?: number;
  readonly dcGreen?: number;
  /** Pulsatile amplitude on the red channel, in 0…255 units. */
  readonly acAmplitude?: number;
  readonly noise?: number;
  /** Slow baseline wander amplitude. */
  readonly drift?: number;
  /** Large step excursions modelling the finger sliding. */
  readonly motionBursts?: number;
  /** When set, the finger is absent for this fraction of the tail. */
  readonly uncoveredTailFraction?: number;
  readonly seed?: number;
}

export function synthesisePulse(options: PulseSynthOptions): PulseSample[] {
  const {
    bpm,
    durationMs,
    frameRateHz = 30,
    dcRed = 200,
    dcGreen = 70,
    acAmplitude = 3.2,
    noise = 0.35,
    drift = 4,
    motionBursts = 0,
    uncoveredTailFraction = 0,
    seed = 20260807,
  } = options;

  const rng = new Rng(seed);
  const stepMs = 1000 / frameRateHz;
  const samples: PulseSample[] = [];
  const uncoveredFrom = durationMs * (1 - uncoveredTailFraction);

  let timestampMs = 0;
  let index = 0;
  while (timestampMs <= durationMs) {
    const seconds = timestampMs / 1000;
    const phase = 2 * Math.PI * (bpm / 60) * seconds;

    // Fundamental plus a second harmonic, which is what gives a real PPG trace
    // its dicrotic shoulder.
    const pulsatile =
      acAmplitude * (Math.sin(phase) + 0.35 * Math.sin(2 * phase + 0.8));
    const wander = drift * Math.sin(2 * Math.PI * 0.05 * seconds + 0.4);

    let burst = 0;
    if (motionBursts > 0) {
      // Periodic slides rather than white noise: a moving finger changes the DC
      // level in steps, which is exactly what the motion metric should catch.
      burst = motionBursts * Math.sin(2 * Math.PI * 0.9 * seconds) ** 3;
    }

    const uncovered = timestampMs >= uncoveredFrom && uncoveredTailFraction > 0;
    const red = uncovered
      ? 118 + rng.normal() * 2
      : dcRed + pulsatile + wander + burst + rng.normal() * noise;
    const green = uncovered
      ? 110 + rng.normal() * 2
      : dcGreen + 0.2 * pulsatile + rng.normal() * noise;

    samples.push({
      timestampMs: round3(timestampMs),
      red: round3(clamp255(red)),
      green: round3(clamp255(green)),
    });

    // Frame delivery jitters; the engine resamples precisely because of this.
    timestampMs += stepMs * (0.85 + 0.3 * rng.next());
    index += 1;
    if (index > 10_000) break;
  }
  return samples;
}

export interface BreathingSynthOptions {
  readonly breathsPerMinute: number;
  readonly durationMs: number;
  readonly frameRateHz?: number;
  readonly amplitude?: number;
  readonly baseline?: number;
  readonly noise?: number;
  readonly drift?: number;
  /** Fraction of frames the pose engine failed to track. */
  readonly untrackedFraction?: number;
  readonly motionBursts?: number;
  readonly seed?: number;
}

export function synthesiseBreathing(
  options: BreathingSynthOptions,
): BreathingSample[] {
  const {
    breathsPerMinute,
    durationMs,
    frameRateHz = 30,
    amplitude = 0.035,
    baseline = 1,
    noise = 0.004,
    drift = 0.05,
    untrackedFraction = 0,
    motionBursts = 0,
    seed = 20260808,
  } = options;

  const rng = new Rng(seed);
  const stepMs = 1000 / frameRateHz;
  const samples: BreathingSample[] = [];

  let timestampMs = 0;
  let index = 0;
  while (timestampMs <= durationMs) {
    const seconds = timestampMs / 1000;
    const phase = 2 * Math.PI * (breathsPerMinute / 60) * seconds;
    const wander = drift * Math.sin(2 * Math.PI * 0.012 * seconds);
    const burst =
      motionBursts > 0
        ? motionBursts * Math.sin(2 * Math.PI * 1.4 * seconds) ** 3
        : 0;

    samples.push({
      timestampMs: round3(timestampMs),
      chestOffset: round6(
        baseline +
          amplitude * Math.sin(phase) +
          wander +
          burst +
          rng.normal() * noise,
      ),
      tracked: rng.next() >= untrackedFraction,
    });

    timestampMs += stepMs * (0.9 + 0.2 * rng.next());
    index += 1;
    if (index > 20_000) break;
  }
  return samples;
}

function clamp255(value: number): number {
  return Math.min(255, Math.max(0, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
