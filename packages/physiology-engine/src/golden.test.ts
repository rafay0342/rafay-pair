import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  estimateBreathing,
  phaseAt,
  BOX_PATTERN,
  CALM_PATTERN,
} from "./breathingEngine.js";
import {
  estimateAudioBreathing,
  extractAudioHops,
  isHopUsable,
} from "./audioBreathingEngine.js";
import { estimateCalories } from "./calorieEngine.js";
import { estimateFaceRppg } from "./faceRppgEngine.js";
import {
  FACE_MIN_COVERAGE,
  FACE_MIN_PERIODICITY,
  FACE_MIN_STABILITY,
  FACE_RPPG_ENABLED,
  PULSE_FRESHNESS_MS,
  PULSE_MIN_COVERAGE,
  PULSE_MIN_PERIODICITY,
  PULSE_MIN_STABILITY,
} from "./constants.js";
import { isPulseFresh, pulseAgeMs } from "./freshness.js";
import { estimatePulse } from "./pulseEngine.js";
import type {
  AudioBreathingResult,
  FaceRppgResult,
  FaceRppgSample,
  AudioHopFeature,
  BreathingResult,
  BreathingSample,
  CalorieEstimate,
  CalorieEstimateInput,
  MeasuredPulse,
  PulseResult,
  PulseSample,
  SignalQuality,
} from "./types.js";

const goldenRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../tests/golden",
);

function readJson<T>(...segments: string[]): T {
  return JSON.parse(
    readFileSync(path.join(goldenRoot, ...segments), "utf8"),
  ) as T;
}

interface PulseVector {
  readonly name: string;
  readonly measuredAtMs: number;
  readonly samples: readonly [number, number, number][];
  readonly expected: PulseResult;
}

interface BreathingVector {
  readonly name: string;
  readonly measuredAtMs: number;
  readonly samples: readonly [number, number, number][];
  readonly expected: BreathingResult;
}

function toPulseSamples(
  packed: readonly [number, number, number][],
): PulseSample[] {
  return packed.map(([timestampMs, red, green]) => ({
    timestampMs,
    red,
    green,
  }));
}

function toBreathingSamples(
  packed: readonly [number, number, number][],
): BreathingSample[] {
  return packed.map(([timestampMs, chestOffset, tracked]) => ({
    timestampMs,
    chestOffset,
    tracked: tracked === 1,
  }));
}

const NUMERIC_QUALITY_KEYS = [
  "score",
  "coverage",
  "motion",
  "periodicity",
  "amplitude",
  "stability",
] as const;

function expectQuality(
  actual: { readonly quality: SignalQuality },
  expected: { readonly quality: SignalQuality },
  label: string,
): void {
  expect(actual.quality.band, label).toBe(expected.quality.band);
  for (const key of NUMERIC_QUALITY_KEYS) {
    expect(actual.quality[key], `${label}.${key}`).toBeCloseTo(
      expected.quality[key],
      6,
    );
  }
}

