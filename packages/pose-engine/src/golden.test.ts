import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ExerciseEngine } from "./exerciseEngine.js";
import { decodeGoldenFrame } from "./golden.js";
import type { GoldenExerciseCase, GoldenPoseCase } from "./golden.js";
import { PoseEngine } from "./poseEngine.js";

const TOLERANCE = 1e-6;

const goldenRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../tests/golden",
);

function readJson<T>(...segments: string[]): T {
  return JSON.parse(
    readFileSync(path.join(goldenRoot, ...segments), "utf8"),
  ) as T;
}

describe("pose golden vectors", () => {
  const { cases } = readJson<{ cases: GoldenPoseCase[] }>(
    "pose",
    "static-postures.json",
  );

  it("covers every classification branch", () => {
    const postures = new Set(
      cases.map((testCase) => testCase.expected.posture),
    );
    expect(postures).toEqual(
      new Set(["standing", "crouched", "lying", "transitional", "unknown"]),
    );
  });

  it.each(cases.map((testCase) => [testCase.name, testCase] as const))(
    "%s",
    (_name, testCase) => {
      const engine = new PoseEngine();
      const observation = engine.process(decodeGoldenFrame(testCase.frame));
      const expected = testCase.expected;

      expect(observation.valid).toBe(expected.valid);
      expect(observation.posture).toBe(expected.posture);
      expect(observation.framingOk).toBe(expected.framingOk);
      expect(observation.torsoAngleDeg).toBeCloseTo(expected.torsoAngleDeg, 6);
      expect(observation.meanKneeAngle).toBeCloseTo(expected.meanKneeAngle, 6);
      expect(observation.meanHipAngle).toBeCloseTo(expected.meanHipAngle, 6);
      expect(observation.hipElevation).toBeCloseTo(expected.hipElevation, 6);
      expect(observation.minVisibility).toBeCloseTo(expected.minVisibility, 6);
    },
  );
});

describe("exercise golden vectors", () => {
  const files = readdirSync(path.join(goldenRoot, "exercise")).sort();

  it("ships the full scenario set", () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  for (const file of files) {
    it(file, () => {
      const testCase = readJson<GoldenExerciseCase>("exercise", file);
      const poseEngine = new PoseEngine();
      const exerciseEngine = new ExerciseEngine();

      let finalReportedPosture = "unknown";
      for (const frame of testCase.frames) {
        const observation = poseEngine.process(decodeGoldenFrame(frame));
        finalReportedPosture =
          exerciseEngine.process(observation).reportedPosture;
      }

      const summary = exerciseEngine.summary();
      expect(summary.repetitionCount).toBe(testCase.expected.repetitionCount);
      expect(finalReportedPosture).toBe(testCase.expected.finalReportedPosture);
      expect(summary.repetitions).toHaveLength(
        testCase.expected.repetitions.length,
      );

      testCase.expected.repetitions.forEach((expected, index) => {
        const actual = summary.repetitions[index];
        expect(actual).toBeDefined();
        if (!actual) return;
        expect(actual.index).toBe(expected.index);
        expect(actual.startMs).toBe(expected.startMs);
        expect(actual.endMs).toBe(expected.endMs);
        expect(actual.durationMs).toBe(expected.durationMs);
        expect(actual.minElevation).toBeCloseTo(expected.minElevation, 6);
        expect(actual.depth).toBeCloseTo(expected.depth, 6);
        expect([...actual.formEvents]).toEqual([...expected.formEvents]);
      });
    });
  }
});

describe("engine invariants", () => {
  it("resets smoothing so a replayed sequence is reproducible", () => {
    const testCase = readJson<GoldenExerciseCase>(
      "exercise",
      "three-squats.json",
    );
    const engine = new PoseEngine();
    const first = testCase.frames.map(
      (frame) => engine.process(decodeGoldenFrame(frame)).hipElevation,
    );
    engine.reset();
    const second = testCase.frames.map(
      (frame) => engine.process(decodeGoldenFrame(frame)).hipElevation,
    );
    expect(second).toEqual(first);
  });

  it("treats a stale gap as a loss of tracking", () => {
    const testCase = readJson<GoldenExerciseCase>(
      "exercise",
      "three-squats.json",
    );
    const poseEngine = new PoseEngine();
    const exerciseEngine = new ExerciseEngine();
    const frames = testCase.frames.slice(0, 40);
    for (const frame of frames) {
      exerciseEngine.process(poseEngine.process(decodeGoldenFrame(frame)));
    }

    const last = frames.at(-1);
    expect(last).toBeDefined();
    if (!last) return;
    // A gap longer than STALE_FRAME_MS must drop the committed posture rather
    // than silently carrying a stale claim across the interruption.
    const resumed = exerciseEngine.process(
      poseEngine.process(decodeGoldenFrame({ ...last, t: last.t + 5_000 })),
    );
    expect(resumed.reportedPosture).toBe("unknown");
  });

  it("never reports a repetition without reaching depth", () => {
    const testCase = readJson<GoldenExerciseCase>(
      "exercise",
      "partial-squat-no-depth.json",
    );
    const poseEngine = new PoseEngine();
    const exerciseEngine = new ExerciseEngine();
    for (const frame of testCase.frames) {
      const result = exerciseEngine.process(
        poseEngine.process(decodeGoldenFrame(frame)),
      );
      expect(result.completedRepetition).toBeUndefined();
    }
  });
});
