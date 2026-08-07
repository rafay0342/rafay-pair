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

import {
  estimateAudioBreathing,
  extractAudioHops,
} from "../audioBreathingEngine.js";
import { estimateBreathing } from "../breathingEngine.js";
import { estimateCalories } from "../calorieEngine.js";
import { estimateFaceRppg } from "../faceRppgEngine.js";
import { estimatePulse } from "../pulseEngine.js";
import type {
  BreathingSample,
  CalorieEstimateInput,
  FaceRppgSample,
  PulseSample,
} from "../types.js";
import {
  synthesiseBreathAudio,
  synthesiseBreathing,
  synthesiseFaceRppg,
  synthesisePulse,
} from "./synth.js";

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

/**
 * Microphone cases. Two short ones carry raw PCM so the feature extractor itself
 * is under contract; the longer ones carry only features, because a full session
 * of PCM would be tens of megabytes of vector for no extra coverage.
 */
const audioFrameCases: readonly {
  name: string;
  note: string;
  samples: number[];
}[] = [
  {
    name: "steady-breathing",
    note: "Two seconds of audible breathing; pins the band-pass and hop boundaries.",
    samples: synthesiseBreathAudio({
      breathsPerMinute: 12,
      durationMs: 2_000,
      seed: 41,
    }),
  },
  {
    name: "clipped-input",
    note: "A clipped recording; every hop must fail the usability gate.",
    samples: synthesiseBreathAudio({
      breathsPerMinute: 12,
      durationMs: 2_000,
      clipping: true,
      seed: 42,
    }),
  },
];

const audioSessionCases: readonly {
  name: string;
  note: string;
  samples: number[];
}[] = [
  {
    name: "calm-11-breaths",
    note: "A settled session at a slow rate.",
    samples: synthesiseBreathAudio({
      breathsPerMinute: 11,
      durationMs: 60_000,
      seed: 51,
    }),
  },
  {
    name: "elevated-18-breaths",
    note: "Faster breathing after exertion.",
    samples: synthesiseBreathAudio({
      breathsPerMinute: 18,
      durationMs: 55_000,
      seed: 52,
    }),
  },
  {
    name: "silent-room",
    note: "Nothing audible; the session must be refused, not guessed at.",
    samples: synthesiseBreathAudio({
      breathsPerMinute: 12,
      durationMs: 45_000,
      breathLevel: 0.0002,
      noiseLevel: 0.0001,
      seed: 53,
    }),
  },
  {
    name: "voiced-speech-intrusion",
    note: "Sustained voiced speech; too periodic to be breath, and gated out.",
    samples: synthesiseBreathAudio({
      breathsPerMinute: 12,
      durationMs: 45_000,
      breathLevel: 0.004,
      speechLevel: 0.08,
      seed: 54,
    }),
  },
  {
    name: "session-too-short",
    note: "Under the twenty-second minimum.",
    samples: synthesiseBreathAudio({
      breathsPerMinute: 12,
      durationMs: 12_000,
      seed: 55,
    }),
  },
];

