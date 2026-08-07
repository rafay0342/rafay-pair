import type { BreathingPhase } from "./types.js";

/**
 * Veins Alive.
 *
 * Master specification §8: a visual experience, with no claim of scanning
 * veins. Nothing here measures, infers, or predicts anything. It turns values
 * the product already holds into the handful of numbers a renderer needs, and
 * the reason it is a module rather than a drawing detail is that one of those
 * numbers must be allowed to be absent.
 *
 * The absent one is the pulse. When there is no fresh estimate the animation
 * rests — it does not fall back to a plausible rate, and it does not keep
 * animating at the last one it saw. A vascular network pulsing at an invented
 * 72 would be a fabricated measurement wearing an animation's clothes, which is
 * exactly what §5 and §4 exist to prevent.
 */

/** Shown whenever the view is on screen. Never abbreviated by a caller. */
export const VEINS_DISCLOSURE =
  "Sensor-driven visualization — not a medical scan.";

export type VeinsMode = "calm" | "workout" | "recovery";

export type MuscleGroup =
  | "chest"
  | "core"
  | "quadriceps"
  | "hamstrings"
  | "glutes"
  | "calves"
  | "shoulders";

export interface VeinsInput {
  readonly mode: VeinsMode;
  /**
   * Beats per minute, and only when the estimate is still fresh. A caller that
   * passes a stale reading has already broken the rule this module exists for,
   * so freshness is decided by `isPulseFresh` before it reaches here.
   */
  readonly pulseBpm: number | null;
  /** The phase of a running guided-breathing session, or `null` when none is. */
  readonly breathingPhase: BreathingPhase | null;
  /** Progress through that phase, `0...1`. */
  readonly breathingProgress: number;
  /** Repetitions per minute in the current set, or `null` outside a workout. */
  readonly repetitionsPerMinute: number | null;
  /** Muscles the current exercise works, from the exercise definition. */
  readonly activeMuscles: readonly MuscleGroup[];
}

export interface VeinsDrivers {
  /**
   * Milliseconds per contraction, or `null` to rest.
   *
   * `null` is the honest state, not a failure: it means nothing current is
   * known, and the renderer must show stillness rather than motion.
   */
  readonly contractionPeriodMs: number | null;
  /** How the rate reached the screen. There is no `measured` variant. */
  readonly pulseProvenance: "estimated" | "none";
  /** Chest glow, `0...1`, following the breath. Zero outside a session. */
  readonly chestGlow: number;
  /** Overall energy of the animation, `0...1`. */
  readonly intensity: number;
  readonly activeMuscles: readonly MuscleGroup[];
  readonly disclosure: typeof VEINS_DISCLOSURE;
}

/** Baseline energy per mode, before any workout contribution. */
const MODE_BASELINE: Readonly<Record<VeinsMode, number>> = {
  calm: 0.15,
  workout: 0.45,
  recovery: 0.25,
};

/** Repetitions per minute treated as full effort. Above this, intensity saturates. */
const REPETITIONS_AT_FULL_INTENSITY = 30;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Chest glow across one breath.
 *
 * Rises through the inhale, holds at full, falls through the exhale, and rests
 * after. A session that is not running glows not at all — the chest does not
 * "breathe" on screen while the user is doing something else.
 */
function glowFor(phase: BreathingPhase | null, progress: number): number {
  const eased = clamp01(progress);
  switch (phase) {
    case "inhale":
      return eased;
    case "hold":
      return 1;
    case "exhale":
      return 1 - eased;
    case "holdAfter":
    case "complete":
    case null:
    default:
      return 0;
  }
}

export function veinsDrivers(input: VeinsInput): VeinsDrivers {
  // A rate outside what the pulse estimator itself will report is refused
  // rather than clamped: clamping would turn a wrong number into a plausible
  // one, which is the failure this whole module is shaped to avoid.
  const usable =
    input.pulseBpm !== null &&
    Number.isFinite(input.pulseBpm) &&
    input.pulseBpm >= 42 &&
    input.pulseBpm <= 210;

  const effort =
    input.repetitionsPerMinute === null
      ? 0
      : clamp01(input.repetitionsPerMinute / REPETITIONS_AT_FULL_INTENSITY);

  return {
    contractionPeriodMs: usable ? 60_000 / (input.pulseBpm as number) : null,
    pulseProvenance: usable ? "estimated" : "none",
    chestGlow: glowFor(input.breathingPhase, input.breathingProgress),
    intensity: clamp01(MODE_BASELINE[input.mode] + effort * 0.55),
    // Deduplicated and ordered by the caller's list rather than re-sorted, so a
    // renderer can rely on the exercise's own emphasis.
    activeMuscles: [...new Set(input.activeMuscles)],
    disclosure: VEINS_DISCLOSURE,
  };
}
