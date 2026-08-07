/**
 * Per-frame pose engine — the reference implementation of
 * `engines/pose-spec/SPEC.md`.
 *
 * Stateful only in its smoothing filter. Given the same frame sequence from a
 * fresh instance, every platform must produce the same observations.
 */

import {
  CROUCHED_HIP_ELEVATION,
  CROUCHED_KNEE_ANGLE,
  LYING_TORSO_ANGLE_DEG,
  MIN_TORSO_SCALE,
  MIN_VISIBILITY,
  SMOOTHING_ALPHA,
  STANDING_HIP_ELEVATION,
  STANDING_KNEE_ANGLE,
} from "./constants.js";
import { angleAtVertex, angleBetween, distance, midpoint } from "./geometry.js";
import {
  CANONICAL_JOINTS,
  CORE_JOINTS,
  type Joint,
  type JointName,
  type PoseFrame,
  type PoseObservation,
  type Posture,
} from "./types.js";

/** Image-space "up". Frame coordinates grow downward, so up is negative y. */
const IMAGE_UP = { x: 0, y: -1 } as const;

const INVALID_OBSERVATION = {
  valid: false,
  posture: "unknown",
  torsoAngleDeg: 0,
  meanKneeAngle: 0,
  meanHipAngle: 0,
  leftKneeAngle: 0,
  rightKneeAngle: 0,
  hipElevation: 0,
} as const;

export class PoseEngine {
  private smoothed: Record<JointName, Joint> | undefined;

  /** Discards smoothing history. Call between independent sequences. */
  public reset(): void {
    this.smoothed = undefined;
  }

  public process(frame: PoseFrame): PoseObservation {
    const minVisibility = lowestCoreVisibility(frame.joints);
    const framingOk = coreJointsWithinFrame(frame.joints);

    // An unusable frame must not poison the smoothing state: a subject who
    // walks out of shot and back must resume from where they left, not from a
    // filter that averaged in garbage coordinates.
    if (minVisibility < MIN_VISIBILITY) {
      return {
        timestampMs: frame.timestampMs,
        ...INVALID_OBSERVATION,
        minVisibility,
        framingOk,
      };
    }

    const joints = this.smooth(frame.joints);

    const hipCenter = midpoint(joints.leftHip, joints.rightHip);
    const shoulderCenter = midpoint(joints.leftShoulder, joints.rightShoulder);
    const ankleCenter = midpoint(joints.leftAnkle, joints.rightAnkle);
    const torsoScale = distance(hipCenter, shoulderCenter);

    if (torsoScale < MIN_TORSO_SCALE) {
      return {
        timestampMs: frame.timestampMs,
        ...INVALID_OBSERVATION,
        minVisibility,
        framingOk,
      };
    }

    const torsoAngleDeg = angleBetween(
      { x: shoulderCenter.x - hipCenter.x, y: shoulderCenter.y - hipCenter.y },
      IMAGE_UP,
    );
    const leftKneeAngle = angleAtVertex(
      joints.leftHip,
      joints.leftKnee,
      joints.leftAnkle,
    );
    const rightKneeAngle = angleAtVertex(
      joints.rightHip,
      joints.rightKnee,
      joints.rightAnkle,
    );
    const leftHipAngle = angleAtVertex(
      joints.leftShoulder,
      joints.leftHip,
      joints.leftKnee,
    );
    const rightHipAngle = angleAtVertex(
      joints.rightShoulder,
      joints.rightHip,
      joints.rightKnee,
    );
    const meanKneeAngle = (leftKneeAngle + rightKneeAngle) / 2;
    const meanHipAngle = (leftHipAngle + rightHipAngle) / 2;
    const hipElevation = (ankleCenter.y - hipCenter.y) / torsoScale;

    return {
      timestampMs: frame.timestampMs,
      valid: true,
      posture: classify(torsoAngleDeg, hipElevation, meanKneeAngle),
      torsoAngleDeg,
      meanKneeAngle,
      meanHipAngle,
      leftKneeAngle,
      rightKneeAngle,
      hipElevation,
      minVisibility,
      framingOk,
    };
  }

  private smooth(
    raw: Readonly<Record<JointName, Joint>>,
  ): Record<JointName, Joint> {
    const previous = this.smoothed;
    const next = {} as Record<JointName, Joint>;
    for (const name of CANONICAL_JOINTS) {
      const current = raw[name];
      const last = previous?.[name];
      next[name] = last
        ? {
            x: SMOOTHING_ALPHA * current.x + (1 - SMOOTHING_ALPHA) * last.x,
            y: SMOOTHING_ALPHA * current.y + (1 - SMOOTHING_ALPHA) * last.y,
            visibility: current.visibility,
          }
        : current;
    }
    this.smoothed = next;
    return next;
  }
}

/**
 * Static posture from one frame. Sitting and the bottom of a squat are the same
 * skeleton, so both resolve to `crouched`; the exercise state machine separates
 * them over time.
 */
function classify(
  torsoAngleDeg: number,
  hipElevation: number,
  meanKneeAngle: number,
): Posture {
  if (torsoAngleDeg >= LYING_TORSO_ANGLE_DEG) return "lying";
  if (
    hipElevation >= STANDING_HIP_ELEVATION &&
    meanKneeAngle >= STANDING_KNEE_ANGLE
  ) {
    return "standing";
  }
  if (
    hipElevation <= CROUCHED_HIP_ELEVATION &&
    meanKneeAngle <= CROUCHED_KNEE_ANGLE
  ) {
    return "crouched";
  }
  return "transitional";
}

function lowestCoreVisibility(
  joints: Readonly<Record<JointName, Joint>>,
): number {
  let lowest = 1;
  for (const name of CORE_JOINTS) {
    const visibility = joints[name].visibility;
    if (visibility < lowest) lowest = visibility;
  }
  return lowest;
}

function coreJointsWithinFrame(
  joints: Readonly<Record<JointName, Joint>>,
): boolean {
  for (const name of CORE_JOINTS) {
    const joint = joints[name];
    if (joint.x < 0 || joint.x > 1 || joint.y < 0 || joint.y > 1) return false;
  }
  return true;
}
