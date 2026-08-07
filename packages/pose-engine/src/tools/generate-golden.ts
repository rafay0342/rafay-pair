/**
 * Authors the cross-platform golden vectors in `tests/golden`.
 *
 * Expected values are produced by the TypeScript reference implementation,
 * which the specifications designate as normative. The Swift and Kotlin ports
 * are checked against the committed output; regenerating these files is a
 * deliberate change to the parity contract and must be reviewed as one.
 *
 * Run with `pnpm --filter @rafay-pair/pose-engine golden`.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ExerciseEngine } from "../exerciseEngine.js";
import { decodeGoldenFrame, encodeGoldenFrame } from "../golden.js";
import type {
  GoldenExerciseCase,
  GoldenPackedFrame,
  GoldenPoseCase,
} from "../golden.js";
import { PoseEngine } from "../poseEngine.js";
import type { PoseFrame } from "../types.js";
import { interpolate, synthesise, type FigureParams } from "./skeleton.js";

const FRAME_INTERVAL_MS = 33;

const STAND: FigureParams = { hipElevation: 1.655, torsoTiltDeg: 0 };
const SQUAT_BOTTOM: FigureParams = { hipElevation: 0.95, torsoTiltDeg: 30 };
const DEEP_LEAN_BOTTOM: FigureParams = { hipElevation: 0.92, torsoTiltDeg: 52 };
const SEATED: FigureParams = { hipElevation: 0.9, torsoTiltDeg: 10 };
const PARTIAL: FigureParams = { hipElevation: 1.2, torsoTiltDeg: 15 };
const LYING: FigureParams = {
  hipElevation: 0.05,
  torsoTiltDeg: 90,
  ankleOffset: 1.55,
};

interface Segment {
  readonly durationMs: number;
  readonly from: FigureParams;
  readonly to?: FigureParams;
}

const poseCases: readonly {
  name: string;
  note: string;
  params: FigureParams;
}[] = [
  {
    name: "standing-upright",
    note: "Relaxed standing with near-extended knees.",
    params: STAND,
  },
  {
    name: "seated-on-chair",
    note: "Hips at chair height, shins vertical; statically indistinguishable from a squat bottom.",
    params: SEATED,
  },
  {
    name: "squat-bottom",
    note: "Bottom of a squat with a moderate forward torso lean.",
    params: SQUAT_BOTTOM,
  },
  {
    name: "lying-flat",
    note: "Torso horizontal; the lying rule outranks every elevation rule.",
    params: LYING,
  },
  {
    name: "mid-descent",
    note: "Inside the dead band between crouched and standing, so neither commits.",
    params: PARTIAL,
  },
  {
    name: "occluded-knees",
    note: "Knee visibility below the usable threshold invalidates the frame.",
    params: { ...STAND, kneeVisibility: 0.2 },
  },
  {
    name: "feet-below-frame",
    note: "Whole figure shifted down; posture still classifies but framing fails.",
    params: { ...STAND, shiftY: 0.36 },
  },
  {
    name: "uneven-squat",
    note: "One ankle displaced, producing asymmetric knee angles.",
    params: { ...SQUAT_BOTTOM, leftAnkleSkew: 0.55 },
  },
];

const exerciseCases: readonly {
  name: string;
  note: string;
  segments: Segment[];
}[] = [
  {
    name: "standing-still",
    note: "No movement; the engine must not invent repetitions.",
    segments: [{ durationMs: 1500, from: STAND }],
  },
  {
    name: "three-squats",
    note: "Three clean repetitions with a rest between each.",
    segments: [
      { durationMs: 1000, from: STAND },
      ...repeatSquat(3),
      { durationMs: 1000, from: STAND },
    ],
  },
  {
    name: "sit-down-and-hold",
    note: "Descending into a chair and staying there is sitting, not a squat.",
    segments: [
      { durationMs: 1000, from: STAND, to: STAND },
      { durationMs: 1200, from: STAND, to: SEATED },
      { durationMs: 4000, from: SEATED },
    ],
  },
  {
    name: "partial-squat-no-depth",
    note: "Descent that never reaches depth is abandoned, not counted.",
    segments: [
      { durationMs: 1000, from: STAND },
      { durationMs: 600, from: STAND, to: PARTIAL },
      { durationMs: 300, from: PARTIAL },
      { durationMs: 600, from: PARTIAL, to: STAND },
      { durationMs: 1000, from: STAND },
    ],
  },
  {
    name: "bounce-too-fast",
    note: "A sub-500 ms dip is tracking noise and must not count.",
    segments: [
      { durationMs: 1000, from: STAND },
      { durationMs: 165, from: STAND, to: SQUAT_BOTTOM },
      { durationMs: 165, from: SQUAT_BOTTOM, to: STAND },
      { durationMs: 1000, from: STAND },
    ],
  },
  {
    name: "lie-down-and-hold",
    note: "Lowering to the floor commits to lying and cancels the partial cycle.",
    segments: [
      { durationMs: 1000, from: STAND },
      { durationMs: 1500, from: STAND, to: LYING },
      { durationMs: 2500, from: LYING },
    ],
  },
  {
    name: "deep-squat-forward-lean",
    note: "A counted repetition that also raises a forward-lean form event.",
    segments: [
      { durationMs: 1000, from: STAND },
      { durationMs: 700, from: STAND, to: DEEP_LEAN_BOTTOM },
      { durationMs: 200, from: DEEP_LEAN_BOTTOM },
      { durationMs: 700, from: DEEP_LEAN_BOTTOM, to: STAND },
      { durationMs: 1000, from: STAND },
    ],
  },
  {
    name: "squat-then-sit",
    note: "One repetition followed by sitting down; the sit must not add a second.",
    segments: [
      { durationMs: 1000, from: STAND },
      ...repeatSquat(1),
      { durationMs: 1200, from: STAND, to: SEATED },
      { durationMs: 4000, from: SEATED },
    ],
  },
];

function repeatSquat(count: number): Segment[] {
  const segments: Segment[] = [];
  for (let index = 0; index < count; index += 1) {
    segments.push(
      { durationMs: 700, from: STAND, to: SQUAT_BOTTOM },
      { durationMs: 200, from: SQUAT_BOTTOM },
      { durationMs: 700, from: SQUAT_BOTTOM, to: STAND },
      { durationMs: 400, from: STAND },
    );
  }
  return segments;
}

function buildFrames(segments: readonly Segment[]): PoseFrame[] {
  const frames: PoseFrame[] = [];
  let elapsed = 0;
  for (const segment of segments) {
    const steps = Math.round(segment.durationMs / FRAME_INTERVAL_MS);
    for (let step = 0; step < steps; step += 1) {
      const progress = steps <= 1 ? 0 : step / steps;
      const params = segment.to
        ? interpolate(segment.from, segment.to, progress)
        : segment.from;
      frames.push(synthesise(params, elapsed));
      elapsed += FRAME_INTERVAL_MS;
    }
  }
  return frames;
}

function buildPoseCases(): GoldenPoseCase[] {
  return poseCases.map(({ name, note, params }) => {
    const engine = new PoseEngine();
    const frame = synthesise(params, 0);
    const packed = encodeGoldenFrame(frame);
    // Score the packed frame, not the raw one, so the committed vector and the
    // committed expectation describe exactly the same input.
    const observation = engine.process(decode(packed));
    return {
      name,
      note,
      frame: packed,
      expected: {
        valid: observation.valid,
        posture: observation.posture,
        framingOk: observation.framingOk,
        torsoAngleDeg: observation.torsoAngleDeg,
        meanKneeAngle: observation.meanKneeAngle,
        meanHipAngle: observation.meanHipAngle,
        hipElevation: observation.hipElevation,
        minVisibility: observation.minVisibility,
      },
    };
  });
}

function buildExerciseCases(): GoldenExerciseCase[] {
  return exerciseCases.map(({ name, note, segments }) => {
    const packed = buildFrames(segments).map(encodeGoldenFrame);
    const poseEngine = new PoseEngine();
    const exerciseEngine = new ExerciseEngine();
    let finalReportedPosture = "unknown";
    for (const frame of packed) {
      const observation = poseEngine.process(decode(frame));
      finalReportedPosture =
        exerciseEngine.process(observation).reportedPosture;
    }
    const summary = exerciseEngine.summary();
    return {
      name,
      note,
      frames: packed,
      expected: {
        repetitionCount: summary.repetitionCount,
        finalReportedPosture,
        repetitions: summary.repetitions.map((repetition) => ({
          index: repetition.index,
          startMs: repetition.startMs,
          endMs: repetition.endMs,
          durationMs: repetition.durationMs,
          minElevation: repetition.minElevation,
          depth: repetition.depth,
          formEvents: [...repetition.formEvents],
        })),
      },
    };
  });
}

function decode(packed: GoldenPackedFrame): PoseFrame {
  return decodeGoldenFrame(packed);
}

const goldenRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tests/golden",
);

await mkdir(path.join(goldenRoot, "pose"), { recursive: true });
await mkdir(path.join(goldenRoot, "exercise"), { recursive: true });

const header = {
  jointOrder: [
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
  ],
  encoding:
    "Each frame packs x, y, visibility per joint, in jointOrder, into a flat array.",
  tolerance: 1e-6,
  specification:
    "engines/pose-spec/SPEC.md, engines/exercise-state-machines/SPEC.md",
};

await writeFile(
  path.join(goldenRoot, "pose", "static-postures.json"),
  `${JSON.stringify({ ...header, cases: buildPoseCases() }, null, 2)}\n`,
);

for (const testCase of buildExerciseCases()) {
  await writeFile(
    path.join(goldenRoot, "exercise", `${testCase.name}.json`),
    `${JSON.stringify({ ...header, ...testCase }, null, 2)}\n`,
  );
}

process.stdout.write("golden vectors written\n");
