/**
 * Speaker profile — reference implementation of
 * `engines/speaker-profile/SPEC.md`.
 *
 * It tells the enrolled person's voice apart from a clearly different one, so a
 * partner or a stranger speaking into the same phone does not take a turn.
 *
 * It is **not** authentication. A similar voice passes it, a recording of the
 * enrolled voice passes it, and a cold may fail it. Nothing may use it as a
 * security control and no interface may describe it as recognising who someone
 * is. That warning is here as well as in the specification because this is the
 * file someone will read instead.
 */

export const SPEAKER_SAMPLE_RATE_HZ = 16_000;
export const VOICED_MIN_RMS = 0.012;
export const F0_MIN_HZ = 70;
export const F0_MAX_HZ = 350;
export const MIN_PEAK_CORRELATION = 0.3;
export const MIN_ENROLMENT_FRAMES = 150;
export const F0_SPREAD_FLOOR = 8;
export const TILT_SCALE = 1.2;
export const ZCR_SCALE = 0.08;
export const MATCH_THRESHOLD = 2.6;
export const DECISION_WINDOW = 25;
export const MIN_DECIDING_FRAMES = 8;
export const REJECT_RATIO = 0.65;

const WEIGHT_F0 = 2;
const WEIGHT_TILT_MID_LOW = 1;
const WEIGHT_TILT_HIGH_MID = 1;
const WEIGHT_ZCR = 0.5;

export interface SpeakerFrame {
  readonly rms: number;
  readonly f0Hz: number;
  readonly tiltMidLow: number;
  readonly tiltHighMid: number;
  readonly zcr: number;
}

export interface SpeakerProfile {
  readonly f0Hz: number;
  readonly f0Spread: number;
  readonly tiltMidLow: number;
  readonly tiltHighMid: number;
  readonly zcr: number;
  readonly frames: number;
}

export type SpeakerVerdict = "enrolled" | "other" | "unknown";

export interface SpeakerDecision {
  readonly verdict: SpeakerVerdict;
  readonly matchRatio: number;
  readonly frames: number;
}

/**
 * One-pole low pass, run forward over the frame.
 *
 * Chosen over any designed filter because a one-pole recurrence is exactly
 * reproducible in three languages with no coefficient tables.
 */
function lowPass(samples: readonly number[], cutoffHz: number): number[] {
  const dt = 1 / SPEAKER_SAMPLE_RATE_HZ;
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const alpha = dt / (rc + dt);
  const out: number[] = new Array<number>(samples.length);
  let previous = 0;
  for (let index = 0; index < samples.length; index += 1) {
    previous += alpha * ((samples[index] as number) - previous);
    out[index] = previous;
  }
  return out;
}

function energy(samples: readonly number[]): number {
  let total = 0;
  for (const value of samples) total += value * value;
  return total / Math.max(1, samples.length);
}

/**
 * Fundamental by autocorrelation, with the peak's own strength returned.
 *
 * The strength is what separates a pitch from noise that happens to have a
 * maximum somewhere. Without it every hiss would be given an `f0`.
 */
function fundamental(samples: readonly number[]): {
  f0Hz: number;
  peak: number;
} {
  const minLag = Math.floor(SPEAKER_SAMPLE_RATE_HZ / F0_MAX_HZ);
  const maxLag = Math.min(
    samples.length - 1,
    Math.ceil(SPEAKER_SAMPLE_RATE_HZ / F0_MIN_HZ),
  );
  if (maxLag <= minLag) return { f0Hz: 0, peak: 0 };

  let zeroLag = 0;
  for (const value of samples) zeroLag += value * value;
  if (zeroLag <= 0) return { f0Hz: 0, peak: 0 };

  let bestLag = 0;
  let bestValue = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    for (let index = 0; index + lag < samples.length; index += 1) {
      sum += (samples[index] as number) * (samples[index + lag] as number);
    }
    const normalised = sum / zeroLag;
    if (normalised > bestValue) {
      bestValue = normalised;
      bestLag = lag;
    }
  }
  if (bestLag === 0) return { f0Hz: 0, peak: 0 };
  return { f0Hz: SPEAKER_SAMPLE_RATE_HZ / bestLag, peak: bestValue };
}

/**
 * Features for one frame, or `null` when the frame is not voiced.
 *
 * Unvoiced frames are discarded rather than given neutral values: a neutral
 * value would drag every profile towards the same place and make two speakers
 * look alike, which is the one failure this must not have.
 *
 * @param samples floating point in `[-1, 1]`
 */
