/**
 * Every tunable in the pose and exercise engines, in one place.
 *
 * These values are normative. `engines/pose-spec/SPEC.md` §7 and
 * `engines/exercise-state-machines/SPEC.md` §2 carry the same numbers, and the
 * Swift and Kotlin ports must keep them identical or the golden vectors fail.
 */

// Pose engine — engines/pose-spec/SPEC.md
export const MIN_VISIBILITY = 0.5;
export const MIN_TORSO_SCALE = 0.02;
export const SMOOTHING_ALPHA = 0.4;

export const LYING_TORSO_ANGLE_DEG = 60;
export const STANDING_HIP_ELEVATION = 1.3;
export const STANDING_KNEE_ANGLE = 150;
export const CROUCHED_HIP_ELEVATION = 1.15;
export const CROUCHED_KNEE_ANGLE = 135;

// Exercise state machine — engines/exercise-state-machines/SPEC.md
export const SIT_HOLD_MS = 2500;
export const SIT_STABILITY_BAND = 0.12;
export const LIE_HOLD_MS = 1200;
export const STAND_HOLD_MS = 400;

export const SQUAT_TOP_ELEVATION = 1.3;
export const SQUAT_BOTTOM_ELEVATION = 1.05;
export const SQUAT_MIN_CYCLE_MS = 500;
export const SQUAT_MAX_CYCLE_MS = 8000;

export const STALE_FRAME_MS = 1500;

// Form events
export const SHALLOW_DEPTH_MARGIN = 0.05;
export const FORWARD_LEAN_DEG = 45;
export const UNEVEN_KNEE_DEG = 25;
