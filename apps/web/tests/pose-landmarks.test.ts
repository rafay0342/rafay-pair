import { PoseEngine } from "@rafay-pair/pose-engine";
import { describe, expect, it } from "vitest";

import {
  toCanonicalFrame,
  type BlazePoseLandmark,
} from "../src/pose/landmarks";

/** A 33-entry BlazePose array with every landmark at a distinct position. */
function blazePoseArray(
  overrides: Record<number, BlazePoseLandmark> = {},
): BlazePoseLandmark[] {
  return Array.from(
    { length: 33 },
    (_unused, index) =>
      overrides[index] ?? { x: index / 100, y: index / 50, visibility: 0.9 },
  );
}

describe("BlazePose landmark reduction", () => {
  it("selects the canonical joints by their BlazePose indices", () => {
    const frame = toCanonicalFrame(blazePoseArray(), 1_234);
    expect(frame).toBeDefined();
    if (!frame) return;

    expect(frame.timestampMs).toBe(1_234);
    // Index 0 is the nose, 11/12 the shoulders, 23/24 the hips, 27/28 ankles.
    expect(frame.joints.nose.x).toBeCloseTo(0);
    expect(frame.joints.leftShoulder.x).toBeCloseTo(0.11);
    expect(frame.joints.rightShoulder.x).toBeCloseTo(0.12);
    expect(frame.joints.leftHip.x).toBeCloseTo(0.23);
    expect(frame.joints.rightHip.x).toBeCloseTo(0.24);
    expect(frame.joints.leftAnkle.x).toBeCloseTo(0.27);
    expect(frame.joints.rightAnkle.x).toBeCloseTo(0.28);
  });

  it("treats a missing visibility as invisible rather than trusted", () => {
    // A landmark the detector could not score must not be able to satisfy the
    // engine's usability threshold by default.
    const landmarks = blazePoseArray({ 25: { x: 0.25, y: 0.5 } });
    const frame = toCanonicalFrame(landmarks, 0);
    expect(frame?.joints.leftKnee.visibility).toBe(0);

    const observation = new PoseEngine().process(frame as never);
    expect(observation.valid).toBe(false);
    expect(observation.posture).toBe("unknown");
  });

  it("rejects a truncated landmark array", () => {
    expect(toCanonicalFrame(blazePoseArray().slice(0, 20), 0)).toBeUndefined();
    expect(toCanonicalFrame(undefined, 0)).toBeUndefined();
  });

  it("produces a frame the engine can classify", () => {
    // Coordinates for a plausible upright standing figure, mapped through the
    // real reduction path rather than hand-built engine input.
    const landmarks = blazePoseArray();
    landmarks[11] = { x: 0.425, y: 0.26, visibility: 0.95 };
    landmarks[12] = { x: 0.575, y: 0.26, visibility: 0.95 };
    landmarks[23] = { x: 0.445, y: 0.42, visibility: 0.95 };
    landmarks[24] = { x: 0.555, y: 0.42, visibility: 0.95 };
    landmarks[25] = { x: 0.45, y: 0.55, visibility: 0.95 };
    landmarks[26] = { x: 0.55, y: 0.55, visibility: 0.95 };
    landmarks[27] = { x: 0.455, y: 0.685, visibility: 0.95 };
    landmarks[28] = { x: 0.545, y: 0.685, visibility: 0.95 };

    const frame = toCanonicalFrame(landmarks, 0);
    expect(frame).toBeDefined();
    if (!frame) return;

    const observation = new PoseEngine().process(frame);
    expect(observation.valid).toBe(true);
    expect(observation.framingOk).toBe(true);
    expect(observation.posture).toBe("standing");
  });
});
