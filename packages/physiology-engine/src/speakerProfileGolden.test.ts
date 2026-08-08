import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  SpeakerMatcher,
  buildSpeakerProfile,
  speakerFrameFeature,
  type SpeakerFrame,
} from "./speakerProfile.js";

interface Case {
  readonly name: string;
  readonly note: string;
  readonly enrolF0: number;
  readonly speakF0: number;
  readonly frames: number;
  readonly expected: string;
}

const vectors = JSON.parse(
  readFileSync(
    new URL(
      "../../../tests/golden/speaker-profile/vectors.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  readonly amplitude: number;
  readonly samplesPerFrame: number;
  readonly wobbleHz: number;
  readonly enrolFrames: number;
  readonly cases: readonly Case[];
};

/** The test signal, exactly as `engines/speaker-profile/SPEC.md` defines it. */
function frame(f0Hz: number): number[] {
  return Array.from({ length: vectors.samplesPerFrame }, (_, index) => {
    const t = index / 16_000;
    return (
      vectors.amplitude *
      (Math.sin(2 * Math.PI * f0Hz * t) +
        0.5 * Math.sin(2 * Math.PI * 2 * f0Hz * t) +
        0.25 * Math.sin(2 * Math.PI * 3 * f0Hz * t))
    );
  });
}

function wobble(base: number, index: number): number {
  return base + ((index % (vectors.wobbleHz * 2 + 1)) - vectors.wobbleHz);
}

describe("speaker profile golden vectors", () => {
  // Consumed unchanged by the Swift and Kotlin ports. Three implementations
  // reaching the same verdict on the same synthesised audio is what parity
  // means here.
  it.each(vectors.cases.map((entry) => [entry.name, entry] as const))(
    "%s",
    (_name, entry) => {
      const enrolment: SpeakerFrame[] = [];
      for (let index = 0; index < vectors.enrolFrames; index += 1) {
        const feature = speakerFrameFeature(
          frame(wobble(entry.enrolF0, index)),
        );
        if (feature) enrolment.push(feature);
      }
      const profile = buildSpeakerProfile(enrolment);
      expect(profile, entry.note).not.toBeNull();

      const matcher = new SpeakerMatcher(profile);
      let verdict = "unknown";
      for (let index = 0; index < entry.frames; index += 1) {
        verdict = matcher.accept(
          speakerFrameFeature(frame(wobble(entry.speakF0, index))),
        ).verdict;
      }
      expect(verdict, entry.note).toBe(entry.expected);
    },
  );
});
