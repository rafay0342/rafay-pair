import {
  type Joint,
  type JointName,
  type PoseFrame,
} from "@rafay-pair/pose-engine";

/**
 * BlazePose landmark indices for the canonical thirteen joints.
 *
 * MediaPipe reports 33 landmarks with a top-left origin and normalized
 * coordinates, which already matches the axis convention in
 * `engines/pose-spec/SPEC.md`; only the subset selection is needed.
 */
const BLAZE_POSE_INDEX: Readonly<Record<JointName, number>> = {
  nose: 0,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
};

export interface BlazePoseLandmark {
  readonly x: number;
  readonly y: number;
  readonly visibility?: number;
}

/**
 * Reduces a BlazePose landmark array to a canonical frame.
 *
 * Returns `undefined` when the detector produced no usable landmark array, so
 * callers can distinguish "no person in shot" from "person detected badly" —
 * the engine already reports the latter as an invalid frame.
 */
export function toCanonicalFrame(
  landmarks: readonly BlazePoseLandmark[] | undefined,
  timestampMs: number,
): PoseFrame | undefined {
  if (!landmarks || landmarks.length < 29) return undefined;

  const read = (name: JointName): Joint => {
    const landmark = landmarks[BLAZE_POSE_INDEX[name]];
    if (!landmark) return { x: 0, y: 0, visibility: 0 };
    return {
      x: landmark.x,
      y: landmark.y,
      // MediaPipe omits visibility on some builds; treating a missing value as
      // fully visible would let the engine trust a landmark it should reject,
      // so absence is scored as invisible.
      visibility: landmark.visibility ?? 0,
    };
  };

  return {
    timestampMs,
    joints: {
      nose: read("nose"),
      leftShoulder: read("leftShoulder"),
      rightShoulder: read("rightShoulder"),
      leftElbow: read("leftElbow"),
      rightElbow: read("rightElbow"),
      leftWrist: read("leftWrist"),
      rightWrist: read("rightWrist"),
      leftHip: read("leftHip"),
      rightHip: read("rightHip"),
      leftKnee: read("leftKnee"),
      rightKnee: read("rightKnee"),
      leftAnkle: read("leftAnkle"),
      rightAnkle: read("rightAnkle"),
    },
  };
}