const faceRppgCases: readonly {
  name: string;
  note: string;
  samples: FaceRppgSample[];
}[] = [
  {
    name: "well-lit-70bpm",
    note: "A still, evenly lit face at a resting rate — the best case this mode has.",
    samples: synthesiseFaceRppg({ bpm: 70, durationMs: 40_000, seed: 61 }),
  },
  {
    name: "well-lit-96bpm",
    note: "A slightly elevated rate under the same conditions.",
    samples: synthesiseFaceRppg({ bpm: 96, durationMs: 35_000, seed: 62 }),
  },
  {
    name: "changing-light",
    note: "Illumination drifting across the session; the very thing rPPG mistakes for a pulse.",
    samples: synthesiseFaceRppg({
      bpm: 72,
      durationMs: 35_000,
      lightingDrift: 0.16,
      seed: 63,
    }),
  },
  {
    name: "too-dark",
    note: "Below the usable luma floor; shot noise would swamp the signal.",
    samples: synthesiseFaceRppg({
      bpm: 72,
      durationMs: 35_000,
      luma: 34,
      seed: 64,
    }),
  },
  {
    name: "slight-head-drift",
    note: "Small, slow head movement that the gate tolerates; the rate survives.",
    samples: synthesiseFaceRppg({
      bpm: 72,
      durationMs: 35_000,
      headMotion: 0.05,
      seed: 65,
    }),
  },
  {
    name: "restless-head",
    note: "Movement fast enough to break region correspondence between frames.",
    samples: synthesiseFaceRppg({
      bpm: 72,
      durationMs: 35_000,
      headMotion: 0.25,
      seed: 69,
    }),
  },
  {
    name: "face-lost",
    note: "The face leaves the frame part-way through.",
    samples: synthesiseFaceRppg({
      bpm: 72,
      durationMs: 35_000,
      faceLostTailFraction: 0.4,
      seed: 66,
    }),
  },
  {
    name: "session-too-short",
    note: "Under the fifteen-second minimum.",
    samples: synthesiseFaceRppg({ bpm: 72, durationMs: 9_000, seed: 67 }),
  },
  {
    name: "no-pulsation",
    note: "A still, lit face with no pulsatile component; nothing to report.",
    samples: synthesiseFaceRppg({
      bpm: 72,
      durationMs: 35_000,
      acAmplitude: 0,
      noise: 0.2,
      seed: 68,
    }),
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

await mkdir(path.join(goldenRoot, "breathing-audio", "frames"), {
  recursive: true,
});

for (const testCase of audioFrameCases) {
  // Quantize first, then score the quantized signal: the committed PCM is the
  // contract, so the expectation must be what a reader of that file computes,
  // not what the synthesiser's unrounded floats happened to produce.
  const pcm = testCase.samples.map((value) => Math.round(value * 32_767));
  const hops = extractAudioHops(
    pcm.map((value) => value / 32_767),
    0,
  );
  await writeFile(
    path.join(goldenRoot, "breathing-audio", "frames", `${testCase.name}.json`),
    `${JSON.stringify(
      {
        ...header,
        name: testCase.name,
        note: testCase.note,
        sampleRateHz: 16_000,
        // Stored as integers in a 16-bit range, which is what a device
        // actually delivers and keeps the vector a reasonable size.
        pcm,
        expectedHops: hops.map((hop) => [
          hop.timestampMs,
          hop.rms,
          hop.zeroCrossingRate,
          hop.peak,
        ]),
      },
      null,
      2,
    )}\n`,
  );
}

for (const testCase of audioSessionCases) {
  const hops = extractAudioHops(
    testCase.samples.map((value) => Math.round(value * 32_767) / 32_767),
    0,
  );
  const expected = estimateAudioBreathing(hops, MEASURED_AT_MS);
  await writeFile(
    path.join(goldenRoot, "breathing-audio", `${testCase.name}.json`),
    `${JSON.stringify(
      {
        ...header,
        name: testCase.name,
        note: testCase.note,
        measuredAtMs: MEASURED_AT_MS,
        hops: hops.map((hop) => [
          hop.timestampMs,
          hop.rms,
          hop.zeroCrossingRate,
          hop.peak,
        ]),
        expected,
      },
      null,
      2,
    )}\n`,
  );
}

await mkdir(path.join(goldenRoot, "face-rppg"), { recursive: true });

for (const testCase of faceRppgCases) {
  const expected = estimateFaceRppg(testCase.samples, MEASURED_AT_MS);
  await writeFile(
    path.join(goldenRoot, "face-rppg", `${testCase.name}.json`),
    `${JSON.stringify(
      {
        ...header,
        name: testCase.name,
        note: testCase.note,
        measuredAtMs: MEASURED_AT_MS,
        samples: testCase.samples.map((sample) => [
          sample.timestampMs,
          sample.green,
          sample.luma,
          sample.faceArea,
          sample.faceCenterX,
          sample.faceCenterY,
        ]),
        expected,
      },
      null,
      2,
    )}\n`,
  );
}

process.stdout.write("physiology golden vectors written\n");