describe("pulse golden vectors", () => {
  const files = readdirSync(path.join(goldenRoot, "pulse")).sort();

  it("covers both outcomes and every rejection reason that can be provoked", () => {
    const outcomes = new Set<string>();
    for (const file of files) {
      const vector = readJson<PulseVector>("pulse", file);
      outcomes.add(
        vector.expected.status === "measured"
          ? "measured"
          : vector.expected.reason,
      );
    }
    expect(outcomes).toContain("measured");
    expect(outcomes).toContain("tooShort");
    expect(outcomes).toContain("fingerNotDetected");
    expect(outcomes).toContain("excessiveMotion");
    expect(outcomes).toContain("noPeriodicity");
  });

  for (const file of files) {
    it(file, () => {
      const vector = readJson<PulseVector>("pulse", file);
      const actual = estimatePulse(
        toPulseSamples(vector.samples),
        vector.measuredAtMs,
      );
      const expected = vector.expected;

      expect(actual.status, vector.name).toBe(expected.status);
      expect(actual.sampleCount, vector.name).toBe(expected.sampleCount);
      expect(actual.durationMs, vector.name).toBeCloseTo(
        expected.durationMs,
        6,
      );
      expectQuality(actual, expected, vector.name);

      if (actual.status === "measured" && expected.status === "measured") {
        expect(actual.bpm, vector.name).toBeCloseTo(expected.bpm, 6);
        expect(actual.confidence, vector.name).toBeCloseTo(
          expected.confidence,
          6,
        );
        expect(actual.confidenceBand, vector.name).toBe(
          expected.confidenceBand,
        );
        expect(actual.effectiveSampleRateHz, vector.name).toBeCloseTo(
          expected.effectiveSampleRateHz,
          6,
        );
        // Provenance is structural: there is no variant that could carry a
        // measured-grade reading.
        expect(actual.source).toBe("phone_camera_ppg");
        expect(actual.kind).toBe("app_estimated");
      }
      if (actual.status === "rejected" && expected.status === "rejected") {
        expect(actual.reason, vector.name).toBe(expected.reason);
      }
    });
  }

  it("recovers the synthesised rate rather than a subharmonic of it", () => {
    // The octave error is the failure mode that would fabricate a plausible
    // number, so the vectors assert the true rate, not merely self-consistency.
    const truths: Record<string, number> = {
      "clean-72bpm.json": 72,
      "clean-58bpm.json": 58,
      "post-exercise-124bpm.json": 124,
      "low-perfusion-88bpm.json": 88,
    };
    for (const [file, truth] of Object.entries(truths)) {
      const vector = readJson<PulseVector>("pulse", file);
      expect(vector.expected.status, file).toBe("measured");
      if (vector.expected.status !== "measured") continue;
      expect(Math.abs(vector.expected.bpm - truth), file).toBeLessThan(2);
    }
  });
});

describe("breathing golden vectors", () => {
  const files = readdirSync(path.join(goldenRoot, "breathing")).sort();

  for (const file of files) {
    it(file, () => {
      const vector = readJson<BreathingVector>("breathing", file);
      const actual = estimateBreathing(
        toBreathingSamples(vector.samples),
        vector.measuredAtMs,
      );
      const expected = vector.expected;

      expect(actual.status, vector.name).toBe(expected.status);
      expect(actual.sampleCount, vector.name).toBe(expected.sampleCount);
      expectQuality(actual, expected, vector.name);

      if (actual.status === "measured" && expected.status === "measured") {
        expect(actual.breathsPerMinute, vector.name).toBeCloseTo(
          expected.breathsPerMinute,
          6,
        );
        expect(actual.confidenceBand, vector.name).toBe(
          expected.confidenceBand,
        );
        expect(actual.source).toBe("phone_camera_motion");
        expect(actual.kind).toBe("app_estimated");
      }
      if (actual.status === "rejected" && expected.status === "rejected") {
        expect(actual.reason, vector.name).toBe(expected.reason);
      }
    });
  }

  it("recovers the synthesised respiratory rate", () => {
    const truths: Record<string, number> = {
      "calm-12-breaths.json": 12,
      "slow-8-breaths.json": 8,
      "elevated-20-breaths.json": 20,
      "fidgeting-but-recoverable.json": 14,
    };
    for (const [file, truth] of Object.entries(truths)) {
      const vector = readJson<BreathingVector>("breathing", file);
      expect(vector.expected.status, file).toBe("measured");
      if (vector.expected.status !== "measured") continue;
      expect(
        Math.abs(vector.expected.breathsPerMinute - truth),
        file,
      ).toBeLessThan(1);
    }
  });
});

