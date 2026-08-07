import { describe, expect, it } from "vitest";

import { chestSampleFromLandmarks } from "./breathingEngine.js";

/**
 * `engines/breathing-estimation-spec/SPEC.md` §4.
 *
 * The property that matters is invariance to distance from the camera. Without
 * it, walking towards the lens would read as an inhale — a confident wrong
 * breathing rate, which is worse than none.
 */
const visible = 0.9;

function landmarks(scale: number, chestRise: number) {
  return {
    timestampMs: 0,
    leftShoulder: {
      x: -0.1 * scale,
      y: (1 - chestRise) * scale,
      visibility: visible,
    },
    rightShoulder: {
      x: 0.1 * scale,
      y: (1 - chestRise) * scale,
      visibility: visible,
    },
    leftHip: { x: -0.1 * scale, y: 2 * scale, visibility: visible },
    rightHip: { x: 0.1 * scale, y: 2 * scale, visibility: visible },
  };
}

describe("chest sample", () => {
  it("is invariant to distance from the camera", () => {
    const near = chestSampleFromLandmarks(landmarks(1, 0));
    const far = chestSampleFromLandmarks(landmarks(0.4, 0));
    expect(near.tracked).toBe(true);
    expect(far.tracked).toBe(true);
    expect(near.chestOffset).toBeCloseTo(far.chestOffset, 10);
  });

  it("moves when the chest moves", () => {
    const rest = chestSampleFromLandmarks(landmarks(1, 0));
    const inhaled = chestSampleFromLandmarks(landmarks(1, 0.05));
    expect(inhaled.chestOffset).not.toBeCloseTo(rest.chestOffset, 6);
  });

  it("refuses a frame the pose engine would refuse", () => {
    // Too far away for a usable torso.
    const tiny = chestSampleFromLandmarks(landmarks(0.02, 0));
    expect(tiny.tracked).toBe(false);
    expect(tiny.chestOffset).toBe(0);

    // Torso present but the joints are not confidently seen.
    const hidden = chestSampleFromLandmarks({
      ...landmarks(1, 0),
      leftHip: { x: -0.1, y: 2, visibility: 0.2 },
    });
    expect(hidden.tracked).toBe(false);
  });
});