export function speakerFrameFeature(
  samples: readonly number[],
): SpeakerFrame | null {
  if (samples.length < 64) return null;

  const rms = Math.sqrt(energy(samples));
  if (rms < VOICED_MIN_RMS) return null;

  const { f0Hz, peak } = fundamental(samples);
  if (peak < MIN_PEAK_CORRELATION) return null;
  if (f0Hz < F0_MIN_HZ || f0Hz > F0_MAX_HZ) return null;

  const below500 = lowPass(samples, 500);
  const below2000 = lowPass(samples, 2000);
  const lowEnergy = energy(below500);
  const midEnergy = Math.max(0, energy(below2000) - lowEnergy);
  const highEnergy = Math.max(0, energy(samples) - energy(below2000));

  // A floor rather than a guard clause: silence in one band is a real
  // observation about a voice, and log2 of zero is not.
  const floor = 1e-9;
  const tiltMidLow = Math.log2((midEnergy + floor) / (lowEnergy + floor));
  const tiltHighMid = Math.log2((highEnergy + floor) / (midEnergy + floor));

  let crossings = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1] as number;
    const current = samples[index] as number;
    if ((previous >= 0 && current < 0) || (previous < 0 && current >= 0)) {
      crossings += 1;
    }
  }

  return {
    rms,
    f0Hz,
    tiltMidLow,
    tiltHighMid,
    zcr: crossings / samples.length,
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

/**
 * Builds a profile, or returns `null` when there is not enough voiced speech.
 *
 * Too little produces nothing rather than something weak. A weak profile does
 * not fail loudly; it quietly matches everyone, which is worse than having none.
 */
export function buildSpeakerProfile(
  frames: readonly SpeakerFrame[],
): SpeakerProfile | null {
  if (frames.length < MIN_ENROLMENT_FRAMES) return null;

  const f0Values = frames.map((frame) => frame.f0Hz);
  const centre = median(f0Values);
  // Median absolute deviation, not standard deviation: one shouted word or one
  // creaky syllable should not move a profile.
  const spread = Math.max(
    F0_SPREAD_FLOOR,
    median(f0Values.map((value) => Math.abs(value - centre))),
  );

  return {
    f0Hz: centre,
    f0Spread: spread,
    tiltMidLow: mean(frames.map((frame) => frame.tiltMidLow)),
    tiltHighMid: mean(frames.map((frame) => frame.tiltHighMid)),
    zcr: mean(frames.map((frame) => frame.zcr)),
    frames: frames.length,
  };
}

/** Distance in units of the enrolled speaker's own variation. */
export function speakerDistance(
  frame: SpeakerFrame,
  profile: SpeakerProfile,
): number {
  const d0 = Math.abs(frame.f0Hz - profile.f0Hz) / profile.f0Spread;
  const d1 = Math.abs(frame.tiltMidLow - profile.tiltMidLow) / TILT_SCALE;
  const d2 = Math.abs(frame.tiltHighMid - profile.tiltHighMid) / TILT_SCALE;
  const d3 = Math.abs(frame.zcr - profile.zcr) / ZCR_SCALE;
  return Math.sqrt(
    WEIGHT_F0 * d0 * d0 +
      WEIGHT_TILT_MID_LOW * d1 * d1 +
      WEIGHT_TILT_HIGH_MID * d2 * d2 +
      WEIGHT_ZCR * d3 * d3,
  );
}

/**
 * Answers on the balance of a short history, never on one frame.
 *
 * `unknown` is a real answer and callers must transmit on it. Refusing to send
 * audio while uncertain means the person is not heard, and a companion that
 * intermittently ignores its owner is worse than one that occasionally answers
 * someone else.
 */
export class SpeakerMatcher {
  readonly #profile: SpeakerProfile | null;
  readonly #history: boolean[] = [];

  public constructor(profile: SpeakerProfile | null) {
    this.#profile = profile;
  }

  /** Every frame is offered; only voiced ones reach a verdict. */
  public accept(frame: SpeakerFrame | null): SpeakerDecision {
    if (this.#profile !== null && frame !== null) {
      this.#history.push(
        speakerDistance(frame, this.#profile) <= MATCH_THRESHOLD,
      );
      if (this.#history.length > DECISION_WINDOW) this.#history.shift();
    }

    const frames = this.#history.length;
    if (this.#profile === null || frames < MIN_DECIDING_FRAMES) {
      return { verdict: "unknown", matchRatio: 1, frames };
    }

    const matches = this.#history.filter(Boolean).length;
    const matchRatio = matches / frames;
    return {
      verdict: 1 - matchRatio >= REJECT_RATIO ? "other" : "enrolled",
      matchRatio,
      frames,
    };
  }

  public reset(): void {
    this.#history.length = 0;
  }
}