describe("calorie golden vectors", () => {
  const { cases } = readJson<{
    cases: {
      name: string;
      input: CalorieEstimateInput;
      expected: CalorieEstimate;
    }[];
  }>("calories", "estimates.json");

  for (const testCase of cases) {
    it(testCase.name, () => {
      const actual = estimateCalories(testCase.input);
      const expected = testCase.expected;
      expect(actual.estimatedKcal).toBeCloseTo(expected.estimatedKcal, 6);
      expect(actual.met).toBeCloseTo(expected.met, 6);
      expect(actual.bodyMassKg).toBeCloseTo(expected.bodyMassKg, 6);
      expect(actual.algorithmVersion).toBe(expected.algorithmVersion);
      expect([...actual.inputsUsed]).toEqual([...expected.inputsUsed]);
      expect(actual.confidenceBand.label).toBe(expected.confidenceBand.label);
      expect(actual.confidenceBand.lowKcal).toBeCloseTo(
        expected.confidenceBand.lowKcal,
        6,
      );
      expect(actual.confidenceBand.highKcal).toBeCloseTo(
        expected.confidenceBand.highKcal,
        6,
      );
    });
  }

  it("never labels an estimate as narrow, and always brackets it", () => {
    for (const testCase of cases) {
      const estimate = estimateCalories(testCase.input);
      expect(["moderate", "wide", "veryWide"]).toContain(
        estimate.confidenceBand.label,
      );
      expect(estimate.confidenceBand.lowKcal).toBeLessThanOrEqual(
        estimate.estimatedKcal,
      );
      expect(estimate.confidenceBand.highKcal).toBeGreaterThanOrEqual(
        estimate.estimatedKcal,
      );
    }
  });

  it("widens the band when body mass was not supplied", () => {
    const withMass = estimateCalories({
      activity: "squat",
      durationMs: 300_000,
      repetitions: 60,
      bodyMassKg: 74,
    });
    const withoutMass = estimateCalories({
      activity: "squat",
      durationMs: 300_000,
      repetitions: 60,
    });
    const spread = (estimate: CalorieEstimate): number =>
      (estimate.confidenceBand.highKcal - estimate.confidenceBand.lowKcal) /
      estimate.estimatedKcal;
    expect(spread(withoutMass)).toBeGreaterThan(spread(withMass));
    expect(withoutMass.inputsUsed).not.toContain("bodyMass");
  });
});

describe("guided breathing schedule", () => {
  it("walks a calm pattern through its phases", () => {
    const pattern = CALM_PATTERN(3);
    // Calm has no hold phases, so they must be skipped rather than reported.
    expect(phaseAt(pattern, 0).phase).toBe("inhale");
    expect(phaseAt(pattern, 3_999).phase).toBe("inhale");
    expect(phaseAt(pattern, 4_000).phase).toBe("exhale");
    expect(phaseAt(pattern, 9_999).phase).toBe("exhale");
    expect(phaseAt(pattern, 10_000)).toMatchObject({
      phase: "inhale",
      cycleIndex: 1,
    });
    expect(phaseAt(pattern, 30_000).phase).toBe("complete");
  });

  it("reports every phase of a box pattern with progress", () => {
    const pattern = BOX_PATTERN(1);
    expect(phaseAt(pattern, 2_000)).toMatchObject({
      phase: "inhale",
      progress: 0.5,
    });
    expect(phaseAt(pattern, 6_000).phase).toBe("hold");
    expect(phaseAt(pattern, 10_000).phase).toBe("exhale");
    expect(phaseAt(pattern, 14_000).phase).toBe("holdAfter");
    expect(phaseAt(pattern, 16_000).phase).toBe("complete");
  });

  it("produces the same schedule on every device", () => {
    // Two partners breathe together because the schedule is a pure function of
    // elapsed time, not of either device's state.
    const pattern = BOX_PATTERN(4);
    for (let elapsed = 0; elapsed <= 16_000; elapsed += 137) {
      expect(phaseAt(pattern, elapsed)).toEqual(phaseAt(pattern, elapsed));
    }
  });
});

describe("pulse freshness", () => {
  const measured: MeasuredPulse = {
    status: "measured",
    bpm: 72,
    durationMs: 20_000,
    sampleCount: 600,
    effectiveSampleRateHz: 30,
    quality: {
      score: 0.9,
      band: "good",
      coverage: 1,
      motion: 0.05,
      periodicity: 0.95,
      amplitude: 0.02,
      stability: 0.9,
    },
    confidence: 0.9,
    confidenceBand: "high",
    source: "phone_camera_ppg",
    kind: "app_estimated",
    measuredAtMs: 1_000_000,
  };

  it("expires exactly at the freshness window", () => {
    expect(isPulseFresh(measured, 1_000_000)).toBe(true);
    expect(isPulseFresh(measured, 1_000_000 + PULSE_FRESHNESS_MS - 1)).toBe(
      true,
    );
    // Master specification §4: an expired reading must stop being presented as
    // current, everywhere — including to a partner.
    expect(isPulseFresh(measured, 1_000_000 + PULSE_FRESHNESS_MS)).toBe(false);
  });

  it("never reports a negative age from a clock that stepped backwards", () => {
    expect(pulseAgeMs(measured, 999_000)).toBe(0);
  });
});

