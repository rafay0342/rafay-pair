import { describe, expect, it } from "vitest";

import { PoseEngine } from "./poseEngine.js";
import {
  CANONICAL_JOINTS,
  type Joint,
  type JointName,
  type PoseFrame,
} from "./types.js";

/**
 * Master specification §20: local pose feedback targets under 150 ms.
 *
 * That budget covers the whole path — camera frame, landmark detection, this
 * engine, and the redraw. The detector is the expensive part and is the
 * platform's, not ours; what is ours is the geometry, and this holds it to a
 * small fraction of the budget so the part we control cannot be the reason the
 * target is missed.
 *
 * The ceiling is deliberately loose against the measured cost. A tight one
 * would fail on a loaded CI runner and teach everyone to ignore it, and a
 * latency check people ignore is worse than none.
 */
const PER_FRAME_CEILING_MS = 2;
const FRAMES = 600;

function joint(x: number, y: number): Joint {
  return { x, y, visibility: 0.9 };
}

function frame(index: number): PoseFrame {
  // A slow squat, so the engine walks its full state machine rather than
  // measuring one posture repeatedly.
  const depth = 0.15 * Math.sin(index / 12);
  const joints = {} as Record<JointName, Joint>;
  for (const name of CANONICAL_JOINTS) joints[name] = joint(0.5, 0.5);
  joints.leftShoulder = joint(0.45, 0.3);
  joints.rightShoulder = joint(0.55, 0.3);
  joints.leftHip = joint(0.46, 0.55 + depth);
  joints.rightHip = joint(0.54, 0.55 + depth);
  joints.leftKnee = joint(0.46, 0.75 + depth);
  joints.rightKnee = joint(0.54, 0.75 + depth);
  joints.leftAnkle = joint(0.46, 0.95);
  joints.rightAnkle = joint(0.54, 0.95);
  return { timestampMs: index * 33, joints };
}

describe("pose processing latency", () => {
  it("costs a small fraction of the frame budget", () => {
    const engine = new PoseEngine();
    const frames = Array.from({ length: FRAMES }, (_, index) => frame(index));

    const started = performance.now();
    for (const input of frames) engine.process(input);
    const perFrameMs = (performance.now() - started) / FRAMES;

    expect(perFrameMs).toBeLessThan(PER_FRAME_CEILING_MS);
  });
});
