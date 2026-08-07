/**
 * Parametric skeleton synthesiser used only to author golden vectors.
 *
 * Real camera capture is not reproducible, so the cross-platform parity
 * contract is built from synthetic skeletons whose ground truth we control
 * exactly. The figure is anthropometrically proportioned (segment lengths taken
 * from adult standing anthropometry) and posed by two-link inverse kinematics,
 * so the resulting joint angles are the ones a real detector would report for
 * the same posture.
 */

import {
  CANONICAL_JOINTS,
  type Joint,
  type JointName,
  type PoseFrame,
} from "../types.js";

/** Shoulder-to-hip length in image units; the figure fills roughly half frame. */
const TORSO = 0.16;
/** Segment lengths as multiples of the torso, from adult anthropometry. */
const THIGH = 0.843 * TORSO;
const SHIN = 0.824 * TORSO;

const HIP_HALF_WIDTH = 0.055;
const SHOULDER_HALF_WIDTH = 0.075;
const ANKLE_HALF_WIDTH = 0.045;

const CENTER_X = 0.5;
/** Feet stay planted; the hips move relative to them. */
const GROUND_Y = 0.685;

export interface FigureParams {
  /** Hip height above the ankles, in torso lengths. */
  readonly hipElevation: number;
  /** Torso tilt away from image-vertical, in degrees. */
  readonly torsoTiltDeg: number;
  /** Horizontal ankle displacement, in torso lengths; positive moves feet left. */
  readonly ankleOffset?: number;
  /** Uniform visibility for every joint. */
  readonly visibility?: number;
  /** Visibility override applied to the knees, to author occlusion cases. */
  readonly kneeVisibility?: number;
  /** Whole-figure vertical shift in image units, to author framing cases. */
  readonly shiftY?: number;
  /** Extra flexion on the left knee only, in torso lengths of ankle shift. */
  readonly leftAnkleSkew?: number;
}

interface Vec {
  x: number;
  y: number;
}

export function synthesise(
  params: FigureParams,
  timestampMs: number,
): PoseFrame {
  const {
    hipElevation,
    torsoTiltDeg,
    ankleOffset = 0,
    visibility = 0.95,
    kneeVisibility,
    shiftY = 0,
    leftAnkleSkew = 0,
  } = params;

  const tilt = (torsoTiltDeg * Math.PI) / 180;
  // Torso direction points hip → shoulder; perpendicular separates left/right.
  const torsoDir: Vec = { x: Math.sin(tilt), y: -Math.cos(tilt) };
  const perp: Vec = { x: Math.cos(tilt), y: Math.sin(tilt) };

  const ankleCenter: Vec = {
    x: CENTER_X - ankleOffset * TORSO,
    y: GROUND_Y + shiftY,
  };
  const hipCenter: Vec = {
    x: CENTER_X,
    y: ankleCenter.y - hipElevation * TORSO,
  };
  const shoulderCenter = add(hipCenter, scale(torsoDir, TORSO));

  const leftHip = add(hipCenter, scale(perp, -HIP_HALF_WIDTH));
  const rightHip = add(hipCenter, scale(perp, HIP_HALF_WIDTH));
  const leftShoulder = add(shoulderCenter, scale(perp, -SHOULDER_HALF_WIDTH));
  const rightShoulder = add(shoulderCenter, scale(perp, SHOULDER_HALF_WIDTH));
  const leftAnkle = add(
    add(ankleCenter, scale(perp, -ANKLE_HALF_WIDTH)),
    scale(perp, -leftAnkleSkew * TORSO),
  );
  const rightAnkle = add(ankleCenter, scale(perp, ANKLE_HALF_WIDTH));

  // Knees bulge away from the body midline, which is what a real squat does.
  const leftKnee = solveKnee(leftHip, leftAnkle, perp, -1);
  const rightKnee = solveKnee(rightHip, rightAnkle, perp, 1);

  const armDown = scale(torsoDir, -1);
  const leftElbow = add(leftShoulder, scale(armDown, 0.5 * TORSO));
  const rightElbow = add(rightShoulder, scale(armDown, 0.5 * TORSO));
  const leftWrist = add(leftElbow, scale(armDown, 0.45 * TORSO));
  const rightWrist = add(rightElbow, scale(armDown, 0.45 * TORSO));
  const nose = add(shoulderCenter, scale(torsoDir, 0.42 * TORSO));

  const positions: Record<JointName, Vec> = {
    nose,
    leftShoulder,
    rightShoulder,
    leftElbow,
    rightElbow,
    leftWrist,
    rightWrist,
    leftHip,
    rightHip,
    leftKnee,
    rightKnee,
    leftAnkle,
    rightAnkle,
  };

  const joints = {} as Record<JointName, Joint>;
  for (const name of CANONICAL_JOINTS) {
    const isKnee = name === "leftKnee" || name === "rightKnee";
    joints[name] = {
      x: positions[name].x,
      y: positions[name].y,
      visibility:
        isKnee && kneeVisibility !== undefined ? kneeVisibility : visibility,
    };
  }
  return { timestampMs, joints };
}

/**
 * Two-link inverse kinematics. `side` picks which of the two mirror solutions
 * to use, so the knee bends away from the midline rather than through it.
 */
function solveKnee(hip: Vec, ankle: Vec, perp: Vec, side: number): Vec {
  const delta = { x: ankle.x - hip.x, y: ankle.y - hip.y };
  const reach = Math.hypot(delta.x, delta.y);
  const maxReach = (THIGH + SHIN) * 0.9999;
  const clamped = Math.min(reach, maxReach);
  const unit =
    reach < 1e-9 ? { x: 0, y: 1 } : { x: delta.x / reach, y: delta.y / reach };

  const along =
    (clamped * clamped + THIGH * THIGH - SHIN * SHIN) / (2 * clamped);
  const offset = Math.sqrt(Math.max(0, THIGH * THIGH - along * along));

  // Rotate the along-axis by 90° to obtain the bulge direction, then orient it
  // so positive `side` bulges the same way as the perpendicular axis.
  const normal = { x: -unit.y, y: unit.x };
  const orientation = Math.sign(normal.x * perp.x + normal.y * perp.y) || 1;
  const bulge = scale(normal, side * orientation * offset);
  return add(add(hip, scale(unit, along)), bulge);
}

function add(a: Vec, b: Vec): Vec {
  return { x: a.x + b.x, y: a.y + b.y };
}

function scale(v: Vec, factor: number): Vec {
  return { x: v.x * factor, y: v.y * factor };
}

/** Linear interpolation between two figure parameter sets. */
export function interpolate(
  from: FigureParams,
  to: FigureParams,
  progress: number,
): FigureParams {
  const mix = (
    a: number | undefined,
    b: number | undefined,
    fallback: number,
  ): number => {
    const left = a ?? fallback;
    const right = b ?? fallback;
    return left + (right - left) * progress;
  };
  return {
    hipElevation: mix(from.hipElevation, to.hipElevation, 0),
    torsoTiltDeg: mix(from.torsoTiltDeg, to.torsoTiltDeg, 0),
    ankleOffset: mix(from.ankleOffset, to.ankleOffset, 0),
    visibility: mix(from.visibility, to.visibility, 0.95),
    leftAnkleSkew: mix(from.leftAnkleSkew, to.leftAnkleSkew, 0),
  };
}