interface AudioFrameVector {
  readonly name: string;
  readonly sampleRateHz: number;
  readonly pcm: readonly number[];
  readonly expectedHops: readonly [number, number, number, number][];
}

interface AudioSessionVector {
  readonly name: string;
  readonly measuredAtMs: number;
  readonly hops: readonly [number, number, number, number][];
  readonly expected: AudioBreathingResult;
}

function toHops(
  packed: readonly [number, number, number, number][],
): AudioHopFeature[] {
  return packed.map(([timestampMs, rms, zeroCrossingRate, peak]) => ({
    timestampMs,
    rms,
    zeroCrossingRate,
    peak,
  }));
}

describe("microphone feature extraction", () => {
  const files = readdirSync(
    path.join(goldenRoot, "breathing-audio", "frames"),
  ).sort();

  for (const file of files) {
    it(file, () => {
      const vector = readJson<AudioFrameVector>(
        "breathing-audio",
        "frames",
        file,
      );
      // The vector stores PCM as 16-bit integers, which is what a device
      // actually delivers; the extractor takes floats in [-1, 1].
      const samples = vector.pcm.map((value) => value / 32_767);
      const hops = extractAudioHops(samples, 0);

      expect(hops).toHaveLength(vector.expectedHops.length);
      hops.forEach((hop, index) => {
        const [timestampMs, rms, zeroCrossingRate, peak] = vector.expectedHops[
          index
        ] as [number, number, number, number];
        expect(
          hop.timestampMs,
          `${vector.name}[${String(index)}].t`,
        ).toBeCloseTo(timestampMs, 6);
        expect(hop.rms, `${vector.name}[${String(index)}].rms`).toBeCloseTo(
          rms,
          6,
        );
        expect(
          hop.zeroCrossingRate,
          `${vector.name}[${String(index)}].zcr`,
        ).toBeCloseTo(zeroCrossingRate, 6);
        expect(hop.peak, `${vector.name}[${String(index)}].peak`).toBeCloseTo(
          peak,
          6,
        );
      });
    });
  }

  it("rejects every hop of a clipped recording", () => {
    const vector = readJson<AudioFrameVector>(
      "breathing-audio",
      "frames",
      "clipped-input.json",
    );
    const hops = toHops(vector.expectedHops);
    expect(hops.length).toBeGreaterThan(0);
    expect(hops.every((hop) => !isHopUsable(hop))).toBe(true);
  });
});

describe("microphone breathing vectors", () => {
  const files = readdirSync(path.join(goldenRoot, "breathing-audio"))
    .filter((entry) => entry.endsWith(".json"))
    .sort();

  for (const file of files) {
    it(file, () => {
      const vector = readJson<AudioSessionVector>("breathing-audio", file);
      const actual = estimateAudioBreathing(
        toHops(vector.hops),
        vector.measuredAtMs,
      );
      const expected = vector.expected;

      expect(actual.status, vector.name).toBe(expected.status);
      expect(actual.hopCount, vector.name).toBe(expected.hopCount);
      expectQuality(actual, expected, vector.name);

      if (actual.status === "measured" && expected.status === "measured") {
        expect(actual.breathsPerMinute, vector.name).toBeCloseTo(
          expected.breathsPerMinute,
          6,
        );
        expect(actual.confidenceBand, vector.name).toBe(
          expected.confidenceBand,
        );
        expect(actual.source).toBe("phone_microphone");
        expect(actual.kind).toBe("app_estimated");
      }
      if (actual.status === "rejected" && expected.status === "rejected") {
        expect(actual.reason, vector.name).toBe(expected.reason);
      }
    });
  }

  it("recovers the synthesised rate despite two energy bursts per cycle", () => {
    // Breath sound is loud on the inhale and again on the exhale, so a naive
    // peak search reports double. This is the assertion that catches it.
    const truths: Record<string, number> = {
      "calm-11-breaths.json": 11,
      "elevated-18-breaths.json": 18,
    };
    for (const [file, truth] of Object.entries(truths)) {
      const vector = readJson<AudioSessionVector>("breathing-audio", file);
      expect(vector.expected.status, file).toBe("measured");
      if (vector.expected.status !== "measured") continue;
      expect(
        Math.abs(vector.expected.breathsPerMinute - truth),
        file,
      ).toBeLessThan(1);
    }
  });

  it("carries no audio in the type the engine consumes", () => {
    const vector = readJson<AudioSessionVector>(
      "breathing-audio",
      "calm-11-breaths.json",
    );
    // Each hop is exactly four numbers. If audio were ever threaded through
    // this boundary, the vector shape would have to change and this fails.
    for (const hop of vector.hops) {
      expect(hop).toHaveLength(4);
      for (const value of hop) expect(typeof value).toBe("number");
    }
  });
});

