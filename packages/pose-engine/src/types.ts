/**
 * Canonical types for the pose and exercise engines.
 *
 * Normative definitions live in `engines/pose-spec/SPEC.md` and
 * `engines/exercise-state-machines/SPEC.md`. This module is the TypeScript
 * reference implementation of those documents and the engine the Web client
 * runs; iOS and Android implement the same specifications independently.
 */

/**
 * The thirteen joints common to Apple Vision, ML Kit Pose Detection, and
 * BlazePose. The order is normative: golden vectors encode joints as a flat
 * triple-packed array in exactly this sequence.
 */
export const CANONICAL_JOINTS = [
  "nose",
  "leftShoulder",
  "rightShoulder",
  "leftElbow",
  "rightElbow",
  "leftWrist",
  "rightWrist",
  "leftHip",
  "rightHip",
  "leftKnee",
  "rightKnee",
  "leftAnkle",
  "rightAnkle",
] as const;

export type JointName = (typeof CANONICAL_JOINTS)[number];

/** Core joints must all be usable for a frame to be valid. */
export const CORE_JOINTS: readonly JointName[] = [
  "leftShoulder",
  "rightShoulder",
  "leftHip",
  "rightHip",
  "leftKnee",
  "rightKnee",
  "leftAnkle",
  "rightAnkle",
];

export interface Joint {
  /** Image-normalized horizontal position; origin top-left, grows right. */
  readonly x: number;
  /** Image-normalized vertical position; origin top-left, grows down. */
  readonly y: number;
  /** Detector confidence in `0…1`. */
  readonly visibility: number;
}

export interface PoseFrame {
  /** Monotonic milliseconds. */
  readonly timestampMs: number;
  readonly joints: Readonly<Record<JointName, Joint>>;
}

export type Posture =
  "unknown" | "lying" | "standing" | "crouched" | "transitional";

export interface PoseObservation {
  readonly timestampMs: number;
  readonly valid: boolean;
  readonly posture: Posture;
  readonly torsoAngleDeg: number;
  readonly meanKneeAngle: number;
  readonly meanHipAngle: number;
  readonly leftKneeAngle: number;
  readonly rightKneeAngle: number;
  readonly hipElevation: number;
  readonly minVisibility: number;
  readonly framingOk: boolean;
}

/** Posture as presented to the product, after temporal disambiguation. */
export type ReportedPosture =
  "unknown" | "standing" | "sitting" | "lyingDown" | "squatting";

export type FormEvent = "shallowDepth" | "forwardLean" | "uneven";

export interface Repetition {
  readonly index: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly durationMs: number;
  readonly minElevation: number;
  readonly depth: number;
  readonly formEvents: readonly FormEvent[];
}

export type SquatPhase = "idle" | "descending" | "bottom";

export interface ExerciseObservation {
  readonly timestampMs: number;
  readonly reportedPosture: ReportedPosture;
  readonly squatPhase: SquatPhase;
  readonly repetitionCount: number;
  /** Present only on the frame that completes a repetition. */
  readonly completedRepetition: Repetition | undefined;
}

export interface SessionSummary {
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly repetitions: readonly Repetition[];
  readonly repetitionCount: number;
  readonly bestDepth: number;
  readonly averageDurationMs: number;
  readonly postureTimelineMs: Readonly<Record<ReportedPosture, number>>;
  readonly formEventCounts: Readonly<Record<FormEvent, number>>;
}
