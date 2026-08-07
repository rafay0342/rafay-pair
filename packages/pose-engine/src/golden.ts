/**
 * Codec and schema for the cross-platform golden vectors in `tests/golden`.
 *
 * Frames are stored triple-packed — `[x, y, visibility, ...]` in
 * `CANONICAL_JOINTS` order — so that the Swift and Kotlin readers need nothing
 * beyond a JSON array parser and the joint order from the specification.
 */

import {
  CANONICAL_JOINTS,
  type Joint,
  type JointName,
  type PoseFrame,
} from "./types.js";

const VALUES_PER_JOINT = 3;

export interface GoldenPackedFrame {
  readonly t: number;
  readonly j: readonly number[];
}

export interface GoldenPoseExpectation {
  readonly valid: boolean;
  readonly posture: string;
  readonly framingOk: boolean;
  readonly torsoAngleDeg: number;
  readonly meanKneeAngle: number;
  readonly meanHipAngle: number;
  readonly hipElevation: number;
  readonly minVisibility: number;
}

export interface GoldenPoseCase {
  readonly name: string;
  readonly note: string;
  readonly frame: GoldenPackedFrame;
  readonly expected: GoldenPoseExpectation;
}

export interface GoldenExerciseExpectation {
  readonly repetitionCount: number;
  readonly finalReportedPosture: string;
  readonly repetitions: readonly {
    readonly index: number;
    readonly startMs: number;
    readonly endMs: number;
    readonly durationMs: number;
    readonly minElevation: number;
    readonly depth: number;
    readonly formEvents: readonly string[];
  }[];
}

export interface GoldenExerciseCase {
  readonly name: string;
  readonly note: string;
  readonly frames: readonly GoldenPackedFrame[];
  readonly expected: GoldenExerciseExpectation;
}

export function encodeGoldenFrame(frame: PoseFrame): GoldenPackedFrame {
  const packed: number[] = [];
  for (const name of CANONICAL_JOINTS) {
    const joint = frame.joints[name];
    packed.push(round6(joint.x), round6(joint.y), round6(joint.visibility));
  }
  return { t: frame.timestampMs, j: packed };
}

export function decodeGoldenFrame(packed: GoldenPackedFrame): PoseFrame {
  const expected = CANONICAL_JOINTS.length * VALUES_PER_JOINT;
  if (packed.j.length !== expected) {
    throw new Error(
      `Golden frame must carry ${String(expected)} values, received ${String(packed.j.length)}`,
    );
  }
  const joints = {} as Record<JointName, Joint>;
  CANONICAL_JOINTS.forEach((name, index) => {
    const offset = index * VALUES_PER_JOINT;
    joints[name] = {
      x: packed.j[offset] as number,
      y: packed.j[offset + 1] as number,
      visibility: packed.j[offset + 2] as number,
    };
  });
  return { timestampMs: packed.t, joints };
}

/** Six decimals is well inside the 1e-6 parity tolerance and keeps the
 * committed vectors small enough to review in a diff. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
