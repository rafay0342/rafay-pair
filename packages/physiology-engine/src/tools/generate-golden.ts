/**
 * Authors the cross-platform physiology parity vectors in `tests/golden`.
 *
 * Expected values are produced by the TypeScript reference implementation,
 * which the specifications designate as normative. Regenerating these files is
 * a deliberate change to the parity contract and must be reviewed as one.
 *
 * Run with `pnpm --filter @rafay-pair/physiology-engine golden`.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { estimateBreathing } from "../breathingEngine.js";
import { estimateCalories } from "../calorieEngine.js";
import { estimatePulse } from "../pulseEngine.js";
import type {
  BreathingSample,
  CalorieEstimateInput,
  PulseSample,
} from "../types.js";
import { synthesiseBreathing, synthesisePulse } from "./synth.js";

const MEASURED_AT_MS = 1_786_000_000_000;

const pulseCases: readonly {
  name: string;
  note: string;
  samples: PulseSample[];
}[] = [
  {
    name: "clean-72bpm",
    note: "A well-seated fingertip at a resting rate.",
    samples: synthesisePulse({ bpm: 72, durationMs: 20_000, seed: 1 }),
  },
  {
    name: "clean-58bpm",
    note: "A low resting rate, near the slow end of the plausible band.",
    samples: synthesisePulse({ bpm: 58, durationMs: 22_000, seed: 2 }),
  },
  {
    name: "post-exercise-124bpm",
    note: "An elevated rate immediately after a workout.",
    samples: synthesisePulse({
      bpm: 124,
      durationMs: 15_000,
      acAmplitude: 4.1,
      seed: 3,
    }),
  },
  {
    name: "low-perfusion-88bpm",
    note: "A faint pulsatile component with more noise; still recoverable.",
    samples: synthesisePulse({
      bpm: 88,
      durationMs: 12_000,
      acAmplitude: 1.1,
      noise: 0.6,
      seed: 4,
    }),
  },
  {
    name: "short-session",
    note: "Under the eight-second minimum; must reject rather than guess.",
    samples: synthesisePulse({ bpm: 76, durationMs: 5_000, seed: 5 }),
  },
  {
    name: "finger-lifted",
    note: "The fingertip leaves the lens part-way through; coverage collapses.",
    samples: synthesisePulse({
      bpm: 76,
      durationMs: 18_000,
      uncoveredTailFraction: 0.45,
      seed: 6,
    }),
  },
  {
    name: "sliding-finger",
    note: "Large baseline excursions from a moving fingertip.",
    samples: synthesisePulse({
      bpm: 80,
      durationMs: 18_000,
      motionBursts: 26,
      seed: 7,
    }),
  },
  {
    name: "no-pulsation",
    note: "A covered lens with no pulsatile component; nothing to report.",
    samples: synthesisePulse({
      bpm: 70,
      durationMs: 18_000,
      acAmplitude: 0,
      noise: 0.5,
      seed: 8,
    }),
  },
];

const breathingCases: readonly {
  name: string;
  note: string;
  samples: BreathingSample[];
}[] = [
  {
    name: "calm-12-breaths",
    note: "A settled resting respiratory rate.",
    samples: synthesiseBreathing({
      breathsPerMinute: 12,
      durationMs: 60_000,
      seed: 11,
    }),
  },
  {
    name: "slow-8-breaths",
    note: "Guided slow breathing, near the low end of the band.",
    samples: synthesiseBreathing({
      breathsPerMinute: 8,
      durationMs: 75_000,
      seed: 12,
    }),
  },
  {
    name: "elevated-20-breaths",
    note: "Post-exertion breathing.",
    samples: synthesiseBreathing({
      breathsPerMinute: 20,
      durationMs: 60_000,
      seed: 13,
    }),
  },
  {
    name: "poorly-tracked",
    note: "The pose engine lost the body too often to support a claim.",
    samples: synthesiseBreathing({
      breathsPerMinute: 14,
      durationMs: 60_000,
      untrackedFraction: 0.45,
      seed: 14,
    }),
  },
  {
    name: "fidgeting-but-recoverable",
    note: "Out-of-band fidgeting that the band-matched filter removes; the true rate survives.",
    samples: synthesiseBreathing({
      breathsPerMinute: 14,
      durationMs: 60_000,
      motionBursts: 0.5,
      seed: 15,
    }),
  },
  {
    name: "gross-body-movement",
    note: "Movement large enough that no breathing claim is defensible.",
    samples: synthesiseBreathing({
      breathsPerMinute: 14,
      durationMs: 60_000,
      motionBursts: 3.5,
      seed: 17,
    }),
  },
  {
    name: "session-too-short",
    note: "Under the twenty-second minimum.",
    samples: synthesiseBreathing({
      breathsPerMinute: 13,
      durationMs: 12_000,
      seed: 16,
    }),
  },
];

const calorieCases: readonly {
  name: string;
  note: string;
  input: CalorieEstimateInput;
}[] = [
  {
    name: "squats-with-body-mass",
    note: "Full inputs; the narrowest band the method allows.",
    input: {
      activity: "squat",
      durationMs: 300_000,
      repetitions: 60,
      bodyMassKg: 74,
    },
  },
  {
    name: "squats-without-body-mass",
    note: "No body mass supplied; the placeholder widens the band.",
    input: { activity: "squat", durationMs: 300_000, repetitions: 60 },
  },
  {
    name: "squats-low-pose-confidence",
    note: "Weak pose tracking widens the band further.",
    input: {
      activity: "squat",
      durationMs: 300_000,
      repetitions: 60,
      bodyMassKg: 74,
      poseConfidence: 0.3,
    },
  },
  {
    name: "fast-burst-short-session",
    note: "A high repetition rate in a short session; the intensity clamp binds.",
    input: {
      activity: "squat",
      durationMs: 30_000,
      repetitions: 25,
      bodyMassKg: 80,
    },
  },
  {
    name: "guided-breathing-session",
    note: "A near-resting activity with no repetitions.",
    input: {
      activity: "guidedBreathing",
      durationMs: 600_000,
      bodyMassKg: 68,
    },
  },
  {
    name: "zero-length-session",
    note: "Zero is the honest answer; the band is at its widest.",
    input: { activity: "squat", durationMs: 0, repetitions: 0, bodyMassKg: 70 },
  },
];

const goldenRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tests/golden",
);

const header = {
  encoding:
    "Pulse samples are [timestampMs, red, green]; breathing samples are [timestampMs, chestOffset, tracked as 1 or 0].",
  tolerance: 1e-6,
  specification:
    "engines/signal-quality/SPEC.md, engines/pulse-estimation-spec/SPEC.md, engines/breathing-estimation-spec/SPEC.md, engines/calorie-estimation-spec/SPEC.md",
};

await mkdir(path.join(goldenRoot, "pulse"), { recursive: true });
await mkdir(path.join(goldenRoot, "breathing"), { recursive: true });
await mkdir(path.join(goldenRoot, "calories"), { recursive: true });

for (const testCase of pulseCases) {
  const expected = estimatePulse(testCase.samples, MEASURED_AT_MS);
  await writeFile(
    path.join(goldenRoot, "pulse", `${testCase.name}.json`),
    `${JSON.stringify(
      {
        ...header,
        name: testCase.name,
        note: testCase.note,
        measuredAtMs: MEASURED_AT_MS,
        samples: testCase.samples.map((sample) => [
          sample.timestampMs,
          sample.red,
          sample.green,
        ]),
        expected,
      },
      null,
      2,
    )}\n`,
  );
}

for (const testCase of breathingCases) {
  const expected = estimateBreathing(testCase.samples, MEASURED_AT_MS);
  await writeFile(
    path.join(goldenRoot, "breathing", `${testCase.name}.json`),
    `${JSON.stringify(
      {
        ...header,
        name: testCase.name,
        note: testCase.note,
        measuredAtMs: MEASURED_AT_MS,
        samples: testCase.samples.map((sample) => [
          sample.timestampMs,
          sample.chestOffset,
          sample.tracked ? 1 : 0,
        ]),
        expected,
      },
      null,
      2,
    )}\n`,
  );
}

await writeFile(
  path.join(goldenRoot, "calories", "estimates.json"),
  `${JSON.stringify(
    {
      ...header,
      cases: calorieCases.map((testCase) => ({
        name: testCase.name,
        note: testCase.note,
        input: testCase.input,
        expected: estimateCalories(testCase.input),
      })),
    },
    null,
    2,
  )}\n`,
);

process.stdout.write("physiology golden vectors written\n");