interface FaceRppgVector {
  readonly name: string;
  readonly measuredAtMs: number;
  readonly samples: readonly [number, number, number, number, number, number][];
  readonly expected: FaceRppgResult;
}

function toFaceSamples(
  packed: readonly [number, number, number, number, number, number][],
): FaceRppgSample[] {
  return packed.map(
    ([timestampMs, green, luma, faceArea, faceCenterX, faceCenterY]) => ({
      timestampMs,
      green,
      luma,
      faceArea,
      faceCenterX,
      faceCenterY,
    }),
  );
}

describe("face rPPG research mode", () => {
  const files = readdirSync(path.join(goldenRoot, "face-rppg")).sort();

  it("ships disabled, as the specification requires", () => {
    // Master specification §3.3: experimental only. The engine exists and is
    // tested, but nothing turns it on by default.
    expect(FACE_RPPG_ENABLED).toBe(false);
  });

  for (const file of files) {
    it(file, () => {
      const vector = readJson<FaceRppgVector>("face-rppg", file);
      const actual = estimateFaceRppg(
        toFaceSamples(vector.samples),
        vector.measuredAtMs,
      );
      const expected = vector.expected;

      expect(actual.status, vector.name).toBe(expected.status);
      expect(actual.sampleCount, vector.name).toBe(expected.sampleCount);
      expect(actual.lumaSwing, vector.name).toBeCloseTo(expected.lumaSwing, 6);
      expectQuality(actual, expected, vector.name);

      if (actual.status === "measured" && expected.status === "measured") {
        expect(actual.bpm, vector.name).toBeCloseTo(expected.bpm, 6);
        expect(actual.confidenceBand, vector.name).toBe(expected.confidenceBand);
        expect(actual.source).toBe("face_camera_rppg");
        expect(actual.kind).toBe("app_estimated");
        // The caveat is a literal on the type, so no consumer can strip it.
        expect(actual.experimental).toBe(true);
      }
      if (actual.status === "rejected" && expected.status === "rejected") {
        expect(actual.reason, vector.name).toBe(expected.reason);
      }
    });
  }

  it("recovers the synthesised rate when conditions allow", () => {
    const truths: Record<string, number> = {
      "well-lit-70bpm.json": 70,
      "well-lit-96bpm.json": 96,
      "slight-head-drift.json": 72,
    };
    for (const [file, truth] of Object.entries(truths)) {
      const vector = readJson<FaceRppgVector>("face-rppg", file);
      expect(vector.expected.status, file).toBe("measured");
      if (vector.expected.status !== "measured") continue;
      expect(Math.abs(vector.expected.bpm - truth), file).toBeLessThan(2);
    }
  });

  it("refuses a session whose light was changing", () => {
    // Slow illumination drift is exactly what rPPG mistakes for a pulse, and it
    // is the failure the fingertip path avoids entirely by lighting the finger.
    const vector = readJson<FaceRppgVector>("face-rppg", "changing-light.json");
    expect(vector.expected.status).toBe("rejected");
    if (vector.expected.status !== "rejected") return;
    expect(vector.expected.reason).toBe("unstableLighting");
    // The signal itself looked periodic; only the lighting gate caught it.
    expect(vector.expected.quality.periodicity).toBeGreaterThan(0.6);
  });

  it("holds itself to a stricter bar than the fingertip estimator", () => {
    // A weaker signal earns less benefit of the doubt, not more.
    expect(FACE_MIN_PERIODICITY).toBeGreaterThan(PULSE_MIN_PERIODICITY);
    expect(FACE_MIN_STABILITY).toBeGreaterThan(PULSE_MIN_STABILITY);
    expect(FACE_MIN_COVERAGE).toBeLessThan(PULSE_MIN_COVERAGE);
  });
});
