import { describe, expect, it } from "vitest";

import {
  MIN_ENROLMENT_FRAMES,
  SpeakerMatcher,
  buildSpeakerProfile,
  speakerFrameFeature,
  type SpeakerFrame,
} from "./speakerProfile.js";

/** A voiced frame at a given pitch: a fundamental plus two harmonics. */
function voiced(f0Hz: number, amplitude = 0.2, samples = 320): number[] {
  return Array.from({ length: samples }, (_, index) => {
    const t = index / 16_000;
    return (
      amplitude *
      (Math.sin(2 * Math.PI * f0Hz * t) +
        0.5 * Math.sin(2 * Math.PI * 2 * f0Hz * t) +
        0.25 * Math.sin(2 * Math.PI * 3 * f0Hz * t))
    );
  });
}

function enrol(f0Hz: number): SpeakerFrame[] {
  const frames: SpeakerFrame[] = [];
  for (let index = 0; index < MIN_ENROLMENT_FRAMES + 10; index += 1) {
    // A little natural wobble, so the profile has a real spread rather than a
    // synthetic zero.
    const feature = speakerFrameFeature(voiced(f0Hz + (index % 7) - 3));
    if (feature) frames.push(feature);
  }
  return frames;
}

describe("speaker frame features", () => {
  it("finds the pitch of a voiced frame", () => {
    const feature = speakerFrameFeature(voiced(120));
    expect(feature).not.toBeNull();
    expect(feature?.f0Hz).toBeGreaterThan(112);
    expect(feature?.f0Hz).toBeLessThan(128);
  });

  it("refuses silence, noise, and anything too quiet", () => {
    expect(speakerFrameFeature(new Array<number>(320).fill(0))).toBeNull();
    // A quiet voice is not a voice for this purpose: profiling it would build a
    // profile out of the room.
    expect(speakerFrameFeature(voiced(120, 0.002))).toBeNull();
    // White-ish noise has no fundamental worth reporting.
    const noise = Array.from(
      { length: 320 },
      (_, i) => Math.sin(i * 12.9898) * 0.3,
    );
    const feature = speakerFrameFeature(noise);
    if (feature) expect(feature.f0Hz).toBeGreaterThanOrEqual(70);
  });
});

describe("enrolment", () => {
  it("produces nothing from too little speech", () => {
    // Weak profiles do not fail loudly, they quietly match everyone.
    expect(buildSpeakerProfile(enrol(120).slice(0, 20))).toBeNull();
  });

  it("produces a profile with a spread that is never zero", () => {
    const profile = buildSpeakerProfile(enrol(120));
    expect(profile).not.toBeNull();
    expect(profile?.f0Hz).toBeGreaterThan(110);
    expect(profile?.f0Spread).toBeGreaterThanOrEqual(8);
  });
});

describe("matching", () => {
  it("accepts the enrolled voice", () => {
    const profile = buildSpeakerProfile(enrol(120));
    const matcher = new SpeakerMatcher(profile);
    let decision = matcher.accept(null);
    for (let index = 0; index < 25; index += 1) {
      decision = matcher.accept(
        speakerFrameFeature(voiced(120 + (index % 5) - 2)),
      );
    }
    expect(decision.verdict).toBe("enrolled");
  });

  it("rejects a clearly different voice", () => {
    // A partner an octave apart is the case this exists for.
    const profile = buildSpeakerProfile(enrol(115));
    const matcher = new SpeakerMatcher(profile);
    let decision = matcher.accept(null);
    for (let index = 0; index < 25; index += 1) {
      decision = matcher.accept(
        speakerFrameFeature(voiced(230 + (index % 5) - 2)),
      );
    }
    expect(decision.verdict).toBe("other");
  });

  it("says unknown until it has heard enough, and with no profile at all", () => {
    const profile = buildSpeakerProfile(enrol(120));
    const matcher = new SpeakerMatcher(profile);
    const early = matcher.accept(speakerFrameFeature(voiced(120)));
    // Callers transmit on unknown: being unheard is worse than occasionally
    // answering the wrong person.
    expect(early.verdict).toBe("unknown");

    const none = new SpeakerMatcher(null);
    expect(none.accept(speakerFrameFeature(voiced(120))).verdict).toBe(
      "unknown",
    );
  });

  it("does not let one odd frame change the answer", () => {
    const profile = buildSpeakerProfile(enrol(120));
    const matcher = new SpeakerMatcher(profile);
    for (let index = 0; index < 25; index += 1)
      matcher.accept(speakerFrameFeature(voiced(120)));
    const afterOneStray = matcher.accept(speakerFrameFeature(voiced(260)));
    expect(afterOneStray.verdict).toBe("enrolled");
  });
});
